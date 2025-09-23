/* sw.techstudy.js — TechStudy Notes (SQLite + IndexedDB)
   - Precaches core assets for offline use
   - Network-first for HTML (fresh deploys)
   - Cache-first (stale-while-revalidate) for static assets (js/wasm/css/img)
   - Same-origin GET requests only; ignores blob: and cross-origin (e.g., CouchDB)
   - Navigation Preload for faster first paint
   - Supports "skipWaiting" via postMessage
   - + Google Drive PDF endpoint: <scope>/drivepdf/:id → 4 MB tiles cached in PouchDB (when present)
*/

const APP_NS = 'techstudy';
const VERSION = 'v8'; // bump when you change the SW
const CACHE_NAME = `study-notes-${APP_NS}-${VERSION}`;

// Scope-aware base path (works for GitHub Pages project sites too)
const SCOPE_PATH = new URL(self.registration?.scope || self.location.href).pathname.replace(/\/+$/, '') + '/';

// ---- Google Drive chunking config ----
const TILE_SIZE = 4 * 1024 * 1024;          // 4 MB tiles
const CHUNK_DB_NAME = 'pdf-chunks';
const DRIVE_API_KEY = 'YOUR_GOOGLE_API_KEY';  // <- set this (restricted) for best results
const DRIVE_PROXY = ''; // optional: e.g., 'https://driveproxy.techstudy.me?id='

// Try to enable PouchDB tile cache (optional)
let TileDB = null;
try { importScripts('./lib/pouchdb.min.js'); TileDB = new self.PouchDB(CHUNK_DB_NAME); } catch (_) { /* tile cache disabled */ }

// Precache core app files (paths are relative to SW file)
const CORE_ASSETS = [
  './',
  './index.html',
  './lib/sqljs/sql-wasm.js',
  './lib/sqljs/sql-wasm.wasm',
  './lib/pouchdb.min.js', // ok if missing; install continues
];

// --- Install: precache ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(()=>{})
      .then(() => self.skipWaiting())
  );
});

// --- Activate: cleanup + nav preload ---
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

/* -------------------- Google Drive helpers -------------------- */

function driveCandidates(fileId) {
  const withKey = DRIVE_API_KEY && DRIVE_API_KEY !== 'YOUR_GOOGLE_API_KEY'
    ? `&key=${encodeURIComponent(DRIVE_API_KEY)}`
    : '';

  // Try Drive v3 (CORS), then fallback public endpoints (may or may not CORS).
  // We only *read bytes* from endpoints that actually give us CORS.
  return [
    { url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media${withKey}`, cors: true },
    // Fallbacks (best-effort). If these don’t give CORS we’ll stream without caching.
    { url: `https://drive.google.com/uc?export=download&id=${fileId}`, cors: false },
    { url: `https://lh3.googleusercontent.com/d/${fileId}`, cors: false },
  ];
}

async function getTotalSize(upstreamUrl) {
  try {
    const head = await fetch(upstreamUrl, { method: 'HEAD', redirect: 'follow' });
    const len = +head.headers.get('Content-Length');
    if (len > 0) return len;
  } catch {}
  try {
    const probe = await fetch(upstreamUrl, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    const cr = probe.headers.get('Content-Range'); // "bytes 0-0/12345"
    if (cr) return parseInt(cr.split('/')[1], 10);
  } catch {}
  return 0; // unknown
}

async function fetchTile(upstreamUrl, start, end, allowReadBytes) {
  const resp = await fetch(upstreamUrl, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });

  // If CORS is allowed we can read bytes for caching/slicing.
  if (allowReadBytes && resp.ok) {
    const buf = await resp.arrayBuffer();
    return new Blob([buf], { type: 'application/octet-stream' });
  }

  // Otherwise return the whole Response so we can pass it through.
  return resp; // may be opaque; handled by caller
}

async function handleDrivePdf(req, url) {
  // Match <scope>/drivepdf/<id>
  const prefix = SCOPE_PATH + 'drivepdf/';
  const fileId = url.pathname.slice(prefix.length).split('/')[0];

  const cands = driveCandidates(fileId);

  // Prefer a CORS-capable upstream for chunking; fallback to pass-through
  let upstream = cands[0].url;
  let allowRead = cands[0].cors;

  // If you didn’t set an API key, try fallbacks
  if (DRIVE_API_KEY === 'YOUR_GOOGLE_API_KEY' || !DRIVE_API_KEY) {
    // We’ll still try v3 first (sometimes works even w/out key for fully public files),
    // but if HEAD/probe fails we’ll pass-through from uc/lh3.
  }

  const range = req.headers.get('range');

  // If no Range (rare with pdf.js), pass through best upstream
  if (!range) {
    // Pass-through (no caching)
    return fetch(upstream, { redirect: 'follow' });
  }

  // Figure out total size from the best candidate that responds
  let totalSize = await getTotalSize(upstream);

  if (!totalSize) {
    // Try other candidates to discover size
    for (let i = 1; i < cands.length && !totalSize; i++) {
      try {
        const size = await getTotalSize(cands[i].url);
        if (size) {
          upstream = cands[i].url;
          allowRead = cands[i].cors;
          totalSize = size;
          break;
        }
      } catch {}
    }
  }

  // Parse requested range
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  let start = parseInt(m?.[1] ?? '0', 10);
  const requestedEnd = m?.[2] ? parseInt(m[2], 10) : start + TILE_SIZE - 1;

  // Serve exactly one tile so pdf.js will keep asking sequentially
  const tileIndex = Math.floor(start / TILE_SIZE);
  const tileStart = tileIndex * TILE_SIZE;
  const tileEnd = totalSize ? Math.min(tileStart + TILE_SIZE - 1, totalSize - 1) : (tileStart + TILE_SIZE - 1);
  const end = Math.min(tileEnd, requestedEnd);

  // Try local PouchDB tile cache
  if (TileDB && allowRead) {
    const docId = `pdf:${fileId}:chunk:${String(tileIndex).padStart(6, '0')}`;

    try {
      const cached = await TileDB.getAttachment(docId, 'bin');
      if (cached) {
        const offset = start - tileStart;
        const slice = cached.slice(offset, offset + (end - start + 1), 'application/pdf');
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type': 'application/pdf',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${totalSize || '*'}`,
            'Content-Length': String(slice.size),
          }
        });
      }
    } catch {}
  }

  // Cache miss or no CORS → fetch from upstream
  const got = await fetchTile(upstream, tileStart, tileEnd, allowRead);

  // If we got a full Response (no CORS), just pass it through
  if (got instanceof Response) {
    // Let the browser handle it (we can’t read/reshape opaque responses)
    return got;
  }

  // We have a Blob (CORS allowed). Store tile for offline, then slice and respond
  const tileBlob = got;

  if (TileDB && allowRead) {
    try {
      const docId = `pdf:${fileId}:chunk:${String(tileIndex).padStart(6, '0')}`;
      await TileDB.put({
        _id: docId,
        fileId, tileIndex, tileStart, tileEnd, chunkSize: TILE_SIZE,
        _attachments: { bin: { content_type: 'application/octet-stream', data: tileBlob } }
      });
    } catch {}
  }

  const offset = start - tileStart;
  const slice = tileBlob.slice(offset, offset + (end - start + 1), 'application/pdf');

  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${totalSize || '*'}`,
      'Content-Length': String(slice.size),
    }
  });
}

/* -------------------- Fetch strategy -------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only handle same-origin requests within SW scope
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'https:' && !url.origin.startsWith('http://localhost')) return;
  if (url.href.startsWith('blob:')) return;

  // 0) Google Drive virtual endpoint: <scope>/drivepdf/:id
  if (url.pathname.startsWith(SCOPE_PATH + 'drivepdf/')) {
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
