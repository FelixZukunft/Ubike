// 36-hour availability forecast, computed on the phone.
//
// Each station is a probability distribution over 0..capacity bikes. Every 30 min:
//   departures ~ Poisson(dep[s, daytype, hour] × rain × Δt)   (can't go below 0 → lost demand)
//   arrivals   ~ Poisson(arr[s, daytype, hour] × rain × Δt)   (can't exceed capacity → full)
//   + weak pull toward ~40 % fill standing in for rebalancing trucks
// dep/arr per station × workday/day-off × hour and the rain factors are fitted from
// Taipei trip records by ubike/forecast.py → /app/model.json.

const METEO = 'https://api.open-meteo.com/v1/forecast';
const METEO_FALLBACK = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
export const STEP_H = 0.5, HOURS = 36, STEPS = HOURS / STEP_H;
export const LOW = 6; // we keep P(≤ k bikes / free docks) for k = 0..5 ("almost empty/full" risk)

/** Risk at step i that you find ≤ k bikes (mode 'bike') or ≤ k free docks (mode 'dock'). */
export function riskOf(f, i, mode, k) {
  return (mode === 'bike' ? f.lowB : f.lowD)[i * LOW + Math.min(LOW - 1, k)];
}

let MODEL = null;
export async function loadModel() {
  if (!MODEL) MODEL = await (await fetch('/app/model.json')).json();
  return MODEL;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hourKey = (d) => `${ymd(d)}T${pad(d.getHours())}`;

function isOff(d) {
  const k = ymd(d);
  if (MODEL.makeup_workdays?.includes(k)) return false;
  if (MODEL.off_days?.includes(k)) return true;
  return d.getDay() === 0 || d.getDay() === 6;
}
function rainFactor(mm) {
  const b = MODEL.rain_bands_mm, f = MODEL.rain_factor;
  if (mm == null || mm < b[0]) return f[0];
  if (mm < b[1]) return f[1];
  if (mm < b[2]) return f[2];
  return f[3];
}

async function fetchT(url, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
/** Hourly precipitation forecast {'YYYY-MM-DDTHH': mm} for the next ~3 days (cached 30 min). */
export async function rainForecast(lat = 25.033, lng = 121.54) {
  try {
    const c = JSON.parse(localStorage.getItem('u:rain36') || 'null');
    if (c && Date.now() - c.at < 30 * 60e3) return c.rain;
  } catch {}
  const r2 = (v) => (Math.round(v * 50) / 50).toFixed(2); // ~2 km grid: enough for weather, no exact position leaves the phone
  const q = `latitude=${r2(lat)}&longitude=${r2(lng)}&timezone=Asia%2FTaipei&hourly=precipitation,precipitation_probability`;
  let d;
  try { d = await fetchT(`${METEO}?${q}&forecast_days=3`, 5000); }
  catch {
    const s = new Date(), e = new Date(Date.now() + 3 * 864e5);
    try { d = await fetchT(`${METEO_FALLBACK}?${q}&start_date=${ymd(s)}&end_date=${ymd(e)}`, 7000); } catch { return {}; }
  }
  const rain = {};
  (d.hourly?.time || []).forEach((t, i) => { rain[t.slice(0, 13)] = { mm: d.hourly.precipitation[i], prob: d.hourly.precipitation_probability?.[i] }; });
  try { localStorage.setItem('u:rain36', JSON.stringify({ at: Date.now(), rain })); } catch {}
  return rain;
}

/** Time grid: STEPS+1 points starting at the current half hour. */
export function timeGrid(start = new Date()) {
  const t0 = new Date(start); t0.setSeconds(0, 0); t0.setMinutes(t0.getMinutes() < 30 ? 0 : 30); // half-hour grid; point 0 = "now"
  return Array.from({ length: STEPS + 1 }, (_, i) => new Date(+t0 + i * STEP_H * 3600e3));
}

// Poisson step on a bounded distribution. dir = -1 departures, +1 arrivals.
function step(p, rate, dir, C, out) {
  out.fill(0);
  if (rate <= 1e-6) { out.set(p); return; }
  const kmax = Math.ceil(rate + 6 * Math.sqrt(rate) + 3);
  const e = Math.exp(-rate);
  for (let n = 0; n <= C; n++) {
    const pn = p[n];
    if (pn < 1e-9) continue;
    const room = dir < 0 ? n : C - n;          // how many can actually happen
    let pk = e, cum = 0;
    const K = Math.min(room, kmax);
    for (let k = 0; k < K; k++) {
      out[n + dir * k] += pn * pk;
      cum += pk;
      pk *= rate / (k + 1);
    }
    out[n + dir * K] += pn * Math.max(0, 1 - cum); // tail: hits the boundary (or negligible beyond kmax)
  }
}

/**
 * stations: [{sno, bikes, docks, ...}]; rain: from rainForecast(); times: timeGrid().
 * Returns Map sno → {pBike: Float32Array, pDock: Float32Array, mean: Float32Array, cap}.
 * Runs in chunks so the UI stays responsive; onProgress(fraction).
 */
export async function runForecast(stations, rain, times, onProgress) {
  const out = new Map();
  const ctx = times.slice(0, -1).map((t) => {
    const mid = new Date(+t + STEP_H * 1800e3);
    return { off: isOff(mid) ? 1 : 0, h: mid.getHours(), rf: rainFactor(rain[hourKey(mid)]?.mm) };
  });
  const rev = MODEL.revert, r = 1 - Math.exp(-rev.rate_per_h * STEP_H);
  let done = 0;
  for (const s of stations) {
    const prof = MODEL.stations[s.sno];
    const C = (s.bikes || 0) + (s.docks || 0);
    if (prof && C > 0) {
      let p = new Float64Array(C + 1), q = new Float64Array(C + 1);
      p[Math.min(C, s.bikes)] = 1;
      const T = times.length;
      const pB = new Float32Array(T), pD = new Float32Array(T), mean = new Float32Array(T);
      // lowB[i*LOW + k] = P(bikes ≤ k), lowD[i*LOW + k] = P(free docks ≤ k), k = 0..LOW-1
      const lowB = new Float32Array(T * LOW), lowD = new Float32Array(T * LOW);
      // "initial": anchor = the station's own current level (chronically empty/full stations stay so)
      const target = rev.target === "initial" ? Math.min(C, s.bikes) : Math.round(C * rev.target_fill);
      const rec = (i) => {
        let m = 0; for (let n = 0; n <= C; n++) m += n * p[n];
        pB[i] = 1 - p[0]; pD[i] = 1 - p[C]; mean[i] = m;
        let cb = 0, cd = 0;
        for (let k = 0; k < LOW; k++) {
          cb += k <= C ? p[k] : 0; cd += k <= C ? p[C - k] : 0;
          lowB[i * LOW + k] = Math.min(1, cb); lowD[i * LOW + k] = Math.min(1, cd);
        }
      };
      rec(0);
      for (let i = 0; i < ctx.length; i++) {
        const { off, h, rf } = ctx[i], base = off * 48;
        const dep = (prof[base + h] / 10) * rf * STEP_H, arr = (prof[base + 24 + h] / 10) * rf * STEP_H;
        step(p, dep, -1, C, q); [p, q] = [q, p];
        step(p, arr, +1, C, q); [p, q] = [q, p];
        for (let n = 0; n <= C; n++) p[n] *= 1 - r;
        p[target] += r;
        rec(i + 1);
      }
      out.set(s.sno, { pBike: pB, pDock: pD, mean, cap: C, lowB, lowD });
    }
    if (++done % 120 === 0) { onProgress?.(done / stations.length); await new Promise((res) => setTimeout(res, 0)); }
  }
  onProgress?.(1);
  return out;
}

export const modelInfo = () => MODEL && { source: MODEL.source, built_at: MODEL.built_at, validation: MODEL.validation, backtest: MODEL.backtest, rain_factor: MODEL.rain_factor };
