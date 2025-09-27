/* Simple cache-first SW for v2 */
const CACHE_NAME = 'attendance-v2-cache-v12';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './src/main.js',
  './src/db.js',
  './src/router.js',
  './assets/manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  'https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.min.js',
  'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js',
  'https://cdn.jsdelivr.net/npm/dayjs@1/plugin/utc.js',
  'https://cdn.jsdelivr.net/npm/dayjs@1/plugin/timezone.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
