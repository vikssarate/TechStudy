/* sw.techstudy.js — TechStudy Notes (SQLite + IndexedDB)
   - Precaches core assets for offline use
   - Network-first for HTML (fresh deploys)
   - Cache-first (stale-while-revalidate) for static assets (js/wasm/css/img)
   - Same-origin GET requests only; ignores blob: and cross-origin (e.g., CouchDB)
   - Navigation Preload for faster first paint
   - Supports "skipWaiting" via postMessage
   - + Google Drive PDF endpoint: /drivepdf/:id → 4 MB tiles cached in PouchDB
*/

const APP_NS = 'techstudy';
const VERSION = 'v4'; // ↑ bump version
const CACHE_NAME = `study-notes-${APP_NS}-${VERSION}`;

// ---- Google Drive chunking config ----
const TILE_SIZE = 4 * 1024 * 1024;          // 4 MB tiles
const CHUNK_DB_NAME = 'pdf-chunks';         // local tile DB (can be replicated to CouchDB)
const DRIVE_API_KEY = 'YOUR_GOOGLE_API_KEY';// restrict to your domain + Drive API
const DRIVE_PROXY = ''; // optional: e.g., 'https://driveproxy.techstudy.me?id='
                        // If DRIVE_API_KEY is empty, code will use DRIVE_PROXY?id=<fileId>

// PouchDB in SW (for tile cache). If not present, we still stream (no offline cache).
let TileDB = null;
try { importScripts('/lib/pouchdb.min.js'); TileDB = new self.PouchDB(CHUNK_DB_NAME); } catch (_) { /* optional */ }

// Precache core app files (add PouchDB so SW installs cleanly offline)
const CORE_ASSETS = [
  './',
  './index.html',
  './lib/sqljs/sql-wasm.js',
  './lib/sqljs/sql-wasm.wasm',
  '/lib/pouchdb.min.js', // ← add this file to your repo
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
  if (url.origin !== self.location.origin) return null; // same-origin only
  url.searchParams.delete('v');
  return new Request(url.pathname + url.search, {
    method: 'GET',
    headers: request.headers,
    mode: 'same-origin',
    credentials: 'same-origin',
  });
}

// ---- Google Drive helpers ----
function driveUpstreamURL(fileId) {
  if (DRIVE_API_KEY && DRIVE_API_KEY !== 'YOUR_GOOGLE_API_KEY') {
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${DRIVE_API_KEY}`;
  }
  if (DRIVE_PROXY) return `${DRIVE_PROXY}${encodeURIComponent(fileId)}`;
  // Fallback: API without key (only works for some public files; recommend proxy/key)
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}

async function getTotalSize(upstream) {
  // Try HEAD first
  try {
    const head = await fetch(upstream, { method: 'HEAD' });
    const len = +head.headers.get('Content-Length');
    if (len > 0) return len;
  } catch {}
  // Fallback: probe 0-0
  try {
    const probe = await fetch(upstream, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers.get('Content-Range'); // "bytes 0-0/12345"
    if (cr) return parseInt(cr.split('/')[1], 10);
  } catch {}
  return 0;
}

async function handleDrivePdf(req, url) {
  const fileId = url.pathname.split('/').pop();
  const upstream = driveUpstreamURL(fileId);
  const range = req.headers.get('range');

  // If no Range (rare with PDF.js), pass through
  if (!range) return fetch(upstream);

  const totalSize = await getTotalSize(upstream);
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  let start = parseInt(m?.[1] ?? '0', 10);
  const requestedEnd = m?.[2] ? parseInt(m[2], 10) : Math.min(start + TILE_SIZE - 1, Math.max(0, totalSize - 1));

  // We serve exactly one 4MB tile per response (PDF.js will ask for the rest)
  const tileIndex = Math.floor(start / TILE_SIZE);
  const tileStart = tileIndex * TILE_SIZE;
  const tileEnd = totalSize ? Math.min(tileStart + TILE_SIZE - 1, totalSize - 1) : tileStart + TILE_SIZE - 1;
  const end = Math.min(tileEnd, requestedEnd);

  let tileBlob = null;

  // Try local tile cache
  if (TileDB) {
    const docId = `pdf:${fileId}:chunk:${String(tileIndex).padStart(6, '0')}`;
    try {
      tileBlob = await TileDB.getAttachment(docId, 'bin');
    } catch {}
    // Cache miss → fetch from Drive and store
    if (!tileBlob) {
      const resp = await fetch(upstream, { headers: { Range: `bytes=${tileStart}-${tileEnd}` } });
      const buf = await resp.arrayBuffer();
      tileBlob = new Blob([buf], { type: 'application/octet-stream' });
      // store (ignore races)
      try {
        await TileDB.put({
          _id: docId,
          fileId, tileIndex, tileStart, tileEnd, chunkSize: TILE_SIZE,
          _attachments: { bin: { content_type: 'application/octet-stream', data: tileBlob } }
        });
      } catch {}
    }
  } else {
    // No PouchDB available in SW → just stream directly (no offline cache)
    const resp = await fetch(upstream, { headers: { Range: `bytes=${tileStart}-${tileEnd}` } });
    const buf = await resp.arrayBuffer();
    tileBlob = new Blob([buf], { type: 'application/octet-stream' });
  }

  const offset = start - tileStart;
  const slice = tileBlob.slice(offset, offset + (end - start + 1), 'application/pdf');

  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${totalSize || '*'}`,
      'Content-Length': String(slice.size)
    }
  });
}

// --- Fetch strategy (HTML/network-first; assets/SWR) + Drive/RANGE handling ---
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only same-origin GET
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'https:' && url.origin !== 'http://localhost') return;
  if (url.href.startsWith('blob:')) return;

  // 0) Google Drive virtual endpoint
  if (url.pathname.startsWith('/drivepdf/')) {
    event.respondWith(handleDrivePdf(req, url));
    return;
  }

  // 1) Preserve streaming for any other Range requests (don’t interfere)
  if (req.headers.has('range')) {
    event.respondWith(fetch(req));
    return;
  }

  // 2) HTML (navigations/documents): network-first with preload fallback
  const isNavigation = req.mode === 'navigate' ||
    req.destination === 'document' ||
    req.headers.get('accept')?.includes('text/html');

  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) {
          const key = cacheKeyFor(req);
          if (key) caches.open(CACHE_NAME).then((c) => c.put(key, preload.clone()));
          return preload;
        }
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

  // 3) Static assets (js/wasm/css/img): cache-first (stale-while-revalidate)
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
