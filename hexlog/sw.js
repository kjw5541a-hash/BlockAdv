/* 앱 껍데기는 설치할 때 통째로 받아 두고, 지도 타일은 한 번 본 것을 캐시에 남겨
   같은 곳을 다시 볼 때는 인터넷 없이도 뜨게 한다. */

const SHELL_CACHE = 'hexlog-shell-v1';
const TILE_CACHE = 'hexlog-tiles-v1';
const TILE_LIMIT = 3000;          // 캐시에 남겨 둘 타일 개수 상한
const TILE_EVICT = 500;           // 상한을 넘으면 오래된 것부터 이만큼 지운다
const TILE_HOST = 'tiles.openfreemap.org';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/h3-js.umd.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== SHELL_CACHE && n !== TILE_CACHE).map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.hostname === TILE_HOST) {
    e.respondWith(tileFirstFromCache(e.request));
  } else if (url.origin === self.location.origin) {
    e.respondWith(shellCacheFirst(e.request));
  }
});

/* 앱 껍데기: 캐시에 있으면 바로 주고, 없으면 받아서 캐시에 넣는다. */
async function shellCacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) (await caches.open(SHELL_CACHE)).put(request, res.clone());
  return res;
}

/* 타일: 캐시가 있으면 즉시 쓰고 뒤에서 조용히 갱신한다. 없으면 받아서 캐시에 넣는다. */
async function tileFirstFromCache(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone()).then(() => trimTiles(cache));
      return res;
    })
    .catch(() => null);

  if (hit) return hit;
  const res = await network;
  return res || Response.error();
}

/* Cache API는 넣은 순서대로 키를 돌려주므로, 앞쪽부터 지우면 오래된 것부터 빠진다. */
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, TILE_EVICT).map((k) => cache.delete(k)));
}
