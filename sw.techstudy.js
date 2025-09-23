/* sw.techstudy.js — TechStudy Notes (SQLite + IndexedDB) */
const APP_NS = 'techstudy';
const VERSION = 'v14'; // bump on every change
const CACHE_NAME = `study-notes-${APP_NS}-${VERSION}`;

const SCOPE_PATH = new URL(self.registration?.scope || self.location.href)
  .pathname.replace(/\/+$/, '') + '/';

// ---- Google Drive chunking config ----
const TILE_SIZE = 4 * 1024 * 1024;
const CHUNK_DB_NAME = 'pdf-chunks';
const DRIVE_API_KEY = 'AIzaSyDZHZkniW8lHSenR-6lSyidFRzCAWfK0l0'; // your key
const DRIVE_PROXY = ''; // leave empty unless you have a proxy

// Try to enable PouchDB tile cache (optional)
let TileDB = null;
try { importScripts('./lib/pouchdb.min.js'); TileDB = new self.PouchDB(CHUNK_DB_NAME); } catch (_) {}

// Precache core app files
const CORE_ASSETS = [
  './',
  './index.html',
  './lib/sqljs/sql-wasm.js',
  './lib/sqljs/sql-wasm.wasm',
  './lib/pouchdb.min.js',
  './lib/pdfjs/pdf.mjs',
  './lib/pdfjs/pdf.worker.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS).catch(()=>{}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== CACHE_NAME && k.startsWith(`study-notes-${APP_NS}-`))
      .map((k) => caches.delete(k)));
    try { await self.registration.navigationPreload?.enable(); } catch(_) {}
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  url.searchParams.delete('v');
  return new Request(url.pathname + url.search, {
    method: 'GET',
    headers: request.headers,
    mode: 'same-origin',
    credentials: 'same-origin',
  });
}

/* -------------------- Google Drive helpers -------------------- */
// Force a same-origin referrer so a website-restricted key can work.
const REFERRER_INIT = {
  referrer: self.registration.scope,          // e.g., https://vikssarate.github.io/
  referrerPolicy: 'origin',                   // send just the origin
  redirect: 'follow',
};

function driveCandidates(fileId) {
  if (DRIVE_PROXY) {
    const base = DRIVE_PROXY.endsWith('=') || DRIVE_PROXY.endsWith('/') ? DRIVE_PROXY : DRIVE_PROXY + '?id=';
    return [{ url: `${base}${encodeURIComponent(fileId)}`, cors: true, via: 'proxy' }];
  }
  const withKey = DRIVE_API_KEY ? `&key=${encodeURIComponent(DRIVE_API_KEY)}` : '';
  return [
    { url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media${withKey}`, cors: true, via: 'v3' },
    { url: `https://drive.google.com/uc?export=download&id=${fileId}`, cors: false, via: 'uc' },
    { url: `https://lh3.googleusercontent.com/d/${fileId}`, cors: false, via: 'lh3' },
  ];
}

async function getTotalSize(upstreamUrl) {
  try {
    const head = await fetch(upstreamUrl, { method: 'HEAD', ...REFERRER_INIT });
    const len = +head.headers.get('Content-Length');
    if (len > 0) return len;
  } catch {}
  try {
    const probe = await fetch(upstreamUrl, { headers: { Range: 'bytes=0-0' }, ...REFERRER_INIT });
    const cr = probe.headers.get('Content-Range');
    if (cr) return parseInt(cr.split('/')[1], 10);
  } catch {}
  return 0;
}

async function fetchTile(upstreamUrl, start, end, allowReadBytes) {
  const resp = await fetch(upstreamUrl, {
    headers: { Range: `bytes=${start}-${end}` },
    ...REFERRER_INIT
  });

  if (allowReadBytes && resp.ok) {
    const buf = await resp.arrayBuffer();
    return new Blob([buf], { type: 'application/octet-stream' });
  }
  return resp; // opaque or non-CORS → pass-through
}

async function handleDrivePdf(req, url) {
  const prefix = SCOPE_PATH + 'drivepdf/';
  const fileId = url.pathname.slice(prefix.length).split('/')[0];

  const cands = driveCandidates(fileId);
  let upstream = cands[0].url;
  let allowRead = cands[0].cors;

  const range = req.headers.get('range');
  if (!range) return fetch(upstream, REFERRER_INIT);

  let totalSize = await getTotalSize(upstream);
  if (!totalSize) {
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

  const m = /bytes=(\d+)-(\d*)/.exec(range);
  let start = parseInt(m?.[1] ?? '0', 10);
  const requestedEnd = m?.[2] ? parseInt(m[2], 10) : start + TILE_SIZE - 1;

  const tileIndex = Math.floor(start / TILE_SIZE);
  const tileStart = tileIndex * TILE_SIZE;
  const tileEnd = totalSize ? Math.min(tileStart + TILE_SIZE - 1, totalSize - 1) : (tileStart + TILE_SIZE - 1);
  const end = Math.min(tileEnd, requestedEnd);

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

  const got = await fetchTile(upstream, tileStart, tileEnd, allowRead);
  if (got instanceof Response) return got;

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
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'https:' && !url.origin.startsWith('http://localhost')) return;
  if (url.href.startsWith('blob:')) return;

  if (url.pathname.startsWith(SCOPE_PATH + 'drivepdf/')) {
    event.respondWith(handleDrivePdf(req, url));
    return;
  }

  if (req.headers.has('range')) {
    event.respondWith(fetch(req));
    return;
  }

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
        if (fresh && fresh.ok) {
          const copy = fresh.clone();
          const key = cacheKeyFor(req);
          if (key) caches.open(CACHE_NAME).then((c) => c.put(key, copy));
        }
        return fresh;
      } catch (_) {
        const cached = await caches.match(cacheKeyFor(req) || req);
        return cached || caches.match(SCOPE_PATH + 'index.html');
      }
    })());
    return;
  }

  const key = cacheKeyFor(req);
  if (!key) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    const networkPromise = fetch(req)
      .then((res) => { cache.put(key, res.clone()).catch(() => {}); return res; })
      .catch(() => cached);
    return cached || networkPromise;
  })());
});
