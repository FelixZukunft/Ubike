// Minimal SVG charts in the Apple Charts idiom: thin marks, recessive grid,
// rounded bar ends, crosshair + tooltip on hover/touch. No dependencies.

const NS = 'http://www.w3.org/2000/svg';
let tipEl;
function tip() {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'chart-tip'; document.body.appendChild(tipEl); }
  return tipEl;
}
export function showTip(x, y, html) {
  const t = tip(); t.innerHTML = html; t.classList.add('on');
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 14, top = y - h - 10;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top < 8) top = y + 14;
  t.style.left = left + 'px'; t.style.top = top + 'px';
}
export function hideTip() { tip().classList.remove('on'); }

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
const color = (c) => (c && c.startsWith('--') ? css(c) : c);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
/** Round axis: returns {lo, hi, step} with a 1/2/2.5/5×10^n step and ~targetTicks intervals. */
function niceAxis(lo, hi, targetTicks = 4) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / targetTicks;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}
const fmtNum =(v) => (v == null ? '–' : Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : (+v.toFixed(2)).toString());
const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function mount(container, render) {
  container.classList.add('chart');
  const draw = () => { container.innerHTML = ''; if (container.clientWidth > 0) render(container.clientWidth); container.dispatchEvent(new Event('chartdraw')); };
  draw();
  container._w = container.clientWidth; // the observer's first callback must not redraw (it would reset scroll positions)
  if (container._ro) container._ro.disconnect();
  container._ro = new ResizeObserver(() => { if (container._w !== container.clientWidth) { container._w = container.clientWidth; draw(); } });
  container._ro.observe(container);
  // theme changes
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', draw);
}

/**
 * Line / area chart.
 * series: [{name, color:'--s1', points:[{x:Date|number, y:number}], area:bool}]
 */
export function lineChart(container, { series, height = 180, yFmt = fmtNum, xFmt = fmtTime, yMax, yMin = 0, legend = series.length > 1, xTicks = 5, unit = '', markers = [], gapMs = 0, xMin, xMax, width, yLabels = true, onAxis, tickEveryMs } = {}) {
  mount(container, (W0) => {
    const W = width || W0;
    const pad = { l: yLabels ? 36 : 4, r: 10, t: 10, b: 22 };
    const H = height;
    const all = series.flatMap((s) => s.points);
    if (!all.length) { container.innerHTML = '<div class="chart-empty">No data yet</div>'; return; }
    const xs = all.map((p) => +p.x);
    const x0 = xMin != null ? +xMin : Math.min(...xs), x1 = xMax != null ? +xMax : (Math.max(...xs) || x0 + 1);
    const ax = niceAxis(yMin, yMax ?? Math.max(...all.map((p) => p.y ?? 0)));
    yMin = ax.lo; const ymax = yMax ?? ax.hi;
    const sx = (x) => pad.l + ((+x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const sy = (y) => pad.t + (1 - (y - yMin) / (ymax - yMin || 1)) * (H - pad.t - pad.b);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' }, container);
    const g = el('g', { class: 'grid' }, svg);
    const yTicks = [];
    for (let v = yMin; v <= ymax + ax.step / 2; v += ax.step) {
      const y = sy(v);
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }, g);
      yTicks.push({ y, label: yFmt(v) });
      if (yLabels) { const t = el('text', { x: pad.l - 6, y: y + 3.5, 'text-anchor': 'end' }, svg); t.textContent = yFmt(v); }
    }
    onAxis?.(yTicks);
    if (tickEveryMs) { // ticks on full hours (Taipei is a whole-hour UTC offset), for wide scrollable charts
      for (let xv = Math.ceil(x0 / tickEveryMs) * tickEveryMs; xv <= x1; xv += tickEveryMs) {
        const x = sx(xv);
        if (x < pad.l + 14 || x > W - pad.r - 14) continue;
        el('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b, stroke: color('--grid') }, svg);
        const t = el('text', { x, y: H - 5, 'text-anchor': 'middle' }, svg); t.textContent = xFmt(new Date(xv));
      }
    }
    const n = tickEveryMs ? 0 : Math.max(2, Math.min(xTicks, Math.floor((W - 60) / 70)));
    for (let i = 0; i < n; i++) {
      const xv = x0 + ((x1 - x0) * i) / (n - 1);
      const t = el('text', { x: sx(xv), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, svg);
      t.textContent = xFmt(new Date(xv));
    }
    for (const m of markers) {
      const x = sx(m.x);
      el('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b, stroke: color(m.color || '--label-3'), 'stroke-dasharray': '3 3' }, svg);
    }
    for (const s of series) {
      const pts = s.points.filter((p) => p.y != null);
      if (!pts.length) continue;
      const c = color(s.color || '--s1');
      const d = pts.map((p, i) => `${i && !(gapMs && +p.x - +pts[i - 1].x > gapMs) ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
      if (pts.length === 1 || gapMs) for (const q of pts) el('circle', { cx: sx(q.x), cy: sy(q.y), r: pts.length === 1 ? 3.5 : 1.6, fill: c }, svg);
      if (s.area) {
        const id = 'g' + Math.random().toString(36).slice(2);
        const grad = el('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, el('defs', {}, svg));
        el('stop', { offset: '0%', 'stop-color': c, 'stop-opacity': 0.28 }, grad);
        el('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': 0 }, grad);
        el('path', { d: `${d}L${sx(pts.at(-1).x)},${sy(yMin)}L${sx(pts[0].x)},${sy(yMin)}Z`, fill: `url(#${id})` }, svg);
      }
      el('path', { d, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      if (series.length > 1 && series.length <= 4) { // direct label at line end
        const last = pts.at(-1);
        const t = el('text', { x: Math.min(sx(last.x), W - pad.r) - 2, y: sy(last.y) - 7, 'text-anchor': 'end', style: 'font-weight:600' }, svg);
        t.textContent = s.name;
      }
    }
    // hover layer
    const cross = el('line', { y1: pad.t, y2: H - pad.b, stroke: color('--label-3'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    const dots = series.map((s) => el('circle', { r: 4.5, fill: color(s.color || '--s1'), stroke: color('--chart-surface'), 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' }, svg);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      const xv = x0 + ((cx - r.left - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
      let rows = '', best;
      series.forEach((s, i) => {
        const pts = s.points.filter((p) => p.y != null);
        if (!pts.length) return;
        const p = pts.reduce((a, b) => (Math.abs(+b.x - xv) < Math.abs(+a.x - xv) ? b : a));
        best = best || p;
        dots[i].setAttribute('cx', sx(p.x)); dots[i].setAttribute('cy', sy(p.y)); dots[i].setAttribute('visibility', 'visible');
        rows += `<div class="row"><span><i style="background:${color(s.color || '--s1')}"></i> ${s.name}</span><b>${yFmt(p.y)}${unit}</b></div>`;
      });
      if (!best) return;
      cross.setAttribute('x1', sx(best.x)); cross.setAttribute('x2', sx(best.x)); cross.setAttribute('visibility', 'visible');
      showTip(cx, ev.touches ? ev.touches[0].clientY : ev.clientY, `<div class="tt">${xFmt(new Date(+best.x))}</div>${rows}`);
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip(); };
    hit.addEventListener('mousemove', move); hit.addEventListener('touchmove', move, { passive: true }); hit.addEventListener('touchstart', move, { passive: true });
    hit.addEventListener('mouseleave', leave); hit.addEventListener('touchend', leave);
  });
  if (legend) {
    const lg = document.createElement('div'); lg.className = 'legend';
    lg.innerHTML = series.map((s) => `<span><i style="background:${color(s.color || '--s1')}"></i>${s.name}</span>`).join('');
    container.after(lg);
  }
}

/** Vertical bars. data: [{label, value, color?, tip?}] */
export function barChart(container, { data, height = 160, yFmt = fmtNum, color: c = '--s1', unit = '', yMax, labelEvery = 1 } = {}) {
  mount(container, (W) => {
    const pad = { l: 34, r: 6, t: 8, b: 20 };
    const H = height;
    if (!data.length) { container.innerHTML = '<div class="chart-empty">No data yet</div>'; return; }
    const ax = niceAxis(0, yMax ?? Math.max(...data.map((d) => d.value || 0)), 3);
    const ymax = ax.hi;
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, container);
    const iw = W - pad.l - pad.r, bw = iw / data.length, gap = Math.min(4, bw * 0.25);
    const sy = (v) => pad.t + (1 - v / ymax) * (H - pad.t - pad.b);
    for (let v = 0; v <= ymax + ax.step / 2; v += ax.step) {
      const y = sy(v);
      el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: color('--grid') }, svg);
      const t = el('text', { x: pad.l - 6, y: y + 3.5, 'text-anchor': 'end' }, svg); t.textContent = yFmt(v);
    }
    data.forEach((d, i) => {
      const x = pad.l + i * bw + gap / 2, w = Math.max(1, bw - gap);
      const v = d.value || 0, y = sy(v), h = H - pad.b - y;
      const r = Math.min(4, w / 2, h);
      const fill = color(d.color || c);
      const path = h > 0 ? `M${x},${H - pad.b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H - pad.b}Z` : '';
      const bar = el('path', { d: path, fill }, svg);
      const hit = el('rect', { x: pad.l + i * bw, y: pad.t, width: bw, height: H - pad.t - pad.b, fill: 'transparent' }, svg);
      const on = (ev) => {
        bar.setAttribute('opacity', 0.75);
        const p = ev.touches ? ev.touches[0] : ev;
        showTip(p.clientX, p.clientY, d.tip || `<div class="tt">${d.label}</div><div class="row"><span>Value</span><b>${yFmt(v)}${unit}</b></div>`);
      };
      hit.addEventListener('mousemove', on); hit.addEventListener('touchstart', on, { passive: true });
      hit.addEventListener('mouseleave', () => { bar.setAttribute('opacity', 1); hideTip(); });
      hit.addEventListener('touchend', () => { bar.setAttribute('opacity', 1); hideTip(); });
      if (i % labelEvery === 0) {
        const t = el('text', { x: x + w / 2, y: H - 5, 'text-anchor': 'middle' }, svg); t.textContent = d.label;
      }
    });
  });
}

/** Sequential color from the blue ramp for p in [0,1]. */
export function seqColor(p) {
  if (p == null) return null;
  const i = Math.max(0, Math.min(5, Math.round(p * 5)));
  return css(`--seq-${i}`);
}

/**
 * 7×24 heatmap. grid[wd][h] = {p, n, mean} | null. Rows Mon..Sun, cols 0..23.
 */
export function heatmap(container, { grid, label = 'chance', kind = 'bike', compact = false }) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  mount(container, (W) => {
    const padL = 30, padT = compact ? 2 : 16, cell = (W - padL) / 24, ch = Math.min(cell, compact ? 14 : 22);
    const H = padT + ch * 7 + 2;
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, container);
    if (!compact) for (const h of [0, 6, 12, 18, 23]) {
      const t = el('text', { x: padL + h * cell + cell / 2, y: 11, 'text-anchor': 'middle' }, svg); t.textContent = String(h).padStart(2, '0');
    }
    days.forEach((d, wd) => {
      const t = el('text', { x: padL - 6, y: padT + wd * ch + ch / 2 + 3.5, 'text-anchor': 'end' }, svg); t.textContent = d;
      for (let h = 0; h < 24; h++) {
        const v = grid?.[wd]?.[h];
        const x = padL + h * cell + 1, y = padT + wd * ch + 1;
        const r = el('rect', { x, y, width: Math.max(1, cell - 2), height: Math.max(1, ch - 2), rx: 3,
          fill: v ? seqColor(v.p) : 'transparent', stroke: v ? 'none' : color('--sep'), 'stroke-dasharray': v ? '' : '2 2' }, svg);
        const on = (ev) => {
          const p = ev.touches ? ev.touches[0] : ev;
          showTip(p.clientX, p.clientY, v
            ? `<div class="tt">${d} ${String(h).padStart(2, '0')}:00</div><div class="row"><span>P(≥1 ${kind})</span><b>${Math.round(v.p * 100)}%</b></div><div class="row"><span>Avg ${kind}s</span><b>${v.mean}</b></div><div class="row"><span>Samples</span><b>${v.n}</b></div>`
            : `<div class="tt">${d} ${String(h).padStart(2, '0')}:00</div>No data yet`);
          r.setAttribute('stroke', color('--label')); r.setAttribute('stroke-width', 1.5);
        };
        const off = () => { r.setAttribute('stroke', v ? 'none' : color('--sep')); r.setAttribute('stroke-width', 1); hideTip(); };
        r.addEventListener('mousemove', on); r.addEventListener('touchstart', on, { passive: true });
        r.addEventListener('mouseleave', off); r.addEventListener('touchend', off);
      }
    });
  });
}

export function heatLegend(kind = 'bike') {
  const stops = [0, 1, 2, 3, 4, 5].map((i) => `<i style="background:var(--seq-${i})"></i>`).join('');
  return `<div class="legend heat-legend"><span>0%</span><span class="ramp">${stops}</span><span>100% chance of ≥1 ${kind}</span><span><i style="border:1px dashed var(--sep)"></i>no data yet</span></div>`;
}
