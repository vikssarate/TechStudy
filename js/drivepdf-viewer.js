// js/drivepdf-viewer.js
// Minimal, dependency-free PDF viewer with 10-page batching + Drive support.
// Exports: openDrivePdfFromLink(input, title?), openDrivePdfById(fileId, title?)

//// ---------- pdf.js dynamic import (local → CDN fallback) ----------
async function loadPdfJs() {
  // Try local shim relative to this file (/js → /lib)
  const localBase = new URL('../lib/pdfjs/', import.meta.url).href;
  try {
    const mod = await import(localBase + 'pdf.mjs');
    return { pdfjsLib: mod, workerSrc: localBase + 'pdf.worker.mjs' };
  } catch (_e1) {
    // Try site-root (in case your module is served from a nested path)
    try {
      const mod = await import('/lib/pdfjs/pdf.mjs');
      return { pdfjsLib: mod, workerSrc: '/lib/pdfjs/pdf.worker.mjs' };
    } catch (_e2) {
      // CDN fallback
      const cdn = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/';
      const mod = await import(cdn + 'pdf.mjs');
      return { pdfjsLib: mod, workerSrc: cdn + 'pdf.worker.mjs' };
    }
  }
}

//// ---------- DOM: ensure modal exists (creates if not) ----------
function ensureModal() {
  let modal = document.getElementById('pdfModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pdfModal';
    modal.style.cssText = 'position:fixed;inset:0;background:#000a;backdrop-filter:blur(2px);display:none;z-index:9998';
    modal.innerHTML = `
      <div id="pdfBox" style="position:absolute;inset:40px 20px 20px 20px;background:#0f1117;border-radius:12px;overflow:hidden;display:flex;flex-direction:column">
        <div id="pdfHdr" style="padding:8px 12px;border-bottom:1px solid #2a3052;display:flex;gap:8px;align-items:center">
          <button id="pdfClose" class="ghost slim">Close</button>
          <div class="title" id="pdfTitleBar" style="color:#eef1ff;font-weight:700">PDF</div>
          <div class="meta" id="pdfMeta" style="margin-left:auto;color:#9aa3c7">Loading…</div>
        </div>
        <div id="pdfViewer" style="flex:1;overflow:auto;background:#0b1128;padding:12px 0"></div>
      </div>`;
    document.body.appendChild(modal);
  }
  return {
    modal,
    viewer: modal.querySelector('#pdfViewer'),
    titleBar: modal.querySelector('#pdfTitleBar'),
    metaEl: modal.querySelector('#pdfMeta'),
    closeBtn: modal.querySelector('#pdfClose')
  };
}

//// ---------- Helpers ----------
function extractDriveId(s) {
  if (!s) return '';
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s; // raw ID
  try {
    const u = new URL(s);
    const m1 = u.pathname.match(/\/file\/d\/([^/]+)/); if (m1) return m1[1];
    return u.searchParams.get('id') || '';
  } catch {
    return '';
  }
}

//// ---------- Public API ----------
export async function openDrivePdfFromLink(input, title = 'PDF') {
  const id = extractDriveId(input);
  if (!id && !/^https?:\/\/.+\.pdf(\?|$)/i.test(input || '')) {
    alert('Please provide a Google Drive link/ID or a direct PDF URL.');
    return;
  }
  return id ? openDrivePdfById(id, title) : openUrlPdf(input, title);
}

export async function openDrivePdfById(fileId, title = 'PDF') {
  return openUrlPdf(`/drivepdf/${fileId}`, title);
}

//// ---------- Core viewer ----------
async function openUrlPdf(src, title) {
  const { pdfjsLib, workerSrc } = await loadPdfJs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

  const ui = ensureModal();
  ui.viewer.innerHTML = '';
  ui.modal.style.display = 'block';
  ui.titleBar.textContent = title || 'PDF';
  ui.metaEl.textContent = 'Loading…';

  const loadingTask = pdfjsLib.getDocument({
    url: src,
    disableStream: false,
    disableAutoFetch: true,
    rangeChunkSize: 4 * 1024 * 1024
  });

  const pdf = await loadingTask.promise;
  ui.metaEl.textContent = `${pdf.numPages} pages`;

  const BATCH = 10;
  const SCALE = 1.5;

  const pageIO = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      const el = e.target;
      if (!e.isIntersecting || el.dataset.rendered) continue;
      const n = +el.dataset.page;
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: SCALE });
      const canvas = el.querySelector('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      const ratio = Math.min(2, self.devicePixelRatio || 1);
      canvas.width = Math.floor(vp.width * ratio);
      canvas.height = Math.floor(vp.height * ratio);
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      el.dataset.rendered = '1';
    }
  }, { root: ui.viewer, rootMargin: '1000px 0px' });

  const batchIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const next = +e.target.dataset.nextBatch;
      appendBatch(next);
      batchIO.unobserve(e.target);
    }
  }, { root: ui.viewer, rootMargin: '1200px 0px' });

  function pageShell(n) {
    const d = document.createElement('div');
    d.className = 'page';
    d.dataset.page = n;
    d.style.cssText = 'margin:12px auto;max-width:900px;background:#111;box-shadow:0 2px 10px #0006';
    d.innerHTML = '<canvas style="display:block;width:100%;height:auto"></canvas>';
    pageIO.observe(d);
    return d;
  }

  function sentinel(nextBatch) {
    const s = document.createElement('div');
    s.className = 'sentinel';
    s.dataset.nextBatch = nextBatch;
    s.textContent = 'Loading more pages…';
    s.style.cssText = 'text-align:center;color:#aab;padding:16px 0';
    batchIO.observe(s);
    return s;
  }

  async function appendBatch(i) {
    const start = i * BATCH + 1;
    const end = Math.min(start + BATCH - 1, pdf.numPages);
    if (start > pdf.numPages) return;
    const frag = document.createDocumentFragment();
    for (let p = start; p <= end; p++) frag.appendChild(pageShell(p));
    if (end < pdf.numPages) frag.appendChild(sentinel(i + 1));
    ui.viewer.appendChild(frag);
  }

  appendBatch(0);

  ui.closeBtn.onclick = () => {
    ui.modal.style.display = 'none';
    ui.viewer.innerHTML = '';
  };
  window.addEventListener('keydown', escCloseOnce);
  function escCloseOnce(ev) {
    if (ev.key === 'Escape') { ui.closeBtn.click(); window.removeEventListener('keydown', escCloseOnce); }
  }
}

// Optional convenience for inline onclick handlers:
if (typeof window !== 'undefined') {
  window.openDrivePdfFromLink = openDrivePdfFromLink;
  window.openDrivePdfById = openDrivePdfById;
}
