// Service worker: the app shell works offline; chart tiles are cached as you browse.
const SHELL = 'vt-shell-v2';
const TILES = 'vt-tiles-v1';
const MAX_TILES = 600;
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'feed.js', 'ais.js', 'geo.js', 'manifest.webmanifest', 'icon.svg'];
const CDN_FILES = ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(async (c) => {
    await c.addAll(SHELL_FILES);
    await Promise.all(CDN_FILES.map((u) => c.add(u).catch(() => {}))); // best effort
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isTile = (url) => /server\.arcgisonline\.com|tiles\.openseamap\.org/.test(url.host);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) {
    // Cache first, fill in the background.
    e.respondWith(caches.open(TILES).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then(async (res) => {
        if (res.ok || res.type === 'opaque') {
          await cache.put(req, res.clone());
          const keys = await cache.keys();
          if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // App shell and fonts: network first, cache as fallback so updates arrive.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com|unpkg\.com/.test(url.host))) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
