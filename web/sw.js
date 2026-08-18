/* Halo — service worker. Cache-first app shell so the client opens
   instantly and works offline (calls still need a network/camera). */

const CACHE = 'halo-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/call.css',
  './js/app.js',
  './js/config.js',
  './js/rtc.js',
  './js/state.js',
  './js/identity.js',
  './js/ui.js',
  './js/media.js',
  './js/pipeline.js',
  './js/filters.js',
  './js/overlays.js',
  './js/participants.js',
  './js/inbox.js',
  './js/gifbank.js',
  './js/gif-encoder.js',
  './js/windows.js',
  './js/zoom.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only handle same-origin app-shell requests; let everything else pass through.
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
