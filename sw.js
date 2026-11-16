'use strict';

// 以網站路徑區隔快取，避免影響同一 GitHub Pages 網域上的其他網站。
const CACHE_PREFIX = `dca-pwa-${new URL(self.registration.scope).pathname}-`;
const CACHE_NAME = `${CACHE_PREFIX}v9`;
const ASSETS = ['./', 'index.html', 'style.css', 'pwa.js', 'manifest.webmanifest',
  'src/app.js', 'src/dca.js', 'src/chart.js', 'data/prices.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const assetURLs = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  // 個別快取，資料檔尚未產生時不影響安裝。
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.all([...assetURLs].map(url => cache.add(url).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
// 網路優先：有網路時永遠取得最新版本與股價，離線時才使用快取。
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  if (!assetURLs.has(url.href)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(url.href, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(url.href)) || Response.error();
    }
  })());
});
