/* sw.techstudy.js – Techstudy Notes (SQLite + IndexedDB)
   - Precaches core assets for offline use
   - Network-first for HTML (fresh deploys)
   - Cache-first for static assets (js/wasm/css/img)
   - Same-origin GET requests only
*/

const APP_NS = 'techstudy';          // ← unique namespace for this app
const CACHE_NAME = `study-notes-${APP_NS}-v2`;

const CORE_ASSETS = [
  './',
  './index.html',
  './lib/sqljs/sql-wasm.js',
  './lib/sqljs/sql-wasm.wasm'
];

// --- Install: pre-cache core assets ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {}) // ignore if offline on first install
  );
});

// --- Activate: clean old caches for THIS namespace only ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_NAME && k.startsWith(`study-notes-${APP_NS}-`))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Utility: normalize cache key (strip ?v= cache busters)
function cacheKeyFor(request) {
  const url = new URL(request.url);
  // same-origin only
  if (url.origin !== self.location.origin) return null;
  url.searchParams.delete('v');
  return new Request(url.pathname + url.search, {
    method: 'GET',
    headers: request.headers,
    mode: 'same-origin',
    credentials: 'same-origin',
  });
}

// --- Fetch strategy ---
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'https:' && url.origin !== 'http://localhost') return;
  if (url.href.startsWith('blob:')) return;

  // HTML: network-first (fallback to cache)
  const isHTML =
    req.destination === 'document' ||
    req.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const copy = fresh.clone();
        const key = cacheKeyFor(req);
        if (key) caches.open(CACHE_NAME).then((c) => c.put(key, copy));
        return fresh;
      } catch (_) {
        const cached = await caches.match(cacheKeyFor(req) || req);
        return cached || caches.match('./index.html');
      }
    })());
    return;
  }

  // Static assets (js/wasm/css/img): cache-first with background refresh
  const key = cacheKeyFor(req);
  if (!key) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    const networkPromise = fetch(req)
      .then((res) => {
        // store/update in cache
        cache.put(key, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => cached);

    return cached || networkPromise;
  })());
});
