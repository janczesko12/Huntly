const CACHE_NAME = 'huntly-pwa-v26-full-viewport-width';
const APP_SHELL_PATHS = ['./', './index.html', './style.css', './config.js', './app.js', './manifest.webmanifest', './icon.svg', './icon.jpg'];
const scopedUrl = function (path) { return new URL(path, self.registration.scope).href; };
const APP_SHELL = APP_SHELL_PATHS.map(scopedUrl);

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(APP_SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE_NAME; }).map(function (key) { return caches.delete(key); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.respondWith(fetch(request).then(function (response) {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      return cached || (request.mode === 'navigate' ? caches.match(scopedUrl('./index.html')) : Response.error());
    });
  }));
});
