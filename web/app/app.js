// YouBike phone app. Vanilla ES modules, no build step.
import { icon, statusIcon, weatherIcon, PLACE_ICONS } from '/shared/icons.js';
import { lineChart, heatmap, heatLegend } from '/shared/charts.js';
import { localApi, importSetup, liveStatus } from '/app/local-api.js';
import { loadModel, rainForecast, timeGrid, runForecast, modelInfo, riskOf, STEPS, STEP_H } from '/app/forecast.js';

// Static build (no server): window.UBIKE_STATIC is set in index.html by the deploy script.
const STATIC = !!window.UBIKE_STATIC;
let SETUP = null; // private install-link token (#setup=…), kept in the URL so Add to Home Screen keeps it

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLACE_COLORS = { house: '#FF9500', graduationcap: '#5856D6', book: '#AF52DE', briefcase: '#8E8E93', cart: '#34C759', dumbbell: '#FF2D55', fork: '#FF9500', heart: '#FF2D55', star: '#FFCC00', mappin: '#007AFF' };
const placeColor = (p) => PLACE_COLORS[p.icon] || '#007AFF';
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// ------------------------------------------------------------------ state
const S = {
  tab: 'today', home: null, prefs: {}, places: [], routes: [],
  loc: null,            // {lat, lng, acc, src: 'gps' | 'place', placeName}
  heading: null,        // degrees from north, from compass
  find: { mode: 'bike', dest: 'here', cards: [], idx: 0, selected: null, prevBikes: {}, timer: null },
  insights: { place: null, kind: 'bike' },
  online: true,
};

// ------------------------------------------------------------------ API (+ offline cache)
async function api(path, opts = {}) {
  if (STATIC) {
    try { const d = await localApi(path, opts); const st = liveStatus(); setOnline(!st.offline, st.at); return d; }
    catch (e) { setOnline(false); throw e; }
  }
  const init = { credentials: 'same-origin', headers: {}, ...opts };
  if (opts.body && typeof opts.body !== 'string') { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
  try {
    const r = await fetch(path, init);
    if (r.status === 401) { showLock(); throw new Error('locked'); }
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    const data = await r.json();
    if (!opts.method || opts.method === 'GET') {
      try { localStorage.setItem('c:' + path.split('?')[0], JSON.stringify({ at: Date.now(), data })); } catch {}
    }
    setOnline(true);
    return data;
  } catch (e) {
    if (e.message === 'locked') throw e;
    if (!opts.method || opts.method === 'GET') {
      try {
        const c = JSON.parse(localStorage.getItem('c:' + path.split('?')[0]) || 'null');
        if (c) { setOnline(false, c.at); return c.data; }
      } catch {}
    }
    setOnline(false);
    throw e;
  }
}
function setOnline(on, at) {
  S.online = on; S.offlineAt = at;
  $$('.offline-banner').forEach((b) => b.classList.toggle('hidden', on));
  $$('.offline-banner .when').forEach((w) => (w.textContent = at ? 'last updated ' + clock(new Date(at)) : 'no cached data'));
}
const offlineBanner = () => `<div class="banner offline offline-banner ${S.online ? 'hidden' : ''}">${icon('wifi_off')}<div>Offline · showing <span class="when"></span></div></div>`;

// ------------------------------------------------------------------ formatting
const clock = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const ago = (s) => (s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const pct = (p) => `${Math.round(p * 100)}%`;
const trendIcon = (t) => icon(t === 'filling' ? 'trendup' : t === 'draining' ? 'trenddown' : 'minus');
const tlabel = (t) => ({ filling: 'Filling', draining: 'Draining', stable: 'Stable' }[t]);
function minsUntil(iso) { return Math.round((new Date(iso) - Date.now()) / 60000); }
function relTime(iso) {
  const m = minsUntil(iso);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`;
}
function status(n) { return n >= 6 ? 'good' : n >= 2 ? 'warning' : 'critical'; }
const STATUS_TXT = { good: 'Plenty', warning: 'Low', critical: 'Critical' };
const statusChip = (s, txt) => `<span class="status ${s}">${statusIcon(s)}${txt || STATUS_TXT[s]}</span>`;

// ------------------------------------------------------------------ haptics
const hapticLabel = (() => {
  const l = document.createElement('label'); l.className = 'haptic';
  l.innerHTML = '<input type="checkbox" switch>'; document.body.appendChild(l); return l;
})();
function haptic(pattern = [30]) {
  if (navigator.vibrate) navigator.vibrate(pattern);
  else hapticLabel.click(); // iOS 18+: toggling a switch input produces a haptic tick
}

// ------------------------------------------------------------------ location + compass
function placeById(id) { return S.places.find((p) => p.id === id); }
function fallbackLoc() {
  const p = placeById('home') || S.places[0];
  return p ? { lat: p.lat, lng: p.lng, acc: null, src: 'place', placeName: p.name } : { lat: 25.0330, lng: 121.5340, src: 'place', placeName: 'Taipei' };
}
let watchId = null;
function startLocation() {
  if (!('geolocation' in navigator)) { S.loc = S.loc || fallbackLoc(); return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition((pos) => {
    const first = !S.loc || S.loc.src !== 'gps';
    const moved = S.loc ? haversine(S.loc.lat, S.loc.lng, pos.coords.latitude, pos.coords.longitude) : 1e9;
    S.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, src: 'gps' };
    if (S.tab === 'find' && (first || moved > 40)) loadFind();
    updateMeMarker();
  }, (err) => {
    S.locError = err.code === 1 ? 'Location permission denied' : 'Location unavailable';
    if (!S.loc) { S.loc = fallbackLoc(); if (S.tab === 'find') loadFind(); }
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}
/** Ask for the position now (shows the iOS prompt if allowed); explain how to fix a block. */
function requestLocation(onOk) {
  if (!('geolocation' in navigator)) return locationHelp();
  navigator.geolocation.getCurrentPosition((pos) => {
    S.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, src: 'gps' };
    S.locError = null;
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    startLocation(); updateMeMarker(); haptic([10]);
    onOk?.(S.loc);
  }, (err) => {
    S.locError = err.code === 1 ? 'Location permission denied' : 'Location unavailable';
    if (err.code === 1) locationHelp();
    else toast('Location unavailable', ' No GPS fix yet — try again in a moment or near a window.');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
}
function locationHelp() {
  const step = (n, html) => `<div class="cell"><div class="iconbadge" style="background:var(--blue)"><b style="font-size:14px">${n}</b></div><div class="title" style="white-space:normal">${html}</div></div>`;
  openSheet(`<div class="bar"><span style="min-width:64px"></span><h3>Allow Location</h3><button class="r" data-close>Done</button></div>
    <div class="peek" style="display:flex;gap:12px;align-items:center">${icon('location')}<div>iPhone is blocking your location for this app, so it uses <b>Home</b> instead. It's switched on in iOS Settings, not in the app:</div></div>
    <div class="group-label">On your iPhone</div>
    <div class="group">
      ${step(1, '<b>Settings → Privacy &amp; Security → Location Services</b>: make sure it is <b>On</b>.')}
      ${step(2, 'In the same list, open <b>Safari Websites</b> → choose <b>While Using the App</b> and keep <b>Precise Location</b> on.')}
      ${step(3, 'Open the app link in <b>Safari</b>, tap <b>aA</b> next to the address → <b>Website Settings</b> → <b>Location</b> → <b>Allow</b>.')}
      ${step(4, 'Close Bike completely (swipe it away in the app switcher), open it again and tap <b>Allow</b> when asked.')}
    </div>
    <p class="group-foot">Your position is only used on the phone to sort stations and point the arrows; it isn't sent anywhere.</p>
    <div style="margin-top:16px"><button class="btn" data-retry>${icon('locationfill')} Try again</button></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = () => { sheetStack.length = 0; closeSheet(); };
    sh.querySelector('[data-retry]').onclick = () => { sheetStack.length = 0; closeSheet(); requestLocation((l) => { if (map) map.flyTo({ center: [l.lng, l.lat], zoom: 16 }); if (S.tab === 'find') loadFind(); }); };
  });
}
function haversine(a, b, c, d) {
  const R = 6371008.8, r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  S.heading = h;
  rotateNeedles();
}
let compassOn = false;
async function enableCompass() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return toast('Compass not allowed', 'Arrows will point relative to north.');
    }
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    compassOn = true; localStorage.setItem('compass', '1');
    renderFindHead();
  } catch { toast('Compass unavailable', 'Arrows will point relative to north.'); }
}
let needleRaf;
function rotateNeedles() {
  cancelAnimationFrame(needleRaf);
  needleRaf = requestAnimationFrame(() => {
    $$('.needle[data-bearing]').forEach((n) => {
      const b = +n.dataset.bearing;
      const rot = S.heading == null ? b : b - S.heading;
      // keep rotation continuous to avoid 359→0 spins
      const prev = +(n.dataset.rot || rot);
      let r = rot; while (r - prev > 180) r -= 360; while (r - prev < -180) r += 360;
      n.dataset.rot = r; n.style.transform = `rotate(${r}deg)`;
    });
  });
}

// ------------------------------------------------------------------ navigation (maps deep links)
function navigate(lat, lng, name) {
  try { localStorage.setItem('lastTarget', JSON.stringify({ lat, lng, name, at: Date.now() })); } catch {}
  haptic([15]);
  const app = S.prefs.map_app || 'google';
  const url = app === 'apple'
    ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;
  location.href = url;
}

// ------------------------------------------------------------------ toast + sheets
let toastTimer;
function toast(title, text = '', action) {
  const t = $('#toast');
  t.innerHTML = `${icon(action?.icon || 'warning')}<div class="txt"><b>${esc(title)}</b>${esc(text)}</div>${action ? `<button class="btn small">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.classList.remove('on'); action.run(); };
  t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), action ? 9000 : 3500);
  t.onclick = (e) => { if (e.target.tagName !== 'BUTTON') t.classList.remove('on'); };
}
const sheetStack = [];
function openSheet(html, onMount) {
  const sh = $('#sheet');
  sheetStack.push({ html, onMount });
  sh.innerHTML = `<div class="grabber"></div>${html}`;
  sh.scrollTop = 0;
  $('#scrim').classList.add('on'); sh.classList.add('on');
  onMount?.(sh);
}
function closeSheet() {
  sheetStack.pop();
  const prev = sheetStack.pop();
  if (prev) return openSheet(prev.html, prev.onMount);
  $('#scrim').classList.remove('on'); $('#sheet').classList.remove('on');
}
$('#scrim').onclick = () => { sheetStack.length = 0; closeSheet(); };
// swipe down to dismiss
(() => {
  const sh = $('#sheet'); let y0 = null, dy = 0;
  sh.addEventListener('touchstart', (e) => { if (sh.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sh.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  sh.addEventListener('touchend', () => { sh.style.transition = ''; sh.style.transform = ''; if (dy > 110) { sheetStack.length = 0; closeSheet(); } y0 = null; });
})();

// ------------------------------------------------------------------ tabs / routing
const TABS = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'find', label: 'Find', icon: 'bicycle', center: true },
  { id: 'future', label: 'Future', icon: 'clock' },
  { id: 'rides', label: 'Rides', icon: 'list' },
];
function renderTabbar() {
  $('#tabbar').innerHTML = TABS.map((t) => t.center
    ? `<button class="tab find" data-tab="${t.id}"><span class="bubble">${icon(t.icon)}</span>${t.label}</button>`
    : `<button class="tab ${S.tab === t.id ? 'on' : ''}" data-tab="${t.id}">${icon(t.icon)}${t.label}</button>`).join('');
  $$('#tabbar .tab').forEach((b) => (b.onclick = () => { haptic([8]); go(b.dataset.tab); }));
}
function go(tab, params = {}) {
  S.tab = tab;
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === `screen-${tab}`));
  $('#tabbar').classList.toggle('hidden', tab === 'lock');
  renderTabbar();
  const q = new URLSearchParams(params).toString();
  if (!SETUP) history.replaceState(null, '', `#${tab}${q ? '?' + q : ''}`);
  clearInterval(S.find.timer);
  if (tab === 'today') loadToday();
  if (tab === 'find') {
    if (params.mode) S.find.mode = params.mode;
    if (params.dest) S.find.dest = params.dest;
    loadFind();
    S.find.timer = setInterval(() => document.visibilityState === 'visible' && loadFind(true), (S.prefs.auto_refresh_s || 30) * 1000);
  }
  if (tab === 'map') loadMap();
  if (tab === 'insights') loadInsights();
  if (tab === 'future') loadFuture();
  if (tab === 'rides') loadRides();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (S.tab === 'find') loadFind(true); if (S.tab === 'today') loadToday(); }
});

// ------------------------------------------------------------------ TODAY
async function loadToday() {
  const el = $('#screen-today');
  if (!S.home) el.innerHTML = `<div class="largetitle"><div><div class="sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>Today</h1></div></div><div class="skeleton" style="height:230px"></div><div class="skeleton" style="height:120px;margin-top:12px"></div>`;
  try { S.home = await api('/api/home'); } catch { return; }
  S.prefs = S.home.prefs; S.places = S.home.places;
  renderToday();
}
function renderToday() {
  const h = S.home, w = h.weather || {};
  const now = new Date();
  const trip = h.next_trip, ride = h.active_ride;
  let hero = '';
  if (ride) {
    hero = `<div class="hero ride">
      <div class="kicker">${icon('bicycle')} Riding now</div>
      <div class="route">From ${esc(ride.from_name || 'unknown station')}</div>
      <div class="leave"><span class="big num" id="ridetimer">0:00</span><span class="lbl">· ${esc(fareHint(ride))}</span></div>
      <div class="actions"><button class="btn" data-act="dock">${icon('dock')} Find a dock</button><button class="btn ghost" data-act="endride">End ride</button></div>
    </div>`;
  } else if (trip) {
    const bb = trip.best_bike, bd = trip.best_dock;
    const leaveM = minsUntil(trip.leave_by);
    hero = `<div class="hero">
      <div class="kicker">${icon('clock')} Next trip · ${new Date(trip.depart).toLocaleDateString('en-US', { weekday: 'short' })} ${clock(new Date(trip.depart))}</div>
      <div class="route">${esc(trip.from.name)} → ${esc(trip.to.name)}</div>
      <div class="leave"><span class="lbl">Leave by</span><span class="big num">${clock(new Date(trip.leave_by))}</span><span class="lbl">${leaveM > 0 && leaveM < 600 ? relTime(trip.leave_by) : ''}</span></div>
      <div class="stations">
        <button class="st" data-nav="${bb ? `${bb.lat},${bb.lng}` : ''}"><div class="k">PICK UP</div><div class="n">${esc(bb?.name || 'No station')}</div><div class="v num">${bb ? bb.bikes : '–'} <small>bikes · ${bb ? Math.round(bb.walk_min) + ' min walk' : ''}</small></div></button>
        <button class="st" data-nav="${bd ? `${bd.lat},${bd.lng}` : ''}"><div class="k">RETURN</div><div class="n">${esc(bd?.name || 'No station')}</div><div class="v num">${bd ? bd.docks : '–'} <small>free docks</small></div></button>
      </div>
      <div class="actions">${bb ? `<button class="btn" data-nav="${bb.lat},${bb.lng}">${icon('location')} Walk to pick-up</button>` : ''}</div>
    </div>`;
  } else {
    hero = `<div class="hero"><div class="kicker">${icon('sparkles')} No trips planned</div><div class="route">Add your usual routes in Settings to get leave-by times.</div><div class="actions"><button class="btn" data-act="bike">${icon('bicycle')} Find a bike</button><button class="btn ghost" data-act="settings">Settings</button></div></div>`;
  }

  const rain = w.rain_soon ? `<div class="banner rain">${icon('umbrella')}<div><b>Rain from ${clock(new Date(w.rain_soon.at))}</b> · about ${w.rain_soon.mm} mm per 15 min. Consider the MRT.</div></div>` : '';
  const warns = (w.warnings || []).map((x) => `<div class="banner warn">${icon('warning')}<div><b>${esc(x.phenomena)}${esc(x.significance || '')}</b>${x.end_time ? ' · until ' + clock(new Date(x.end_time)) : ''}</div></div>`).join('');
  const hours = (w.hours || []).slice(0, 12).map((x, i) => `<div class="hour"><span class="muted">${i === 0 ? 'Now' : new Date(x.ts).getHours().toString().padStart(2, '0')}</span>${icon(weatherIcon(x.code, x.precip_mm))}<span class="p">${x.precip_prob >= 20 ? Math.round(x.precip_prob) + '%' : ''}</span><b>${Math.round(x.temperature_c)}°</b></div>`).join('');
  const temp = w.temperature_c != null ? Math.round(w.temperature_c) + '°' : '–';

  const places = h.places.map((p) => `
    <button class="place" data-place="${esc(p.id)}">
      <div class="top"><div class="pi" style="background:${placeColor(p)}">${icon(p.icon)}</div>${statusChip(p.status)}</div>
      <div><div class="name">${esc(p.name)}</div>
      <div class="counts"><div><b class="num">${p.bikes}</b><span>bikes</span></div><div><b class="num">${p.docks}</b><span>docks</span></div></div></div>
    </button>`).join('');

  const evs = (h.events || []).map((e) => {
    const d = new Date(e.start_ts);
    return `<div class="cell"><div class="event"><div class="date"><span>${d.toLocaleDateString('en-US', { weekday: 'short' })}</span><b>${d.getDate()}</b></div>
      <div class="title"><div class="t">${esc(e.title)}</div><div class="s">${clock(d)} · ${esc(e.venue || '')}${e.near_place ? ` · ${dist(e.distance_m)} from ${esc(e.near_place)}` : ''}${e.expected_attendance ? ` · ~${e.expected_attendance.toLocaleString()} people` : ''}</div></div></div></div>`;
  }).join('');

  $('#screen-today').innerHTML = `
    <div class="largetitle"><div><div class="sub">${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>Today</h1></div>
      <button class="navbtn" id="opensettings" aria-label="Settings">${icon('gear')}</button></div>
    ${offlineBanner()}${warns}${rain}
    ${hero}
    <div class="quick">
      <button data-act="bike">${icon('bicycle')}<b>Find a bike</b></button>
      <button data-act="dock">${icon('dock')}<b>Find a dock</b></button>
    </div>
    <div class="section-h"><h2>My Places</h2><button class="link" data-act="settings">Edit</button></div>
    <div class="places">${places}</div>
    <div class="section-h"><h2>Weather</h2><span class="muted small">${esc(w.source || '')}${w.station ? ' · ' + esc(w.station) : ''}</span></div>
    <div class="group"><div class="weather-strip">${icon(weatherIcon(w.hours?.[0]?.code, w.rain_1h_mm))}<span class="temp num">${temp}</span>
      <span class="muted small">${w.desc ? esc(w.desc) + ' · ' : ''}${w.humidity_pct != null ? 'Humidity ' + Math.round(w.humidity_pct) + '%' : ''}${w.rain_1h_mm ? ' · ' + w.rain_1h_mm + ' mm last hour' : ''}</span></div>
      <div class="hours">${hours}</div></div>
    ${evs ? `<div class="section-h"><h2>Nearby events</h2></div><div class="group">${evs}</div>` : ''}
    <p class="group-foot" style="text-align:center;margin-top:18px">Live data ${h.fetched_at ? 'from ' + clock(new Date(h.fetched_at)) : 'unavailable'}</p>`;

  // quick + secondary styling for quick buttons
  const qb = $$('#screen-today .quick button');
  qb[0].querySelector('.ic').style.background = 'var(--blue)';
  qb[1].querySelector('.ic').style.background = 'var(--green)';
  $('#opensettings').onclick = openSettings;
  $$('#screen-today [data-act]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'bike') go('find', { mode: 'bike', dest: 'here' });
    if (a === 'dock') go('find', { mode: 'dock', dest: trip && !ride ? trip.to.id : 'here' });
    if (a === 'settings') openSettings();
    if (a === 'endride') endRide();
  }));
  $$('#screen-today [data-nav]').forEach((b) => (b.onclick = () => { if (b.dataset.nav) { const [la, ln] = b.dataset.nav.split(','); navigate(+la, +ln); } }));
  $$('#screen-today [data-place]').forEach((b) => (b.onclick = () => openPlaceDetail(b.dataset.place)));
  if (ride) tickRide(ride);
}
function fareHint(ride) {
  const m = (Date.now() - new Date(ride.start_ts)) / 60000;
  return m < 30 ? `NT$5 until ${clock(new Date(new Date(ride.start_ts).getTime() + 30 * 60000))}` : `NT$${5 + Math.ceil((m - 30) / 30) * 10} so far`;
}
let rideTimer;
function tickRide(ride) {
  clearInterval(rideTimer);
  const f = () => {
    const el = $('#ridetimer'); if (!el) return clearInterval(rideTimer);
    const s = Math.floor((Date.now() - new Date(ride.start_ts)) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  f(); rideTimer = setInterval(f, 1000);
}

async function openPlaceDetail(id) {
  const p = S.home.places.find((x) => x.id === id);
  if (!p) return;
  const data = await api(`/api/live?lat=${p.lat}&lng=${p.lng}&limit=8&max_m=${Math.max(p.radius_m, 300)}`);
  const rows = data.stations.map((c) => `<button class="cell" data-nav="${c.lat},${c.lng}">
      <div class="title"><div class="t">${esc(c.name)}</div><div class="s">${dist(c.distance_m)} from ${esc(p.name)} · ${tlabel(c.trend)} · ${ago(c.age_s)}</div></div>
      <div class="num" style="text-align:right"><b>${c.bikes}</b> <span class="muted small">${c.bikes === 1 ? 'bike' : 'bikes'}</span><br><span class="muted small">${c.docks} ${c.docks === 1 ? 'dock' : 'docks'}</span></div></button>`).join('');
  openSheet(`<div class="bar"><span style="min-width:64px"></span><h3>${esc(p.name)}</h3><button class="r" data-close>Done</button></div>
    <div class="peek" style="display:flex;justify-content:space-between;align-items:center"><div>${statusChip(p.status)}<div class="muted small" style="margin-top:4px">${p.n_stations} stations within ${p.radius_m} m</div></div>
      <div class="btnrow" style="width:auto"><button class="btn small tinted" data-go="bike">Bike</button><button class="btn small tinted" data-go="dock">Dock</button>${STATIC ? '' : '<button class="btn small tinted" data-go="heat">Heatmap</button>'}</div></div>
    <div class="group-label">Stations</div><div class="group">${rows || '<div class="empty">No stations in range</div>'}</div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = () => { sheetStack.length = 0; closeSheet(); };
    $$('[data-nav]', sh).forEach((b) => (b.onclick = () => { const [a, c] = b.dataset.nav.split(','); navigate(+a, +c); }));
    $$('[data-go]', sh).forEach((b) => (b.onclick = () => {
      sheetStack.length = 0; closeSheet();
      if (b.dataset.go === 'heat') { S.insights.place = id; go('insights'); } else go('find', { mode: b.dataset.go, dest: id });
    }));
  });
}

// ------------------------------------------------------------------ FIND
function renderFindHead() {
  const f = S.find;
  const dests = [{ id: 'here', name: 'Here', icon: 'location' }, ...S.places];
  const loc = S.loc;
  let locTxt;
  if (f.dest !== 'here') locTxt = `Near ${esc(placeById(f.dest)?.name || '')}`;
  else if (!loc) locTxt = 'Finding your location…';
  else if (loc.src === 'gps') locTxt = `Your location${loc.acc ? ' · ±' + Math.round(loc.acc) + ' m' : ''}`;
  else locTxt = `${S.locError || 'No GPS'} · using ${esc(loc.placeName)}`;
  const head = $('#find-head');
  if (!head) return;
  head.innerHTML = `
    <div class="largetitle" style="margin-bottom:6px"><h1>${f.mode === 'bike' ? 'Find a Bike' : 'Find a Dock'}</h1>
      <button class="navbtn" id="refresh" aria-label="Refresh">${icon('refresh')}</button></div>
    <div class="seg" id="modeseg"><button data-m="bike" class="${f.mode === 'bike' ? 'on' : ''}">Bike</button><button data-m="dock" class="${f.mode === 'dock' ? 'on' : ''}">Dock</button></div>
    <div class="chips" style="margin-top:10px">${dests.map((d) => `<button class="chip ${f.dest === d.id ? 'on' : ''}" data-dest="${esc(d.id)}">${icon(d.icon)}${esc(d.name)}</button>`).join('')}</div>
    <div class="locline">${icon(f.dest === 'here' ? 'locationfill' : 'mappin')}<span>${locTxt}</span><span class="spacer"></span>
      ${f.dest === 'here' && loc && loc.src !== 'gps' ? '<button id="lochelp">Fix</button>' : ''}
      ${!compassOn && f.dest === 'here' ? `<button id="compassbtn">${icon('compass')} Compass</button>` : ''}
      <label style="display:flex;align-items:center;gap:6px">Hide ${f.mode === 'bike' ? 'empty' : 'full'} <input type="checkbox" class="switch" id="hideempty" style="transform:scale(.7);margin:-6px -8px" ${S.prefs.hide_empty ? 'checked' : ''}></label></div>`;
  $$('#modeseg button').forEach((b) => (b.onclick = () => { haptic([8]); f.mode = b.dataset.m; f.prevBikes = {}; renderFindHead(); loadFind(); }));
  $$('[data-dest]', head).forEach((b) => (b.onclick = () => { haptic([8]); f.dest = b.dataset.dest; renderFindHead(); loadFind(); }));
  $('#refresh').onclick = () => { haptic([10]); loadFind(); };
  $('#compassbtn')?.addEventListener('click', enableCompass);
  $('#lochelp')?.addEventListener('click', () => requestLocation(() => loadFind()));
  $('#hideempty').onchange = async (e) => { S.prefs.hide_empty = e.target.checked; loadFind(); api('/api/prefs', { method: 'POST', body: { hide_empty: e.target.checked } }); };
}
function findOrigin() {
  const f = S.find;
  if (f.dest !== 'here') { const p = placeById(f.dest); if (p) return { lat: p.lat, lng: p.lng, src: 'place' }; }
  return S.loc;
}
async function loadFind(silent = false) {
  const el = $('#screen-find');
  if (!$('#find-head')) {
    el.innerHTML = `<div class="find-head" id="find-head"></div>${offlineBanner()}<div id="find-body"><div class="skeleton" style="height:360px;margin-top:10px;border-radius:28px"></div></div>`;
  }
  if (!S.places.length) { try { const pl = await api('/api/places'); S.places = pl.places; S.routes = pl.routes; } catch {} }
  if (!Object.keys(S.prefs).length) { try { S.prefs = await api('/api/prefs'); } catch {} }
  startLocation();
  if (!S.loc) setTimeout(() => { if (!S.loc) { S.loc = fallbackLoc(); loadFind(); } }, 4000);
  renderFindHead();
  const o = findOrigin();
  if (!o) return;
  const f = S.find;
  let data;
  try {
    data = await api(`/api/live?lat=${o.lat}&lng=${o.lng}&mode=${f.mode}&limit=10&max_m=${Math.max(1500, S.prefs.max_walk_m || 700)}&hide_empty=${!!S.prefs.hide_empty}`);
  } catch { return; }
  const prevSel = f.cards[f.idx]?.sno;
  f.cards = data.stations;
  // keep the selected station selected across refreshes
  const keep = prevSel ? f.cards.findIndex((c) => c.sno === prevSel) : -1;
  checkSelectedDrop(prevSel, data.stations);
  renderFindBody(keep >= 0 ? keep : 0, silent);
}
function checkSelectedDrop(sno, cards) {
  const f = S.find;
  if (!sno) return;
  const key = f.mode === 'bike' ? 'bikes' : 'docks';
  const now = cards.find((c) => c.sno === sno);
  const before = f.prevBikes[sno];
  // also catch "hidden because it emptied"
  const nowVal = now ? now[key] : (S.prefs.hide_empty ? 0 : null);
  if (before > 0 && nowVal === 0) {
    haptic([60, 40, 60]);
    const next = cards.find((c) => c.sno !== sno && c[key] > 0);
    const cur = f.cards.find((c) => c.sno === sno) || {};
    if (next) {
      const d = cur.lat ? haversine(cur.lat, cur.lng, next.lat, next.lng) : next.distance_m;
      toast(`Station ${f.mode === 'bike' ? 'emptied' : 'filled up'}`, ` Next one ${dist(d)} ${next.cardinal}: ${next.name}`, { label: 'Go', icon: 'warning', run: () => navigate(next.lat, next.lng, next.name) });
    } else toast(`Station ${f.mode === 'bike' ? 'emptied' : 'filled up'}`, ' No alternative nearby.');
  }
  f.prevBikes = Object.fromEntries(cards.map((c) => [c.sno, c[key]]));
}
function stationCard(c, i, n) {
  const f = S.find;
  const bike = f.mode === 'bike';
  const val = bike ? c.bikes : c.docks;
  const st = status(val);
  const pred = bike ? c.pred_bikes : c.pred_docks, p = bike ? c.p_bike : c.p_dock;
  const pc = p >= 0.8 ? 'var(--good-fill)' : p >= 0.5 ? 'var(--warn-fill)' : 'var(--crit-fill)';
  const showZh = S.prefs.show_chinese !== false;
  const hereFrom = f.dest === 'here' ? 'away' : `from ${esc(placeById(f.dest)?.name || '')}`;
  const ride = S.home?.active_ride;
  return `<article class="scard" data-i="${i}" role="button" aria-label="Navigate to ${esc(c.name)}">
    <div class="head"><div style="min-width:0"><div class="nm">${esc(c.name)}</div>${showZh ? `<div class="zh">${esc(c.name_zh)}</div>` : ''}</div><div class="rank">${i + 1} of ${n}</div></div>
    <div class="main">
      <div><div class="count"><b class="num">${val}</b><span>${bike ? (val === 1 ? 'bike' : 'bikes') : (val === 1 ? 'dock' : 'docks')}</span></div>
        <div class="secondary">${bike ? `${c.docks} free docks` : `${c.bikes} bikes`} · ${c.capacity} total</div>
        <div style="margin-top:6px">${statusChip(st, bike ? (val === 0 ? 'Empty' : val <= 2 ? 'Almost empty' : 'Available') : (val === 0 ? 'Full' : val <= 2 ? 'Almost full' : 'Available'))}</div></div>
      <div class="dir"><div class="dial"><span class="card-n">N</span><span class="needle" data-bearing="${c.bearing}" style="transform:rotate(${c.bearing - (S.heading || 0)}deg)">${icon('arrow')}</span></div><div class="cd">${dist(c.distance_m)} ${c.cardinal}</div></div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="k">Walk</div><div class="v num">${icon('walk')}${Math.max(1, Math.round(c.walk_min))}<small>min</small></div></div>
      <div class="metric"><div class="k">Trend</div><div class="v trend-${c.trend}">${trendIcon(c.trend)}${tlabel(c.trend)}</div></div>
      <div class="metric"><div class="k">On arrival</div><div class="v num">${Math.round(pred)}<small>${pct(p)} ≥1</small></div><div class="pbar"><i style="width:${Math.round(p * 100)}%;background:${pc}"></i></div></div>
    </div>
    <div class="btnrow">
      <button class="btn" data-nav>${icon('location')} Navigate</button>
      ${bike && !ride ? `<button class="btn gray" data-ride="start" style="width:auto">${icon('bicycle')} Took it</button>` : ''}
      ${!bike && ride ? `<button class="btn gray" data-ride="end" style="width:auto">${icon('checkcircle')} Returned</button>` : ''}
    </div>
    <div class="foot"><span class="live ${c.age_s > 300 ? 'stale' : ''}">Updated ${ago(c.age_s)}</span><span>${dist(c.distance_m)} ${hereFrom}</span></div>
  </article>`;
}
function renderFindBody(idx = 0, silent = false) {
  const f = S.find, body = $('#find-body');
  if (!f.cards.length) {
    body.innerHTML = `<div class="empty">${icon('bicycle')}<div>No ${f.mode === 'bike' ? 'bikes' : 'docks'} within ${dist(Math.max(1500, S.prefs.max_walk_m || 700))}.</div></div>`;
    return;
  }
  const n = f.cards.length;
  const list = f.cards.map((c, i) => {
    const v = f.mode === 'bike' ? c.bikes : c.docks;
    return `<button class="cell" data-jump="${i}"><span class="status ${status(v)}">${statusIcon(status(v))}</span>
      <div class="title"><div class="t">${esc(c.name)}</div><div class="s">${dist(c.distance_m)} ${c.cardinal} · ${Math.max(1, Math.round(c.walk_min))} min · ${tlabel(c.trend)}</div></div>
      <b class="num">${v}</b>${icon('chevronright', 'chev')}</button>`;
  }).join('');
  const scrollLeft = $('#carousel')?.scrollLeft;
  body.innerHTML = `<div class="carousel" id="carousel">${f.cards.map((c, i) => stationCard(c, i, n)).join('')}</div>
    <div class="dots">${f.cards.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('')}</div>
    <div class="group-label">All nearby</div><div class="group">${list}</div>`;
  const car = $('#carousel');
  const cardW = () => car.firstElementChild.offsetWidth + 12;
  if (silent && scrollLeft != null && idx === f.idx) car.scrollLeft = scrollLeft;
  else car.scrollLeft = idx * cardW();
  f.idx = idx;
  let st;
  car.addEventListener('scroll', () => {
    clearTimeout(st);
    st = setTimeout(() => {
      const i = Math.round(car.scrollLeft / cardW());
      if (i !== f.idx) { f.idx = i; haptic([6]); $$('.dots i').forEach((d, j) => d.classList.toggle('on', j === i)); }
    }, 60);
  }, { passive: true });
  $$('.scard', body).forEach((card) => {
    const c = f.cards[+card.dataset.i];
    card.addEventListener('click', (e) => {
      const r = e.target.closest('[data-ride]');
      if (r) { e.stopPropagation(); return r.dataset.ride === 'start' ? startRide(c) : endRide(c); }
      navigate(c.lat, c.lng, c.name);
    });
  });
  $$('[data-jump]', body).forEach((b) => (b.onclick = () => {
    const i = +b.dataset.jump; car.scrollTo({ left: i * cardW(), behavior: 'smooth' });
    $('#screen-find').scrollTo({ top: 0, behavior: 'smooth' });
  }));
  rotateNeedles();
}

// ------------------------------------------------------------------ rides
async function startRide(c) {
  haptic([20, 30, 20]);
  const r = await api('/api/rides/start', { method: 'POST', body: { sno: c.sno } });
  if (S.home) S.home.active_ride = r; else S.home = { active_ride: r };
  toast('Ride started', ` From ${c.name}. Have a good ride!`, { label: 'Find dock', icon: 'bicycle', run: () => go('find', { mode: 'dock', dest: 'here' }) });
  renderFindBody(S.find.idx, true);
}
async function endRide(c) {
  haptic([20, 30, 20]);
  try {
    const r = await api('/api/rides/end', { method: 'POST', body: { sno: c?.sno || null } });
    if (S.home) S.home.active_ride = null;
    toast('Ride saved', ` ${Math.round(r.duration_min)} min · NT$${r.cost_nt}${r.distance_m ? ' · ' + dist(r.distance_m) : ''}`, { label: 'View', icon: 'checkcircle', run: () => go('rides') });
    if (S.tab === 'today') loadToday(); else renderFindBody(S.find.idx, true);
  } catch { toast('No active ride'); }
}

// ------------------------------------------------------------------ MAP
let map, mapLoaded = false, meMarker;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
async function loadMap() {
  const scr = $('#screen-map');
  if (!mapLoaded) {
    scr.insertAdjacentHTML('beforeend', `
      <div class="map-top"><div class="seg" id="mapseg"><button data-m="bike" class="on">Bikes</button><button data-m="dock">Docks</button></div></div>
      <div class="map-fab"><button id="locate" aria-label="My location">${icon('location')}</button><button id="maprefresh" aria-label="Refresh">${icon('refresh')}</button></div>
      <div class="map-legend" id="maplegend"></div>`);
    try {
      loadCss('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css');
      await loadScript('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
    } catch { $('#map').innerHTML = `<div class="empty" style="padding-top:40vh">${icon('wifi_off')}<div>Map needs a connection.</div></div>`; return; }
    startLocation();
    const c = S.loc || fallbackLoc();
    map = new maplibregl.Map({
      container: 'map', attributionControl: { compact: true },
      style: `https://basemaps.cartocdn.com/gl/${dark() ? 'dark-matter' : 'positron'}-gl-style/style.json`,
      center: [c.lng, c.lat], zoom: 15, pitchWithRotate: false,
    });
    mapLoaded = true; window.__map = map;
    S.mapMode = 'bike';
    map.on('load', () => { refreshMap(); updateMeMarker(); });
    $$('#mapseg button').forEach((b) => (b.onclick = () => { haptic([8]); S.mapMode = b.dataset.m; $$('#mapseg button').forEach((x) => x.classList.toggle('on', x === b)); refreshMap(); }));
    $('#locate').onclick = () => requestLocation((l) => map.flyTo({ center: [l.lng, l.lat], zoom: 16 }));
    $('#maprefresh').onclick = () => { haptic([10]); refreshMap(); };
    map.on('click', 'stations', (e) => openStationSheet(e.features[0].properties));
    map.on('mouseenter', 'stations', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'stations', () => (map.getCanvas().style.cursor = ''));
  } else { map.resize(); refreshMap(); }
}
async function refreshMap() {
  if (!map || !map.isStyleLoaded()) return;
  const d = await api('/api/map');
  const key = S.mapMode === 'dock' ? 4 : 3;
  const fc = { type: 'FeatureCollection', features: d.stations.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s[2], s[1]] },
    properties: { sno: s[0], lat: s[1], lng: s[2], bikes: s[3], docks: s[4], cap: s[5], name: s[6], name_zh: s[7], v: s[key] } })) };
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  if (map.getSource('st')) map.getSource('st').setData(fc);
  else {
    map.addSource('st', { type: 'geojson', data: fc });
    map.addLayer({ id: 'stations', type: 'circle', source: 'st', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 15, 9, 18, 16],
      'circle-color': ['step', ['get', 'v'], css('--crit-fill'), 1, css('--warn-fill'), 3, css('--good-fill')],
      'circle-opacity': ['case', ['==', ['get', 'v'], 0], 0, 0.95],
      'circle-stroke-color': ['case', ['==', ['get', 'v'], 0], css('--crit-fill'), dark() ? '#000' : '#fff'],
      'circle-stroke-width': ['case', ['==', ['get', 'v'], 0], 2.5, 1.5],
    } });
    map.addLayer({ id: 'labels', type: 'symbol', source: 'st', minzoom: 15, layout: { 'text-field': ['to-string', ['get', 'v']], 'text-size': 11, 'text-font': ['Open Sans Bold'], 'text-allow-overlap': true },
      paint: { 'text-color': ['case', ['==', ['get', 'v'], 0], css('--crit-fill'), '#fff'] } });
  }
  const w = S.mapMode === 'dock' ? 'docks' : 'bikes';
  $('#maplegend').innerHTML = `<span><i style="background:var(--good-fill)"></i>3+ ${w}</span><span><i style="background:var(--warn-fill)"></i>1–2 ${w}</span><span><i style="border:2px solid var(--crit-fill)"></i>No ${w}</span>`;
}
function updateMeMarker() {
  if (!map || !S.loc || S.loc.src !== 'gps') return;
  if (!meMarker) {
    const e = document.createElement('div'); e.className = 'me-dot';
    meMarker = new maplibregl.Marker({ element: e }).setLngLat([S.loc.lng, S.loc.lat]).addTo(map);
    map.jumpTo({ center: [S.loc.lng, S.loc.lat] }); // first GPS fix: center on me
  }
  else meMarker.setLngLat([S.loc.lng, S.loc.lat]);
}
async function openStationSheet(p) {
  const l = S.loc || fallbackLoc();
  const d = haversine(l.lat, l.lng, p.lat, p.lng);
  openSheet(`<div class="bar"><span style="min-width:64px"></span><h3>Station</h3><button class="r" data-close>Done</button></div>
    <div class="peek"><div style="font:700 22px var(--font-display)">${esc(p.name)}</div><div class="muted">${esc(p.name_zh)}</div>
      <div class="metrics" style="margin-top:14px"><div class="metric"><div class="k">Bikes</div><div class="v num">${p.bikes}</div></div><div class="metric"><div class="k">Docks</div><div class="v num">${p.docks}</div></div><div class="metric"><div class="k">Distance</div><div class="v num">${dist(d)}</div></div></div>
      <div style="margin-top:14px"><button class="btn" data-nav>${icon('location')} Navigate</button></div></div>
    <div class="group-label">${STATIC ? 'Last 24 hours · recorded on this phone' : 'Last 24 hours'}</div><div class="group" style="padding:12px 12px 6px"><div id="sthist"><div class="skeleton" style="height:150px"></div></div></div>
    <div class="group-label">Next 24 hours · forecast</div><div class="group" style="padding:12px 12px 6px"><div id="stfc"><div class="skeleton" style="height:150px"></div></div></div>`, async (sh) => {
    sh.querySelector('[data-close]').onclick = () => { sheetStack.length = 0; closeSheet(); };
    sh.querySelector('[data-nav]').onclick = () => navigate(p.lat, p.lng, p.name);
    const h = await api(`/api/station/${p.sno}?hours=24`);
    const box = $('#sthist');
    if (!box) return;
    const now = new Date();
    lineChart(box, { height: 150, gapMs: 15 * 60e3, xMin: new Date(+now - 24 * 3600e3), xMax: now,
      xFmt: (d) => clock(d), series: [{ name: 'Bikes', color: '--s1', points: h.points.map((x) => ({ x: new Date(x.t), y: x.bikes })) }] });
    const span = h.points.length ? (now - new Date(h.points[0].t)) / 60e3 : 0;
    box.insertAdjacentHTML('beforeend', STATIC
      ? `<p class="group-foot">${span < 120 ? `Only ${Math.max(1, Math.round(span))} min so far: ` : ''}the phone can only record while the app is open, so gaps are normal. A complete 24-hour history needs the always-on server.</p>`
      : (h.points.length < 3 ? '<p class="group-foot">History builds up as the poller runs.</p>' : ''));
    // forecast for this one station (same engine as the Future tab)
    try {
      await loadModel();
      const home = placeById('home') || S.places[0] || fallbackLoc();
      const rain = await rainForecast(home.lat, home.lng);
      const times = timeGrid().slice(0, 49);
      const fc = (await runForecast([{ sno: p.sno, bikes: +p.bikes, docks: +p.docks }], rain, times)).get(p.sno);
      const fbox = $('#stfc'); if (!fbox) return;
      if (!fc) { fbox.innerHTML = '<div class="chart-empty">No forecast for this station (not in the trip data).</div>'; return; }
      lineChart(fbox, { height: 150, xFmt: (d) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(d)}`,
        series: [{ name: 'Expected bikes', color: '--s1', area: true, points: times.map((t, k) => ({ x: t, y: Math.round(fc.mean[k] * 10) / 10 })) }] });
      const k = F.k, worst = times.reduce((a, t, i) => (riskOf(fc, i, 'bike', k) > a.r ? { r: riskOf(fc, i, 'bike', k), t } : a), { r: 0, t: null });
      fbox.insertAdjacentHTML('beforeend', `<p class="group-foot">${worst.r >= 0.3 ? `Highest risk of ≤ ${k} bikes: <b>${Math.round(worst.r * 100)}%</b> around ${worst.t.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(worst.t)}.` : `Low risk of ≤ ${k} bikes over the next 24 h.`} Details in the Future tab.</p>`);
    } catch { const fbox = $('#stfc'); if (fbox) fbox.innerHTML = '<div class="chart-empty">Forecast unavailable offline.</div>'; }
  });
}

// ------------------------------------------------------------------ INSIGHTS
async function loadInsights() {
  const el = $('#screen-insights');
  if (!S.places.length) { const pl = await api('/api/places'); S.places = pl.places; S.routes = pl.routes; }
  const ins = S.insights;
  ins.place = ins.place || S.places[0]?.id;
  el.innerHTML = `<div class="largetitle"><h1>Insights</h1></div>${offlineBanner()}
    <div class="chips" style="margin-bottom:10px">${S.places.map((p) => `<button class="chip ${p.id === ins.place ? 'on' : ''}" data-p="${esc(p.id)}">${icon(p.icon)}${esc(p.name)}</button>`).join('')}</div>
    <div class="seg" style="margin-bottom:14px"><button data-k="bike" class="${ins.kind === 'bike' ? 'on' : ''}">Bike available</button><button data-k="dock" class="${ins.kind === 'dock' ? 'on' : ''}">Dock available</button></div>
    <div id="heatbody"><div class="skeleton" style="height:200px"></div></div>`;
  $$('[data-p]', el).forEach((b) => (b.onclick = () => { ins.place = b.dataset.p; haptic([8]); loadInsights(); }));
  $$('[data-k]', el).forEach((b) => (b.onclick = () => { ins.kind = b.dataset.k; haptic([8]); loadInsights(); }));
  const d = await api(`/api/heatmap/${ins.place}?kind=${ins.kind}`);
  const days = d.days_of_data || 0, target = 28;
  const frac = Math.min(1, days / target);
  const circ = 2 * Math.PI * 18;
  const cover = `<div class="coverage"><svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--fill-2)" stroke-width="5"/>
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--blue)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circ * frac} ${circ}" transform="rotate(-90 22 22)"/></svg>
    <div class="txt"><b>${days < 1 ? `${Math.round(days * 24)} hours` : `${days.toFixed(1)} days`} of data</b><span class="muted">${frac < 1 ? `Heatmaps get reliable after ~4 weeks. Cells fill in as the poller runs.` : 'Enough history for stable patterns.'}</span></div></div>`;
  const cards = d.stations.map((s) => `<div class="heat-card"><div class="h"><div style="min-width:0"><b>${esc(s.name)}</b><span>${dist(s.distance_m)} from ${esc(d.place.name)} · now ${ins.kind === 'bike' ? s.bikes + (s.bikes === 1 ? ' bike' : ' bikes') : s.docks + (s.docks === 1 ? ' dock' : ' docks')}</span></div>
      <button class="btn small tinted" data-hist="${s.sno}">24 h</button></div><div class="hm" data-sno="${s.sno}"></div></div>`).join('');
  $('#heatbody').innerHTML = cover + (cards || '<div class="empty">No stations near this place.</div>') + heatLegend(ins.kind);
  d.stations.forEach((s) => heatmap($(`.hm[data-sno="${s.sno}"]`), { grid: s.grid, kind: ins.kind }));
  $$('[data-hist]').forEach((b) => (b.onclick = () => {
    const s = d.stations.find((x) => x.sno === b.dataset.hist);
    openStationSheet({ ...s, name_zh: s.name_zh });
  }));
}

// ------------------------------------------------------------------ RIDES
async function loadRides() {
  const el = $('#screen-rides');
  const d = await api('/api/rides');
  const st = (k, v, unit, ic) => `<div class="stat"><div class="k">${icon(ic)}${k}</div><div class="v num">${v}<small>${unit}</small></div></div>`;
  const groups = {};
  for (const r of d.rides) (groups[r.start_ts.slice(0, 10)] ||= []).push(r);
  const list = Object.entries(groups).map(([day, rs]) => `<div class="group-label">${new Date(day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</div><div class="group">${rs.map((r) => `
    <button class="cell" data-ride="${r.id}"><div class="iconbadge" style="background:var(--green)">${icon('bicycle')}</div>
      <div class="title"><div class="t">${esc(r.from_name || '?')} → ${esc(r.to_name || '?')}</div><div class="s">${clock(new Date(r.start_ts))} · ${Math.round(r.duration_min || 0)} min${r.distance_m ? ' · ' + dist(r.distance_m) : ''}${r.source !== 'app' ? ' · ' + r.source : ''}</div></div>
      <span class="val num">NT$${Math.round(r.cost_nt || 0)}</span></button>`).join('')}</div>`).join('');
  el.innerHTML = `<div class="largetitle"><h1>Rides</h1><button class="navbtn" id="addride" aria-label="Add ride">${icon('plus')}</button></div>${offlineBanner()}
    <div class="group-label" style="margin-top:4px">This week</div>
    <div class="stats">${st('Rides', d.week.count, '', 'bicycle')}${st('Time', d.week.minutes, 'min', 'clock')}${st('Distance', d.week.distance_km, 'km', 'walk')}${st('Cost', d.week.cost_nt, 'NT$', 'ticket')}</div>
    <div class="group-label">All time</div>
    <div class="group"><div class="cell"><div class="title">Rides</div><span class="val num">${d.all.count}</span></div><div class="cell"><div class="title">Total time</div><span class="val num">${d.all.minutes} min</span></div>
      <div class="cell"><div class="title">Distance (estimated)</div><span class="val num">${d.all.distance_km} km</span></div><div class="cell"><div class="title">Spent</div><span class="val num">NT$${d.all.cost_nt}</span></div></div>
    ${list || `<div class="empty">${icon('bicycle')}<div>No rides yet. Tap <b>Took it</b> on a station card in Find to start tracking, or add past rides with +.</div></div>`}
    <div class="group-label">Importing from the YouBike app</div>
    <p class="group-foot">The YouBike app has no export. Open <b>Member → Ride records</b> (騎乘紀錄) and add rides here with +, or log new rides by tapping <b>Took it</b> / <b>Returned</b> in Find.</p>`;
  $('#addride').onclick = addRideSheet;
  $$('[data-ride]', el).forEach((b) => (b.onclick = () => {
    const r = d.rides.find((x) => x.id === b.dataset.ride);
    openSheet(`<div class="bar"><span style="min-width:64px"></span><h3>Ride</h3><button class="r" data-close>Done</button></div>
      <div class="group"><div class="cell"><div class="title">From</div><span class="val">${esc(r.from_name || '–')}</span></div><div class="cell"><div class="title">To</div><span class="val">${esc(r.to_name || '–')}</span></div>
      <div class="cell"><div class="title">Started</div><span class="val">${new Date(r.start_ts).toLocaleString('en-GB')}</span></div><div class="cell"><div class="title">Duration</div><span class="val">${Math.round(r.duration_min)} min</span></div>
      <div class="cell"><div class="title">Cost</div><span class="val">NT$${r.cost_nt}</span></div></div>
      <div style="margin-top:20px"><button class="btn danger" data-del>${icon('trash')} Delete ride</button></div>`, (sh) => {
      sh.querySelector('[data-close]').onclick = () => { sheetStack.length = 0; closeSheet(); };
      sh.querySelector('[data-del]').onclick = async () => { await api(`/api/rides/${r.id}`, { method: 'DELETE' }); sheetStack.length = 0; closeSheet(); loadRides(); };
    });
  }));
}
function addRideSheet() {
  const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  openSheet(`<div class="bar"><button data-cancel>Cancel</button><h3>Add Ride</h3><button class="r" data-save>Add</button></div>
    <div class="group">
      <label class="cell"><div class="title">Date</div><input type="date" id="rdate" value="${today}" style="border:0;background:none;color:var(--label-2);text-align:right"></label>
      <label class="cell"><div class="title">Start</div><input type="time" id="rstart" value="${pad(now.getHours())}:00"></label>
      <label class="cell"><div class="title">End</div><input type="time" id="rend" value="${pad(now.getHours())}:20"></label>
    </div>
    <div class="group-label">Stations</div>
    <div class="group">
      <label class="cell"><div class="title">From</div><input type="text" id="rfrom" placeholder="Search station" list="stlist" autocomplete="off"></label>
      <label class="cell"><div class="title">To</div><input type="text" id="rto" placeholder="Search station" list="stlist" autocomplete="off"></label>
    </div><datalist id="stlist"></datalist>
    <div class="group-label">Cost (optional)</div>
    <div class="group"><label class="cell"><div class="title">NT$</div><input type="number" id="rcost" placeholder="auto"></label></div>
    <p class="group-foot">Leave cost empty to compute it from the YouBike fare table.</p>`, (sh) => {
    const found = {};
    const search = async (e) => {
      const q = e.target.value.trim(); if (q.length < 2) return;
      const l = S.loc || fallbackLoc();
      const res = await api(`/api/search?q=${encodeURIComponent(q)}&lat=${l.lat}&lng=${l.lng}`);
      res.forEach((r) => (found[r.name] = r.sno));
      $('#stlist').innerHTML = res.map((r) => `<option value="${esc(r.name)}">${esc(r.name_zh)}</option>`).join('');
    };
    $('#rfrom').oninput = search; $('#rto').oninput = search;
    sh.querySelector('[data-cancel]').onclick = () => { sheetStack.length = 0; closeSheet(); };
    sh.querySelector('[data-save]').onclick = async () => {
      const d = $('#rdate').value, a = $('#rstart').value, b = $('#rend').value;
      let end = `${d}T${b}:00`; if (b < a) { const t = new Date(`${d}T${b}:00`); t.setDate(t.getDate() + 1); end = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${b}:00`; }
      const f = $('#rfrom').value, t = $('#rto').value, c = $('#rcost').value;
      await api('/api/rides', { method: 'POST', body: { start_ts: `${d}T${a}:00`, end_ts: end, from_sno: found[f] || null, to_sno: found[t] || null, from_name: f || null, to_name: t || null, cost_nt: c ? +c : null, source: 'manual' } });
      sheetStack.length = 0; closeSheet(); haptic([20]); loadRides();
    };
  });
}

// ------------------------------------------------------------------ SETTINGS
async function openSettings() {
  const pl = await api('/api/places'); S.places = pl.places; S.routes = pl.routes;
  S.prefs = await api('/api/prefs');
  const pn = (id) => placeById(id)?.name || id;
  const wd = (ws) => (ws.length === 5 && ws.every((d) => d < 5) ? 'Weekdays' : ws.length === 7 ? 'Every day' : ws.map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(', '));
  openSheet(`<div class="bar"><span style="min-width:64px"></span><h3>Settings</h3><button class="r" data-close>Done</button></div>
    <div class="group-label">My places</div><div class="group">
      ${S.places.map((p) => `<button class="cell indent" data-place="${esc(p.id)}"><div class="iconbadge" style="background:${placeColor(p)}">${icon(p.icon)}</div><div class="title"><div class="t">${esc(p.name)}</div><div class="s">${p.radius_m} m radius · ${{ bike: 'Need bike', dock: 'Need dock', both: 'Bike + dock' }[p.mode]}</div></div>${icon('chevronright', 'chev')}</button>`).join('')}
      <button class="cell indent" data-place=""><div class="iconbadge" style="background:var(--fill-2);color:var(--blue)">${icon('plus')}</div><div class="title" style="color:var(--blue)">Add place</div></button></div>
    <div class="group-label">Usual trips</div><div class="group">
      ${S.routes.map((r) => `<button class="cell" data-route="${esc(r.id)}"><div class="title"><div class="t">${esc(pn(r.from_place))} → ${esc(pn(r.to_place))}</div><div class="s">${wd(r.weekdays)}${r.enabled ? '' : ' · off'}</div></div><span class="val num">${r.depart}</span>${icon('chevronright', 'chev')}</button>`).join('')}
      <button class="cell" data-route=""><div class="title" style="color:var(--blue)">Add trip</div></button></div>
    <p class="group-foot">Trips power the leave-by time on Today.</p>
    <div class="group-label">Preferences</div><div class="group">
      <label class="cell"><div class="title">Max walking distance</div><select id="pwalk">${[300, 500, 700, 1000, 1500].map((v) => `<option value="${v}" ${S.prefs.max_walk_m == v ? 'selected' : ''}>${v} m</option>`).join('')}</select></label>
      <label class="cell"><div class="title">Navigate with</div><select id="pmap"><option value="google" ${S.prefs.map_app !== 'apple' ? 'selected' : ''}>Google Maps</option><option value="apple" ${S.prefs.map_app === 'apple' ? 'selected' : ''}>Apple Maps</option></select></label>
      <label class="cell"><div class="title">Hide empty stations</div><input type="checkbox" class="switch" id="phide" ${S.prefs.hide_empty ? 'checked' : ''}></label>
      <label class="cell"><div class="title">Show Chinese names</div><input type="checkbox" class="switch" id="pzh" ${S.prefs.show_chinese !== false ? 'checked' : ''}></label>
      <label class="cell"><div class="title">Auto-refresh</div><select id="prefresh">${[30, 45, 60].map((v) => `<option value="${v}" ${S.prefs.auto_refresh_s == v ? 'selected' : ''}>every ${v} s</option>`).join('')}</select></label>
    </div>
    <p class="group-foot">Regular bikes only — e-bikes are ignored everywhere.</p>`, (sh) => {
    sh.querySelector('[data-close]').onclick = () => { sheetStack.length = 0; closeSheet(); if (S.tab === 'today') loadToday(); };
    $$('[data-place]', sh).forEach((b) => (b.onclick = () => editPlace(b.dataset.place)));
    $$('[data-route]', sh).forEach((b) => (b.onclick = () => editRoute(b.dataset.route)));
    const save = (k, v) => { S.prefs[k] = v; api('/api/prefs', { method: 'POST', body: { [k]: v } }); };
    $('#pwalk').onchange = (e) => save('max_walk_m', +e.target.value);
    $('#pmap').onchange = (e) => save('map_app', e.target.value);
    $('#phide').onchange = (e) => save('hide_empty', e.target.checked);
    $('#pzh').onchange = (e) => save('show_chinese', e.target.checked);
    $('#prefresh').onchange = (e) => save('auto_refresh_s', +e.target.value);
  });
}
function editPlace(id) {
  const p = id ? { ...placeById(id) } : { id: null, name: '', icon: 'mappin', lat: (S.loc || fallbackLoc()).lat, lng: (S.loc || fallbackLoc()).lng, radius_m: 500, mode: 'both' };
  openSheet(`<div class="bar"><button data-back>${id ? 'Back' : 'Cancel'}</button><h3>${id ? 'Edit Place' : 'New Place'}</h3><button class="r" data-save>Save</button></div>
    <div class="group"><label class="cell"><div class="title">Name</div><input type="text" id="pname" value="${esc(p.name)}" placeholder="e.g. Gym"></label></div>
    <div class="group-label">Icon</div><div class="group"><div class="iconpick">${PLACE_ICONS.map((ic) => `<button data-ic="${ic}" class="${p.icon === ic ? 'on' : ''}">${icon(ic)}</button>`).join('')}</div></div>
    <div class="group-label">Location</div><div class="group">
      <div class="cell"><div class="title"><div class="t num" id="pcoords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div><div class="s" id="pcsub">Stand at the place and tap the button</div></div></div>
      <button class="cell" id="usehere" style="color:var(--blue)">${icon('locationfill')}<div class="title">Use current location</div></button></div>
    <div class="group-label">Behaviour</div><div class="group">
      <label class="cell"><div class="title">Search radius</div><select id="pradius">${[200, 300, 400, 500, 600, 800, 1000].map((v) => `<option value="${v}" ${p.radius_m == v ? 'selected' : ''}>${v} m</option>`).join('')}</select></label>
      <div class="cell"><div class="title">I usually need</div><div class="seg" id="pmode" style="flex:1.3">${['bike', 'dock', 'both'].map((m) => `<button data-m="${m}" class="${p.mode === m ? 'on' : ''}">${{ bike: 'Bike', dock: 'Dock', both: 'Both' }[m]}</button>`).join('')}</div></div></div>
    ${id ? `<div style="margin-top:24px"><button class="btn danger" data-del>${icon('trash')} Delete place</button></div>` : ''}`, (sh) => {
    sh.querySelector('[data-back]').onclick = closeSheet;
    $$('[data-ic]', sh).forEach((b) => (b.onclick = () => { p.icon = b.dataset.ic; $$('[data-ic]', sh).forEach((x) => x.classList.toggle('on', x === b)); haptic([8]); }));
    $$('#pmode button', sh).forEach((b) => (b.onclick = () => { p.mode = b.dataset.m; $$('#pmode button', sh).forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#usehere').onclick = () => {
      $('#pcsub').textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition((pos) => {
        p.lat = pos.coords.latitude; p.lng = pos.coords.longitude;
        $('#pcoords').textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`; $('#pcsub').textContent = `Set from GPS (±${Math.round(pos.coords.accuracy)} m)`; haptic([20]);
      }, () => ($('#pcsub').textContent = 'Location unavailable — GPS needs HTTPS and permission'), { enableHighAccuracy: true, timeout: 15000 });
    };
    sh.querySelector('[data-save]').onclick = async () => {
      p.name = $('#pname').value.trim() || 'Place'; p.radius_m = +$('#pradius').value;
      await api('/api/places', { method: 'POST', body: p }); S.home = null; haptic([20]);
      closeSheet(); openSettings(); sheetStack.splice(0, sheetStack.length - 1);
    };
    sh.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${p.name}? Trips using it are removed too.`)) return;
      await api(`/api/places/${p.id}`, { method: 'DELETE' }); S.home = null;
      closeSheet(); openSettings(); sheetStack.splice(0, sheetStack.length - 1);
    });
  });
}
function editRoute(id) {
  const r = id ? { ...S.routes.find((x) => x.id === id) } : { id: null, from_place: S.places[0]?.id, to_place: S.places[1]?.id, weekdays: [0, 1, 2, 3, 4], depart: '08:30', enabled: true };
  const opts = (sel) => S.places.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  openSheet(`<div class="bar"><button data-back>${id ? 'Back' : 'Cancel'}</button><h3>${id ? 'Edit Trip' : 'New Trip'}</h3><button class="r" data-save>Save</button></div>
    <div class="group"><label class="cell"><div class="title">From</div><select id="rfromp">${opts(r.from_place)}</select></label>
      <label class="cell"><div class="title">To</div><select id="rtop">${opts(r.to_place)}</select></label>
      <label class="cell"><div class="title">Depart at</div><input type="time" id="rdep" value="${r.depart}"></label>
      <label class="cell"><div class="title">Enabled</div><input type="checkbox" class="switch" id="ren" ${r.enabled ? 'checked' : ''}></label></div>
    <div class="group-label">Repeat</div><div class="group"><div class="cell"><div class="weekdays">${DAYS.map((d, i) => `<button data-d="${i}" class="${r.weekdays.includes(i) ? 'on' : ''}">${d}</button>`).join('')}</div></div></div>
    ${id ? `<div style="margin-top:24px"><button class="btn danger" data-del>${icon('trash')} Delete trip</button></div>` : ''}`, (sh) => {
    sh.querySelector('[data-back]').onclick = closeSheet;
    $$('[data-d]', sh).forEach((b) => (b.onclick = () => {
      const d = +b.dataset.d; r.weekdays = r.weekdays.includes(d) ? r.weekdays.filter((x) => x !== d) : [...r.weekdays, d]; b.classList.toggle('on'); haptic([6]);
    }));
    sh.querySelector('[data-save]').onclick = async () => {
      Object.assign(r, { from_place: $('#rfromp').value, to_place: $('#rtop').value, depart: $('#rdep').value, enabled: $('#ren').checked });
      if (r.from_place === r.to_place) return toast('Pick two different places');
      await api('/api/routes', { method: 'POST', body: r }); S.home = null; haptic([20]);
      closeSheet(); openSettings(); sheetStack.splice(0, sheetStack.length - 1);
    };
    sh.querySelector('[data-del]')?.addEventListener('click', async () => {
      await api(`/api/routes/${r.id}`, { method: 'DELETE' }); S.home = null;
      closeSheet(); openSettings(); sheetStack.splice(0, sheetStack.length - 1);
    });
  });
}

// ------------------------------------------------------------------ FUTURE (36 h forecast)
const F = { mode: 'bike', idx: 0, times: null, fc: null, stations: null, rain: {}, map: null, fcGeo: null, computedAt: 0, focus: null,
  k: (() => { try { return +(localStorage.getItem('u:riskK') ?? 3); } catch { return 3; } })() }; // risk = P(≤ k left)
const dayLabel = (d) => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - t) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : new Date(d).toLocaleDateString('en-US', { weekday: 'long' });
};
const rideMin = (a, b) => Math.round(haversine(a.lat, a.lng, b.lat, b.lng) * 1.25 / 200) + 2; // ~12 km/h + docking
function upcomingTrips() {
  const out = [], now = Date.now(), end = now + 36 * 3600e3;
  for (const r of S.routes || []) {
    if (!r.enabled) continue;
    const from = placeById(r.from_place), to = placeById(r.to_place);
    if (!from || !to) continue;
    const [hh, mm] = r.depart.split(':').map(Number);
    for (let add = 0; add < 3; add++) {
      const d = new Date(); d.setDate(d.getDate() + add); d.setHours(hh, mm, 0, 0);
      if (d < now || d > end || !r.weekdays.includes((d.getDay() + 6) % 7)) continue;
      out.push({ r, from, to, at: d });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
const idxFor = (d) => Math.max(0, Math.min(STEPS, Math.round((d - F.times[0]) / (STEP_H * 3600e3))));
function pAt(sno, i, mode = F.mode) { const f = F.fc?.get(sno); return f ? 1 - riskOf(f, i, mode, F.k) : null; }
const okWord = (mode = F.mode) => `${F.k + 1}+ ${mode === 'bike' ? 'bikes' : 'free docks'}`;
const riskWord = (mode = F.mode) => `≤ ${F.k} ${mode === 'bike' ? (F.k === 1 ? 'bike' : 'bikes') : (F.k === 1 ? 'dock' : 'docks')}`;
function outlook(place, i, mode) {
  const near = F.stations.map((s) => ({ s, d: haversine(place.lat, place.lng, s.lat, s.lng) }))
    .filter((x) => x.d <= Math.max(place.radius_m, 300) && F.fc.has(x.s.sno)).sort((a, b) => a.d - b.d).slice(0, 8);
  const ps = near.map((x) => ({ ...x, p: pAt(x.s.sno, i, mode) }));
  const best = ps.reduce((a, x) => (!a || x.p - x.d / 20000 > a.p - a.d / 20000 ? x : a), null);
  const good = ps.filter((x) => x.p >= 0.7).length;
  const st = !best ? 'critical' : best.p >= 0.85 && good >= 2 ? 'good' : best.p >= 0.6 ? 'warning' : 'critical';
  return { place, best, good, n: ps.length, status: st };
}

async function loadFuture() {
  const scr = $('#screen-future');
  if (!F.map) {
    scr.innerHTML = `<div id="fmap"></div>
      <div class="map-top"><div class="seg" id="fmode"><button data-m="bike" class="on">Take a bike</button><button data-m="dock">Return a bike</button></div></div>
      <div class="fpanel" id="fpanel"><div class="fprog"><div class="spin"></div><span id="fprog">Loading forecast model…</span></div></div>`;
    $$('#fmode button').forEach((b) => (b.onclick = () => {
      haptic([8]); F.mode = b.dataset.m; $$('#fmode button').forEach((x) => x.classList.toggle('on', x === b));
      if (F.fc) { renderFuturePanel(); paintFuture(); }
    }));
    try {
      loadCss('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css');
      if (!window.maplibregl) await loadScript('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
    } catch { $('#fmap').innerHTML = `<div class="empty" style="padding-top:30vh">${icon('wifi_off')}<div>The map needs a connection.</div></div>`; }
    if (window.maplibregl) {
      const c = placeById('home') || S.loc || fallbackLoc();
      F.map = new maplibregl.Map({ container: 'fmap', attributionControl: { compact: true }, pitchWithRotate: false,
        style: `https://basemaps.cartocdn.com/gl/${dark() ? 'dark-matter' : 'positron'}-gl-style/style.json`, center: [c.lng, c.lat], zoom: 13.6 });
      window.__fmap = F.map;
      F.map.on('load', () => { F.mapReady = true; if (F.fc) paintFuture(); });
      F.map.on('click', 'fst', (e) => futureStationSheet(e.features[0].properties.sno));
    }
  } else F.map?.resize();
  if (!F.fc || Date.now() - F.computedAt > 10 * 60e3) await computeFuture();
  else { renderFuturePanel(); paintFuture(); }
}

async function computeFuture() {
  const prog = (t) => { const el = $('#fprog'); if (el) el.textContent = t; };
  try {
    prog('Loading forecast model…');
    const [, mp, pl] = await Promise.all([loadModel(), api('/api/map'), S.places.length ? null : api('/api/places')]);
    if (pl) { S.places = pl.places; S.routes = pl.routes; }
    if (!S.routes?.length) { try { const x = await api('/api/places'); S.routes = x.routes; } catch {} }
    const c = placeById('home') || S.places[0] || fallbackLoc();
    prog('Getting the rain forecast…');
    F.rain = await rainForecast(c.lat, c.lng);
    F.times = timeGrid();
    F.stations = mp.stations.map((r) => ({ sno: r[0], lat: r[1], lng: r[2], bikes: r[3], docks: r[4], cap: r[5], name: r[6], name_zh: r[7] }))
      .filter((s) => s.bikes + s.docks > 0);
    F.fc = await runForecast(F.stations, F.rain, F.times, (f) => prog(`Forecasting ${F.stations.length.toLocaleString()} stations… ${Math.round(f * 100)}%`));
    F.computedAt = Date.now();
    F.fcGeo = null;
    renderFuturePanel(); paintFuture();
  } catch (e) {
    const el = $('#fpanel'); if (el) el.innerHTML = `<div class="empty">${icon('wifi_off')}<div>Couldn't build the forecast (${esc(e.message)}).</div><button class="btn small tinted" id="fretry">Try again</button></div>`;
    $('#fretry')?.addEventListener('click', computeFuture);
  }
}

function renderFuturePanel() {
  const i = F.idx, t = F.times[i];
  const hk = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}T${String(t.getHours()).padStart(2, '0')}`;
  const rn = F.rain[hk];
  const maxMm = Math.max(1, ...F.times.map((x) => F.rain[`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T${String(x.getHours()).padStart(2, '0')}`]?.mm || 0));
  const bars = F.times.map((x, k) => {
    const mm = F.rain[`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}T${String(x.getHours()).padStart(2, '0')}`]?.mm || 0;
    return `<i class="${k === i ? 'on' : ''}" style="height:${Math.max(6, (mm / maxMm) * 100)}%;${mm < 0.1 ? 'opacity:.18' : ''}"></i>`;
  }).join('');
  const trips = upcomingTrips();
  const tripChips = trips.map((x, k) => `<button class="chip" data-trip="${k}">${icon('clock')}${esc(x.from.name)} → ${esc(x.to.name)} · ${x.at.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(x.at)}</button>`).join('');
  const rows = S.places.map((p) => {
    const o = outlook(p, i, F.mode);
    const b = o.best;
    return `<button class="cell indent" data-fplace="${esc(p.id)}"><div class="iconbadge" style="background:${placeColor(p)}">${icon(p.icon)}</div>
      <div class="title"><div class="t">${esc(p.name)} ${statusChip(o.status, o.status === 'good' ? 'Likely fine' : o.status === 'warning' ? 'Tight' : 'Unlikely')}</div>
      <div class="s">${b ? `Best: ${esc(b.s.name)} · ${Math.round(b.p * 100)}% chance of ${okWord()}` : 'No stations nearby'} · ${o.good}/${o.n} stations ≥ 70%</div></div>${icon('chevronright', 'chev')}</button>`;
  }).join('');
  const tripCard = F.trip ? (() => {
    const { from, to, at } = F.trip, arrive = new Date(+at + rideMin(from, to) * 60e3);
    const a = outlook(from, idxFor(at), 'bike'), d = outlook(to, idxFor(arrive), 'dock');
    return `<div class="tripcard"><div class="k">${icon('clock')} ${esc(from.name)} → ${esc(to.name)} · ${dayLabel(at)} ${clock(at)}</div>
      <div class="two"><div>${statusChip(a.status, 'Pick up')}<b>${a.best ? Math.round(a.best.p * 100) + '%' : '–'}</b><span>${esc(a.best?.s.name || 'no station')}</span><span>chance of ${okWord('bike')}</span></div>
      <div>${statusChip(d.status, `Return ~${clock(arrive)}`)}<b>${d.best ? Math.round(d.best.p * 100) + '%' : '–'}</b><span>${esc(d.best?.s.name || 'no station')}</span><span>chance of ${okWord('dock')}</span></div></div></div>`;
  })() : '';
  const info = modelInfo();
  $('#fpanel').innerHTML = `
    <div class="fp-grab"></div>
    <div class="fp-top"><div><div class="fp-time num">${clock(t)}</div><div class="fp-sub">${dayLabel(t)} · ${i === 0 ? 'now' : 'in ' + (i * STEP_H >= 1 ? Math.floor(i * STEP_H) + ' h' : '') + (i % 2 ? ' 30 min' : '')}</div></div>
      <div class="fp-legend"><span class="conf" id="fconf">${confLabel(i)}</span><span><i class="risk"></i>High risk: ${riskWord()}</span>${rn && rn.mm >= 0.1 ? `<span class="rainchip">${icon('umbrella')}${rn.mm.toFixed(1)} mm</span>` : ''}</div></div>
    <div class="fp-rainbars" aria-hidden="true">${bars}</div>
    <input type="range" class="fslider" id="fslider" min="0" max="${STEPS}" value="${i}" step="1" aria-label="Forecast time">
    <div class="fp-ticks"><span>Now</span><span>+12 h</span><span>+24 h</span><span>+36 h</span></div>
    <div class="fp-thresh"><span>Counts as risky at</span><div class="seg" id="fk">${[1, 3, 5].map((k) => `<button data-k="${k}" class="${F.k === k ? 'on' : ''}">≤ ${k}</button>`).join('')}</div><span>${F.mode === 'bike' ? 'bikes' : 'docks'} left</span></div>
    <div class="chips" style="margin:10px 0 4px"><button class="chip" data-jump="0">Now</button><button class="chip" data-jump="2">+1 h</button><button class="chip" data-jump="6">+3 h</button>${tripChips}</div>
    ${tripCard}
    <div class="group-label" style="margin-top:14px">My places at ${clock(t)}</div>
    <div class="group">${rows}</div>
    <p class="group-foot">Forecast = typical demand from ${esc(info?.source || 'trip records')}, adjusted for workday/holiday and the rain forecast, simulated from the live state. On held-out days the hourly demand model is ${info?.validation?.improvement_pct ?? '–'}% more accurate than a flat baseline; one hour ahead it beats “nothing changes” by ${info?.backtest ? Math.round(100 * (1 - info.backtest.brier_bike_model / info.backtest.brier_bike_persistence)) : '–'}% (Brier score, bikes). Beyond ~12 h it shows typical patterns and under-predicts chronically empty stations until a few weeks of live history are collected. A guide, not a guarantee.</p>`;
  const sl = $('#fslider');
  let raf;
  sl.oninput = () => { F.idx = +sl.value; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { paintFuture(); updateFutureHeader(); }); if (F.idx % 4 === 0) haptic([5]); };
  sl.onchange = () => renderFuturePanel();
  $$('#fk button').forEach((b) => (b.onclick = () => {
    F.k = +b.dataset.k; try { localStorage.setItem('u:riskK', String(F.k)); } catch {}
    haptic([8]); renderFuturePanel(); paintFuture();
  }));
  $$('[data-jump]', $('#fpanel')).forEach((b) => (b.onclick = () => { F.trip = null; F.idx = +b.dataset.jump; haptic([8]); renderFuturePanel(); paintFuture(); }));
  $$('[data-trip]', $('#fpanel')).forEach((b) => (b.onclick = () => {
    const x = trips[+b.dataset.trip]; F.trip = x; F.idx = idxFor(x.at); F.mode = 'bike';
    $$('#fmode button').forEach((y) => y.classList.toggle('on', y.dataset.m === 'bike'));
    haptic([10]); renderFuturePanel(); paintFuture();
    F.map?.flyTo({ center: [x.from.lng, x.from.lat], zoom: 15 });
  }));
  $$('[data-fplace]', $('#fpanel')).forEach((b) => (b.onclick = () => { const p = placeById(b.dataset.fplace); F.map?.flyTo({ center: [p.lng, p.lat], zoom: 15.5 }); $('#fpanel').scrollTo({ top: 0, behavior: 'smooth' }); }));
}
function confLabel(i) {
  const h = i * STEP_H;
  return h <= 3 ? '<b class="c-hi">●●●</b> High confidence' : h <= 12 ? '<b class="c-mid">●●○</b> Medium confidence' : '<b class="c-lo">●○○</b> Typical pattern';
}
function updateFutureHeader() {
  const t = F.times[F.idx];
  const el = $('.fp-time'); if (el) el.textContent = clock(t);
  const sub = $('.fp-sub'); if (sub) sub.textContent = `${dayLabel(t)} · ${F.idx === 0 ? 'now' : 'in ' + (F.idx * STEP_H >= 1 ? Math.floor(F.idx * STEP_H) + ' h' : '') + (F.idx % 2 ? ' 30 min' : '')}`;
  $$('.fp-rainbars i').forEach((b, k) => b.classList.toggle('on', k === F.idx));
  const c = $('#fconf'); if (c) c.innerHTML = confLabel(F.idx);
}

function paintFuture() {
  const m = F.map;
  if (!m || !F.mapReady || !F.fc) return;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  if (!F.fcGeo) F.fcGeo = { type: 'FeatureCollection', features: F.stations.filter((s) => F.fc.has(s.sno)).map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { sno: s.sno } })) };
  for (const f of F.fcGeo.features) {
    const fc = F.fc.get(f.properties.sno), p = 1 - riskOf(fc, F.idx, F.mode, F.k);
    const v = F.mode === 'bike' ? fc.mean[F.idx] : fc.cap - fc.mean[F.idx];
    f.properties.p = p; f.properties.risk = 1 - p; f.properties.v = Math.round(v);
  }
  if (m.getSource('ff')) { m.getSource('ff').setData(F.fcGeo); return; }
  m.addSource('ff', { type: 'geojson', data: F.fcGeo });
  m.addLayer({ id: 'frisk', type: 'heatmap', source: 'ff', filter: ['>', ['get', 'risk'], 0.3], paint: {
    'heatmap-weight': ['interpolate', ['linear'], ['get', 'risk'], 0.3, 0, 1, 1],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 1.6],
    'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 11, 10, 14, 30, 17, 120],
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,59,48,0)', 0.25, 'rgba(255,90,60,0.18)', 0.55, 'rgba(255,59,48,0.34)', 1, 'rgba(230,30,30,0.5)'],
    'heatmap-opacity': 0.9 } });
  m.addLayer({ id: 'fst', type: 'circle', source: 'ff', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 6, 17, 13],
    'circle-color': ['step', ['get', 'p'], css('--crit-fill'), 0.5, css('--warn-fill'), 0.8, css('--good-fill')],
    'circle-stroke-width': 1.2, 'circle-stroke-color': dark() ? '#000' : '#fff' } });
  m.addLayer({ id: 'flabel', type: 'symbol', source: 'ff', minzoom: 15, layout: { 'text-field': ['to-string', ['get', 'v']], 'text-size': 10, 'text-font': ['Open Sans Bold'], 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' } });
}

async function futureStationSheet(sno) {
  const s = F.stations.find((x) => x.sno === sno), f = F.fc.get(sno);
  if (!s || !f) return;
  const bike = F.mode === 'bike', i = F.idx;
  openSheet(`<div class="bar"><span style="min-width:64px"></span><h3>Forecast</h3><button class="r" data-close>Done</button></div>
    <div class="peek"><div style="font:700 21px var(--font-display)">${esc(s.name)}</div><div class="muted">${esc(s.name_zh)}</div>
      <div class="metrics" style="margin-top:14px">
        <div class="metric"><div class="k">Now</div><div class="v num">${bike ? s.bikes : s.docks}<small>${bike ? 'bikes' : 'docks'}</small></div></div>
        <div class="metric"><div class="k">At ${clock(F.times[i])}</div><div class="v num">${Math.round(bike ? f.mean[i] : f.cap - f.mean[i])}<small>expected</small></div></div>
        <div class="metric"><div class="k">Risk ${riskWord()}</div><div class="v num">${Math.round(riskOf(f, i, F.mode, F.k) * 100)}<small>%</small></div></div></div>
      <div style="margin-top:14px"><button class="btn" data-nav>${icon('location')} Navigate</button></div></div>
    <div class="group-label">Risk of finding ${riskWord()} · next 36 h</div><div class="group" style="padding:12px 12px 6px"><div id="fch1"></div></div>
    <div class="group-label">Expected ${bike ? 'bikes' : 'free docks'}</div><div class="group" style="padding:12px 12px 6px"><div id="fch2"></div></div>`, (sh) => {
    sh.querySelector('[data-close]').onclick = () => { sheetStack.length = 0; closeSheet(); };
    sh.querySelector('[data-nav]').onclick = () => navigate(s.lat, s.lng, s.name);
    const mk = [{ x: F.times[i], color: '--blue' }];
    const xf = (d) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(d)}`;
    lineChart($('#fch1'), { height: 140, yMax: 100, unit: '%', xFmt: xf, markers: mk, series: [{ name: 'Risk', color: '--s2', area: true, points: F.times.map((t, k) => ({ x: t, y: Math.round(riskOf(f, k, F.mode, F.k) * 100) })) }] });
    lineChart($('#fch2'), { height: 140, xFmt: xf, markers: mk, series: [{ name: bike ? 'Bikes' : 'Docks', color: '--s1', points: F.times.map((t, k) => ({ x: t, y: Math.round((bike ? f.mean[k] : f.cap - f.mean[k]) * 10) / 10 })) }] });
  });
}

// ------------------------------------------------------------------ lock screen
function showLock() {
  if (S.tab === 'lock') return;
  S.tab = 'lock';
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === 'screen-lock'));
  $('#tabbar').classList.add('hidden');
  $('#screen-lock').innerHTML = `<div class="lock"><img class="logo" src="/app/icons/icon-192.png" alt=""><h1 style="margin:0;font:700 28px var(--font-display)">YouBike Optimizer</h1>
    <p class="muted" style="margin:0">Enter your access key. It is printed when the server starts and stored in <code>.env</code> as UBIKE_KEY.</p>
    <input id="keyin" placeholder="Access key" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn" id="unlock">Unlock</button></div>`;
  $('#unlock').onclick = async () => {
    const r = await fetch('/api/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: $('#keyin').value }) });
    if (r.ok) { haptic([20]); location.hash = '#today'; location.reload(); } else { haptic([40, 40, 40]); $('#keyin').value = ''; $('#keyin').placeholder = 'Wrong key — try again'; }
  };
}

window.addEventListener('hashchange', () => {
  if (SETUP) return;
  const [tab, q] = location.hash.slice(1).split('?');
  if (TABS.some((t) => t.id === tab) || tab === 'insights') go(tab, Object.fromEntries(new URLSearchParams(q || '')));
});

// ------------------------------------------------------------------ boot
(async function boot() {
  renderTabbar();
  if (localStorage.getItem('compass') === '1' && !(typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission)) enableCompass();
  const sm = location.hash.match(/setup=([A-Za-z0-9_-]+)/);
  if (STATIC && sm) { SETUP = sm[1]; importSetup(SETUP); }
  const [tab, q] = SETUP ? ['today', ''] : (location.hash.slice(1) || 'today').split('?');
  const params = Object.fromEntries(new URLSearchParams(q || ''));
  try { const pl = await api('/api/places'); S.places = pl.places; S.routes = pl.routes; S.prefs = await api('/api/prefs'); } catch (e) { if (e.message === 'locked') return; }
  go(TABS.some((t) => t.id === tab) ? tab : 'today', params);
  if ('serviceWorker' in navigator) {
    // When a new version activates, reload once so it's visible right away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/', updateViaCache: 'none' }).then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }
})();
