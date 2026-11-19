// Offline: app shell is cache-first with background refresh; API data is cached
// by the app itself (localStorage) so screens show last known data + timestamp.
const SHELL = 'ubike-shell-v6';
const FILES = ['/app/', '/app/app.css', '/app/app.js', '/shared/tokens.css', '/shared/icons.js', '/shared/charts.js', '/app/local-api.js', '/app/forecast.js', '/app/model.json',
  '/app/icons/icon-192.png', '/app/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.search.includes('key=')) return;
  // Network first (so updates show up on the next open), cache only when offline/slow.
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    const timeout = new Promise((res) => setTimeout(res, 3500));
    try {
      const r = await Promise.race([net, timeout]);
      if (r) return r;
    } catch {}
    const hit = await c.match(e.request, { ignoreSearch: true });
    return hit || net;
  }));
});
