/* sw.techstudy.js — TechStudy Notes (SQLite + IndexedDB)
   - Precaches core assets for offline use
   - Network-first for HTML (fresh deploys)
   - Cache-first (stale-while-revalidate) for static assets (js/wasm/css/img)
   - Same-origin GET requests only; ignores blob: and cross-origin (e.g., CouchDB)
   - Navigation Preload for faster first paint
   - Supports "skipWaiting" via postMessage
*/

const APP_NS = 'techstudy';
const VERSION = 'v3';
const CACHE_NAME = `study-notes-${APP_NS}-${VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './lib/sqljs/sql-wasm.js',
  './lib/sqljs/sql-wasm.wasm',
  // add more if you add them later:
  // './favicon.ico',
  // './manifest.webmanifest',
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

// --- Activate: clean old caches for THIS namespace only + enable nav preload ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_NAME && k.startsWith(`study-notes-${APP_NS}-`))
        .map((k) => caches.delete(k))
    );
    // Speed up navigations if supported
    try { await self.registration.navigationPreload?.enable(); } catch(_) {}
    await self.clients.claim();
  })());
});

// Allow page to trigger immediate activation
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Utility: normalize cache key (strip ?v= cache busters)
function cacheKeyFor(request) {
  const url = new URL(request.url);
  // same-origin only
  if (url.origin !== self.location.origin) return null;
  url.searchParams.delete('v');
  // Keep hash for SPA routes? Not needed for real files.
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

  // HTML (navigations/documents): network-first with preload fallback
  const isNavigation = req.mode === 'navigate' ||
    req.destination === 'document' ||
    req.headers.get('accept')?.includes('text/html');

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        // Use navigation preload if available (already started by browser)
        const preload = await event.preloadResponse;
        if (preload) {
          // Refresh cache in background
          const key = cacheKeyFor(req);
          if (key) caches.open(CACHE_NAME).then((c) => c.put(key, preload.clone()));
          return preload;
        }
        // Fresh network fetch
        const fresh = await fetch(req);
        const copy = fresh.clone();
        const key = cacheKeyFor(req);
        if (key) caches.open(CACHE_NAME).then((c) => c.put(key, copy));
        return fresh;
      } catch (_) {
        // Offline fallback to cached page or app shell
        const cached = await caches.match(cacheKeyFor(req) || req);
        return cached || caches.match('./index.html');
      }
    })());
    return;
  }

  // Static assets (js/wasm/css/img): cache-first (stale-while-revalidate)
  const key = cacheKeyFor(req);
  if (!key) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    const networkPromise = fetch(req)
      .then((res) => {
        cache.put(key, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => cached);

    return cached || networkPromise;
  })());
});
