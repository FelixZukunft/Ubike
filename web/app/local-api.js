// In-browser replacement for the server API, used by the static (serverless) build.
// Same endpoints and response shapes as ubike/server.py, so app.js is unchanged.
// Live data: YouBike feed fetched directly (CORS *). Personal data: localStorage.

const FEED = 'https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json';
const METEO = 'https://api.open-meteo.com/v1/forecast';
const METEO_FALLBACK = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const FEED_TTL = 25e3, WEATHER_TTL = 30 * 60e3, HIST_KEEP_H = 24, TREND_MIN = 20;
const WALK = 75, DETOUR = 1.25, TREND_T = 0.12;

const DEFAULTS = {
  places: [
    { id: 'home', name: 'Home', icon: 'house', lat: 25.0478, lng: 121.5170, radius_m: 500, mode: 'both', sort: 0 },
    { id: 'ntu', name: 'NTU', icon: 'graduationcap', lat: 25.0174, lng: 121.5397, radius_m: 600, mode: 'both', sort: 1 },
  ],
  routes: [
    { id: 'r-morning', from_place: 'home', to_place: 'ntu', weekdays: [0, 1, 2, 3, 4], depart: '08:30', enabled: true },
    { id: 'r-evening', from_place: 'ntu', to_place: 'home', weekdays: [0, 1, 2, 3, 4], depart: '18:00', enabled: true },
  ],
  prefs: { max_walk_m: 700, hide_empty: true, map_app: 'google', show_chinese: true, auto_refresh_s: 30 },
};
const FARE = [{ upto: 240, per: 10, first: 5 }, { upto: 480, per: 20 }, { upto: 1e9, per: 40 }];

// ------------------------------------------------------------------ storage
const ls = {
  get(k, d) { try { const v = localStorage.getItem('u:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('u:' + k, JSON.stringify(v)); } catch {} },
};
const places = () => ls.get('places', DEFAULTS.places);
const routes = () => ls.get('routes', DEFAULTS.routes);
const prefs = () => ({ ...DEFAULTS.prefs, ...ls.get('prefs', {}) });
const rides = () => ls.get('rides', []);

/** One-time import of places/routes/prefs from the private install link (#setup=…). */
export function importSetup(token) {
  if (!token || ls.get('setupToken') === token) return false;
  try {
    const json = decodeURIComponent(escape(atob(token.replace(/-/g, '+').replace(/_/g, '/'))));
    const d = JSON.parse(json);
    if (d.places?.length) ls.set('places', d.places);
    if (d.routes) ls.set('routes', d.routes);
    if (d.prefs) ls.set('prefs', { ...prefs(), ...d.prefs });
    ls.set('setupToken', token);
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ time helpers (naive Taipei local ISO, like the server)
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const parseFeedTime = (s) => new Date(s.replace(' ', 'T'));
const uid = (p) => `${p}-${Math.random().toString(16).slice(2, 10)}`;

// ------------------------------------------------------------------ geo + model (ported from ubike/live.py)
function haversine(a, b, c, d) {
  const R = 6371008.8, r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b, c, d) {
  const r = Math.PI / 180, p1 = a * r, p2 = c * r, dl = (d - b) * r;
  const x = Math.sin(dl) * Math.cos(p2), y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(x, y) / r + 360) % 360;
}
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinal = (deg) => CARD[Math.floor((deg + 22.5) / 45) % 8];
function erf(x) { // Abramowitz–Stegun
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function predict(cur, slope, minutes, cap) {
  const m = Math.max(0, minutes);
  const exp = Math.max(0, Math.min(cap, cur + slope * m * 0.7));
  const sigma = Math.sqrt(0.6 + 0.3 * m);
  let p = phi((exp - 0.5) / sigma);
  if (cur >= 1 && m <= 1) p = Math.max(p, 0.97);
  return [Math.round(exp * 10) / 10, Math.round(p * 1000) / 1000];
}
const clean = (n) => (n || '').replace(/^YouBike ?2\.0_/, '');
const district = (n) => (n || '').replace(/\s*Dist\.?$/, '');

// ------------------------------------------------------------------ live state
let stations = new Map();            // sno → station
let hist = ls.get('hist', {});       // sno → [[tMillis, bikes, docks], ...] (only stations near me/places)
let fetchedAt = null, lastFetch = 0, inflight = null, lastLoc = null;

function slope(sno) {
  const h = hist[sno];
  if (!h || h.length < 3) return 0;
  const tEnd = h.at(-1)[0];
  const pts = h.filter((p) => tEnd - p[0] <= TREND_MIN * 60e3).map((p) => [(p[0] - tEnd) / 60e3, p[1]]);
  if (pts.length < 3 || pts.at(-1)[0] - pts[0][0] < 5) return 0;
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  if (!sxx) return 0;
  return Math.max(-1, Math.min(1, pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx));
}

function trackedCenters() {
  const c = places().map((p) => [p.lat, p.lng]);
  if (lastLoc) c.push(lastLoc);
  return c;
}

async function refresh(force = false) {
  if (!force && stations.size && Date.now() - lastFetch < FEED_TTL) return;
  if (inflight) return inflight;
  inflight = (async () => {
    const feed = await fetchT(FEED, 15000);
    const now = Date.now();
    const centers = trackedCenters();
    const next = new Map();
    for (const s of feed) {
      const st = {
        sno: s.sno, name: clean(s.snaen), name_zh: clean(s.sna), district: district(s.sareaen),
        lat: +s.latitude, lng: +s.longitude, bikes: +s.available_rent_bikes || 0, docks: +s.available_return_bikes || 0,
        capacity: +s.Quantity || 0, active: String(s.act) === '1', info: parseFeedTime(s.infoTime),
      };
      next.set(st.sno, st);
      // keep short history only near places / me (keeps localStorage small)
      if (centers.some(([a, b]) => Math.abs(a - st.lat) < 0.03 && Math.abs(b - st.lng) < 0.03)) {
        const h = (hist[st.sno] ||= []);
        const t = st.info.getTime();
        if (!h.length || h.at(-1)[0] < t) h.push([t, st.bikes, st.docks]);
        while (h.length && now - h[0][0] > HIST_KEEP_H * 3600e3) h.shift();
      }
    }
    for (const k of Object.keys(hist)) if (!hist[k].length || !next.has(k)) delete hist[k];
    stations = next; fetchedAt = new Date(now); lastFetch = now;
    ls.set('hist', hist);
    try { localStorage.setItem('u:feed', JSON.stringify({ at: now, feed })); } catch {}
  })().finally(() => { inflight = null; });
  return inflight;
}
let offline = false;
export const liveStatus = () => ({ offline, at: fetchedAt ? fetchedAt.getTime() : null });
async function ensureLive() {
  try { await refresh(); offline = false; return true; }
  catch (e) {
    offline = true;
    if (!stations.size) { // offline cold start: last feed from storage
      try {
        const c = JSON.parse(localStorage.getItem('u:feed') || 'null');
        if (c) { lastFetch = 0; fetchedAt = new Date(c.at); for (const s of c.feed) stations.set(s.sno, { sno: s.sno, name: clean(s.snaen), name_zh: clean(s.sna), district: district(s.sareaen), lat: +s.latitude, lng: +s.longitude, bikes: +s.available_rent_bikes || 0, docks: +s.available_return_bikes || 0, capacity: +s.Quantity || 0, active: String(s.act) === '1', info: parseFeedTime(s.infoTime) }); }
      } catch {}
    }
    if (!stations.size) throw e;
    return false; // serve last known data; app shows the offline banner
  }
}

function card(st, lat, lng, now = new Date()) {
  const s = slope(st.sno);
  const trend = s >= TREND_T ? 'filling' : s <= -TREND_T ? 'draining' : 'stable';
  const d = {
    sno: st.sno, name: st.name, name_zh: st.name_zh, district: st.district, lat: st.lat, lng: st.lng,
    bikes: st.bikes, docks: st.docks, capacity: st.capacity, active: st.active,
    info_time: iso(st.info), age_s: Math.max(0, Math.round((now - st.info) / 1000)),
    trend, slope_per_min: Math.round(s * 1000) / 1000, offline: st.bikes === 0 && st.docks === 0,
  };
  if (lat != null) {
    const dist = haversine(lat, lng, st.lat, st.lng), walk = dist * DETOUR / WALK, brg = bearing(lat, lng, st.lat, st.lng);
    const [pb, ppb] = predict(st.bikes, s, walk, st.capacity), [pd, ppd] = predict(st.docks, -s, walk, st.capacity);
    Object.assign(d, { distance_m: Math.round(dist), walk_min: Math.round(walk * 10) / 10, bearing: Math.round(brg), cardinal: cardinal(brg),
      pred_bikes: pb, p_bike: ppb, pred_docks: pd, p_dock: ppd });
  }
  return d;
}
function nearest(lat, lng, { limit = 12, max_m = 2000, mode = 'bike', hide_empty = false } = {}) {
  const c = [];
  for (const st of stations.values()) {
    if (!st.active || (st.bikes === 0 && st.docks === 0)) continue;
    const d = haversine(lat, lng, st.lat, st.lng);
    if (d <= max_m) c.push([d, st]);
  }
  c.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [, st] of c) {
    if (hide_empty && ((mode === 'bike' && st.bikes === 0) || (mode === 'dock' && st.docks === 0))) continue;
    out.push(card(st, lat, lng));
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------ personal (ported from ubike/personal.py)
function placeStatus(p) {
  const cards = nearest(p.lat, p.lng, { limit: 8, max_m: Math.max(p.radius_m, 300) });
  const level = (vals) => { const best = Math.max(0, ...vals); return best >= 5 || vals.filter((v) => v >= 3).length >= 2 ? 2 : best >= 1 ? 1 : 0; };
  const lv = [];
  if (p.mode !== 'dock') lv.push(level(cards.map((c) => c.bikes)));
  if (p.mode !== 'bike') lv.push(level(cards.map((c) => c.docks)));
  const score = (k) => (c) => c[k] - c.walk_min * 0.03;
  const best = (k) => cards.reduce((a, c) => (!a || score(k)(c) > score(k)(a) ? c : a), null);
  return { ...p, status: ['critical', 'warning', 'good'][Math.min(...lv)], bikes: cards.reduce((a, c) => a + c.bikes, 0),
    docks: cards.reduce((a, c) => a + c.docks, 0), n_stations: cards.length, best_bike: best('p_bike'), best_dock: best('p_dock') };
}
function nextTrip(pmap, now) {
  let best = null;
  for (const r of routes()) {
    if (!r.enabled || !pmap[r.from_place] || !pmap[r.to_place]) continue;
    const [hh, mm] = r.depart.split(':').map(Number);
    for (let add = 0; add < 8; add++) {
      const day = new Date(now); day.setDate(day.getDate() + add); day.setHours(hh, mm, 0, 0);
      const wd = (day.getDay() + 6) % 7;
      if (!r.weekdays.includes(wd) || day < now - 10 * 60e3) continue;
      if (!best || day < best[0]) best = [day, r];
      break;
    }
  }
  return best && { route: best[1], depart: iso(best[0]), from: pmap[best[1].from_place], to: pmap[best[1].to_place] };
}
function fare(min) {
  if (min <= 0) return 0;
  const blocks = Math.ceil(min / 30); let cost = 0, done = 0;
  for (const t of FARE) while (done < blocks && done < Math.floor(t.upto / 30)) { cost += done === 0 && t.first ? t.first : t.per; done++; }
  return cost;
}
const rideOut = (r) => ({ ...r, ...(r.end_ts ? { duration_min: Math.round((new Date(r.end_ts) - new Date(r.start_ts)) / 6000) / 10 } : {}) });

// ------------------------------------------------------------------ weather (Open-Meteo, no key)
async function fetchT(url, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function weather(p) {
  const cached = ls.get('weather', null);
  if (cached && Date.now() - cached.at < WEATHER_TTL && Math.abs(cached.lat - p.lat) < 0.03) return shapeWeather(cached.data);
  const r2 = (v) => (Math.round(v * 50) / 50).toFixed(2); // ~2 km grid: enough for weather, no exact position leaves the phone
  const q = `latitude=${r2(p.lat)}&longitude=${r2(p.lng)}&timezone=Asia%2FTaipei&current=temperature_2m,relative_humidity_2m,weather_code,precipitation`
    + `&hourly=temperature_2m,precipitation,precipitation_probability,weather_code&minutely_15=precipitation`;
  let data;
  try { data = await fetchT(`${METEO}?${q}&forecast_days=2`, 5000); }
  catch {
    const t = new Date(), e = new Date(Date.now() + 2 * 864e5);
    const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    try { data = await fetchT(`${METEO_FALLBACK}?${q}&start_date=${day(t)}&end_date=${day(e)}`, 6000); } catch { data = cached?.data; }
  }
  if (data && !data.error) ls.set('weather', { at: Date.now(), lat: p.lat, data });
  return data ? shapeWeather(data) : { hours: [], next2h: [], warnings: [] };
}
function shapeWeather(d) {
  const now = new Date(), hourStart = new Date(now); hourStart.setMinutes(0, 0, 0);
  const h = d.hourly || {}, m = d.minutely_15 || {};
  const hours = (h.time || []).map((t, i) => ({ ts: t, temperature_c: h.temperature_2m[i], precip_prob: h.precipitation_probability?.[i], precip_mm: h.precipitation[i], code: h.weather_code[i] }))
    .filter((x) => new Date(x.ts) >= hourStart).slice(0, 12);
  const next2h = (m.time || []).map((t, i) => ({ ts: t, precip_mm: m.precipitation[i] }))
    .filter((x) => new Date(x.ts) >= new Date(now - 15 * 60e3) && new Date(x.ts) < new Date(+now + 2 * 3600e3));
  const wet = next2h.find((x) => (x.precip_mm || 0) >= 0.3);
  return { temperature_c: d.current?.temperature_2m ?? hours[0]?.temperature_c, humidity_pct: d.current?.relative_humidity_2m,
    source: 'Open-Meteo', hours, next2h, rain_soon: wet ? { at: wet.ts, mm: wet.precip_mm } : null, warnings: [] };
}

// ------------------------------------------------------------------ router
const json = (x) => JSON.parse(JSON.stringify(x));
export async function localApi(path, opts = {}) {
  const url = new URL(path, location.origin);
  const p = url.pathname.replace(/^\/api/, ''), q = Object.fromEntries(url.searchParams);
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};
  const now = new Date();

  // ---- personal (no network)
  if (p === '/places' && method === 'GET') return { places: places(), routes: routes() };
  if (p === '/prefs' && method === 'GET') return prefs();
  if (p === '/prefs' && method === 'POST') { ls.set('prefs', { ...prefs(), ...body }); return prefs(); }
  if (p === '/places' && method === 'POST') {
    const list = places(), row = { ...body, id: body.id || uid('p'), lat: +body.lat, lng: +body.lng, radius_m: +body.radius_m || 500, mode: body.mode || 'both', icon: body.icon || 'mappin' };
    if (row.sort == null) row.sort = list.length;
    ls.set('places', [...list.filter((x) => x.id !== row.id), row].sort((a, b) => a.sort - b.sort)); return row;
  }
  if (p.startsWith('/places/') && method === 'DELETE') {
    const id = p.slice(8); ls.set('places', places().filter((x) => x.id !== id));
    ls.set('routes', routes().filter((r) => r.from_place !== id && r.to_place !== id)); return { ok: true };
  }
  if (p === '/routes' && method === 'POST') {
    const row = { ...body, id: body.id || uid('r'), weekdays: [...new Set(body.weekdays.map(Number))].sort(), enabled: body.enabled !== false };
    ls.set('routes', [...routes().filter((r) => r.id !== row.id), row].sort((a, b) => a.depart.localeCompare(b.depart))); return row;
  }
  if (p.startsWith('/routes/') && method === 'DELETE') { const id = p.slice(8); ls.set('routes', routes().filter((r) => r.id !== id)); return { ok: true }; }
  if (p === '/rides' && method === 'GET') {
    const done = rides().filter((r) => r.end_ts).map(rideOut).sort((a, b) => b.start_ts.localeCompare(a.start_ts));
    const ws = new Date(now); ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7)); ws.setHours(0, 0, 0, 0);
    const sum = (rs) => ({ count: rs.length, minutes: Math.round(rs.reduce((a, r) => a + (r.duration_min || 0), 0)),
      distance_km: Math.round(rs.reduce((a, r) => a + (r.distance_m || 0), 0) / 100) / 10, cost_nt: Math.round(rs.reduce((a, r) => a + (r.cost_nt || 0), 0)) });
    return { rides: done, all: sum(done), week: sum(done.filter((r) => new Date(r.start_ts) >= ws)), daily: {} };
  }
  if (p === '/rides/cancel') { ls.set('rides', rides().filter((r) => r.end_ts)); return { ok: true }; }
  if (p.startsWith('/rides/') && method === 'DELETE') { const id = p.slice(7); ls.set('rides', rides().filter((r) => r.id !== id)); return { ok: true }; }

  // ---- needs live data
  if (q.lat) lastLoc = [+q.lat, +q.lng];
  await ensureLive();
  const fa = fetchedAt ? iso(fetchedAt) : null;
  const name = (sno) => stations.get(sno)?.name || null;

  if (p === '/rides/start') {
    const active = rides().find((r) => !r.end_ts);
    if (active) return rideOut(active);
    const r = { id: uid('ride'), start_ts: iso(now), end_ts: null, from_sno: body.sno || null, to_sno: null, from_name: name(body.sno), to_name: null, distance_m: null, cost_nt: null, source: 'app', note: null };
    ls.set('rides', [...rides(), r]); return rideOut(r);
  }
  if (p === '/rides/end') {
    const all = rides(), r = all.find((x) => !x.end_ts);
    if (!r) { const e = new Error('no active ride'); e.status = 409; throw e; }
    const a = stations.get(r.from_sno), b = stations.get(body.sno);
    Object.assign(r, { end_ts: iso(now), to_sno: body.sno || null, to_name: name(body.sno),
      distance_m: a && b ? haversine(a.lat, a.lng, b.lat, b.lng) * DETOUR : null, cost_nt: fare((now - new Date(r.start_ts)) / 60e3) });
    ls.set('rides', all); return rideOut(r);
  }
  if (p === '/rides' && method === 'POST') {
    const a = stations.get(body.from_sno), b = stations.get(body.to_sno);
    const r = { id: uid('ride'), start_ts: body.start_ts, end_ts: body.end_ts, from_sno: body.from_sno, to_sno: body.to_sno,
      from_name: body.from_name || name(body.from_sno), to_name: body.to_name || name(body.to_sno),
      distance_m: a && b ? haversine(a.lat, a.lng, b.lat, b.lng) * DETOUR : null,
      cost_nt: body.cost_nt ?? fare((new Date(body.end_ts) - new Date(body.start_ts)) / 60e3), source: body.source || 'manual', note: null };
    ls.set('rides', [...rides(), r]); return rideOut(r);
  }
  if (p === '/live') {
    return { fetched_at: fa, now: iso(now), stations: nearest(+q.lat, +q.lng, { limit: +q.limit || 12, max_m: +q.max_m || 2000, mode: q.mode, hide_empty: q.hide_empty === 'true' }) };
  }
  if (p === '/map') {
    return { fetched_at: fa, stations: [...stations.values()].filter((s) => s.active).map((s) => [s.sno, s.lat, s.lng, s.bikes, s.docks, s.capacity, s.name, s.name_zh]) };
  }
  if (p === '/home') {
    const ps = places(), pmap = Object.fromEntries(ps.map((x) => [x.id, x]));
    const st = ps.map(placeStatus), smap = Object.fromEntries(st.map((x) => [x.id, x]));
    const trip = nextTrip(pmap, now);
    if (trip) {
      const o = smap[trip.from.id], d = smap[trip.to.id], dep = new Date(trip.depart), bb = o.best_bike;
      Object.assign(trip, { best_bike: bb, best_dock: d.best_dock, leave_by: iso(new Date(dep - Math.ceil(bb?.walk_min || 0) * 60e3)), minutes_until: Math.round((dep - now) / 60e3) });
    }
    const origin = ps.find((x) => x.id === 'home') || ps[0] || { lat: 25.033, lng: 121.54 };
    const w = await weather(lastLoc ? { lat: lastLoc[0], lng: lastLoc[1] } : origin);
    return json({ now: iso(now), fetched_at: fa, places: st, next_trip: trip, weather: w, events: [], active_ride: rides().find((r) => !r.end_ts) || null, prefs: prefs() });
  }
  if (p.startsWith('/station/')) {
    const sno = p.slice(9), s = stations.get(sno);
    if (!s) { const e = new Error('unknown station'); e.status = 404; throw e; }
    return { station: card(s), points: (hist[sno] || []).map(([t, b, d]) => ({ t: iso(new Date(t)), bikes: b, docks: d })) };
  }
  if (p === '/search') {
    const ql = (q.q || '').toLowerCase().trim();
    let res = [...stations.values()].filter((s) => s.name.toLowerCase().includes(ql) || s.name_zh.includes(q.q) || s.sno === ql);
    if (q.lat) res.sort((a, b) => haversine(+q.lat, +q.lng, a.lat, a.lng) - haversine(+q.lat, +q.lng, b.lat, b.lng));
    return res.slice(0, 20).map((s) => card(s, q.lat ? +q.lat : null, q.lat ? +q.lng : null));
  }
  if (p.startsWith('/heatmap/')) return { place: places().find((x) => x.id === p.slice(9)), stations: [], days_of_data: 0 };
  const e = new Error('not available offline: ' + p); e.status = 404; throw e;
}

export function exportSetup() {
  return { places: places(), routes: routes(), prefs: prefs() };
}
