/*
 * Service Worker：离线可用 + 自动更新。
 *
 * VERSION 会在 GitHub Actions 部署时被替换成当次提交的 SHA，
 * 所以每次推代码都会生成一个新的 SW，浏览器检测到变化就自动装新版、
 * 装好后页面自动刷新（见 app.js 的 registerServiceWorker）。
 */
const VERSION = '__BUILD_ID__';
const CACHE = 'us-routine-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/styles.css',
  './assets/icon.svg',
  './js/app-config.js',
  './js/util.js',
  './js/hours.js',
  './js/model.js',
  './js/config.js',
  './js/data.js',
  './js/store.js',
  './js/schedule.js',
  './js/maps.js',
  './js/maps-google.js',
  './js/maps-osm.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './js/sync.js',
  './js/dragsort.js',
  './js/app.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).catch(function (err) {
        console.warn('预缓存部分失败（不影响使用）', err);
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.startsWith('us-routine-') && k !== CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域请求（Google Maps、Firebase）一律直连，不进缓存
  if (url.origin !== location.origin) return;

  // 页面导航：优先拿新的，拿不到再用缓存（保证联网时永远是最新版）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || new Response('离线且没有缓存', { status: 503 });
        });
      })
    );
    return;
  }

  // 静态资源：先给缓存（快），同时后台更新（下次就是新的）
  event.respondWith(
    caches.match(req).then(function (hit) {
      const network = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
