// 離線快取：App 本體可離線開啟；搜尋與封面仍需網路
const CACHE = 'heard-v85';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'strokes.js', 'manifest.webmanifest', 'icon.svg', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // 網路優先，失敗才用快取（確保更新能立即看到）
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request)));
  } else if (url.hostname.endsWith('scdn.co') || url.hostname.endsWith('mzstatic.com')) {
    // 封面圖：快取優先，已聽過的專輯離線也看得到封面
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
    })));
  }
});
