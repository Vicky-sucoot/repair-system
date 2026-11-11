'use strict';

// 以網站路徑區隔快取，避免清除同一 GitHub Pages 網域上的其他應用程式。
const CACHE_PREFIX = `repair-pwa-${new URL(self.registration.scope).pathname}-`;
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const ASSETS = ['offline.html', 'style.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const assetURLs = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
const offlineURL = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll([...assetURLs])));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  // 不處理跨站 Supabase/CDN、任何寫入、文件下載或非白名單資源。
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const home = new URL('index.html', self.registration.scope);
  if (request.mode === 'navigate' && (url.pathname === home.pathname || url.href === self.registration.scope)) {
    event.respondWith(fetch(request).catch(() => caches.match(offlineURL)));
  } else if (assetURLs.has(url.href)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return caches.match(request);
      }
    })());
  }
});
