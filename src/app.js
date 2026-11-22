/**
 * src/app.js — Browser-only entry point.
 * Wires drag-and-drop, file input, and large-file guard.
 * Parsing pipeline is called from handleFile(); rendering is deferred
 * until Phase 10–11 tasks are implemented.
 */

import { bindSwitch, errorMessage as errorText, t } from './i18n.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// ── DOM references ────────────────────────────────────────────────────────────
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const spinner       = document.getElementById('spinner');
const panels        = document.getElementById('panels');
const errorBanner   = document.getElementById('error-banner');
const errorCode     = document.getElementById('error-code');
const errorMessage  = document.getElementById('error-message');
const errorDetails  = document.getElementById('error-stack-details');
const errorStack    = document.getElementById('error-stack');
const errorClose    = document.getElementById('error-close');
const dialog        = document.getElementById('large-file-dialog');
const dialogProceed = document.getElementById('large-file-proceed');
const dialogCancel  = document.getElementById('large-file-cancel');
const btnExportJson = document.getElementById('btn-export-json');
const btnExportHtml = document.getElementById('btn-export-html');

// ── Error display ─────────────────────────────────────────────────────────────

function showError(err) {
  errorBanner.hidden = false;
  if (err && err.code) {
    // HwpError with ERR_* code
    errorCode.textContent = `[${err.code}] `;
    errorMessage.textContent = errorText(err);
    errorDetails.hidden = true;
  } else {
    // Unexpected non-HwpError
    errorCode.textContent = '';
    errorMessage.textContent = t('unexpected_error');
    errorDetails.hidden = false;
    errorStack.textContent = err ? (err.stack || String(err)) : 'Unknown error';
  }
}

function clearError() {
  errorBanner.hidden = true;
  errorCode.textContent = '';
  errorMessage.textContent = '';
  errorStack.textContent = '';
  errorDetails.hidden = true;
}

errorClose.addEventListener('click', clearError);

// ── Large-file guard ──────────────────────────────────────────────────────────

/**
 * Resolves true if the user confirms, false if they cancel.
 * Uses a native <dialog> for accessibility.
 */
function confirmLargeFile() {
  return new Promise((resolve) => {
    dialog.showModal();

    function onProceed() {
      dialog.close();
      cleanup();
      resolve(true);
    }

    function onCancel() {
      dialog.close();
      cleanup();
      resolve(false);
    }

    function cleanup() {
      dialogProceed.removeEventListener('click', onProceed);
      dialogCancel.removeEventListener('click', onCancel);
    }

    dialogProceed.addEventListener('click', onProceed);
    dialogCancel.addEventListener('click', onCancel);
  });
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

/**
 * handleFile(file) — entry point for all file input paths.
 * Validates size, then hands off to the parsing pipeline.
 * @param {File} file
 */
/**
 * Show or hide the drop zone. The `hidden` attribute plus an inline display
 * value — not a stylesheet rule alone — so a cached stylesheet can never leave
 * the zone covering the document.
 * @param {boolean} visible
 */
function setDropZoneVisible(visible) {
  dropZone.hidden = !visible;
  dropZone.style.display = visible ? '' : 'none';
  const opener = document.getElementById('btn-open-another');
  if (opener) opener.hidden = visible;
}

// Kept so a language switch can redraw the panels without opening the file again.
let lastRender = null;

async function handleFile(file) {
  clearError();

  if (file.size > MAX_FILE_SIZE) {
    const proceed = await confirmLargeFile();
    if (!proceed) return;
  }

  setDropZoneVisible(false);
  spinner.hidden = false;
  panels.hidden = true;

  try {
    // Dynamically import parser modules so this file stays a lightweight
    // wiring layer; modules are loaded lazily on first file open.
    const { parseCfb, readStream } = await import('./cfb.js');
    const { buildDocument }         = await import('./hwp.js');
    const { renderTree }            = await import('./render.js');
    const { renderDocView }         = await import('./render.js');
    const { renderInspector }       = await import('./render.js');
    const { exportJson, exportHtml } = await import('./render.js');

    const buffer   = await file.arrayBuffer();
    const cfb      = parseCfb(buffer);
    const doc      = await buildDocument(buffer);

    // Render all three panels
    const treeEl      = document.getElementById('doc-tree');
    const viewEl      = document.getElementById('doc-view');
    const inspectorEl = document.getElementById('inspector-content');

    treeEl.innerHTML = '';
    viewEl.innerHTML = '';
    inspectorEl.innerHTML = '';

    renderTree(doc, treeEl);
    renderDocView(doc, viewEl);
    renderInspector(cfb, doc, inspectorEl);
    lastRender = { cfb, doc };

    // Wire export buttons
    btnExportJson.disabled = false;
    btnExportHtml.disabled = false;

    const baseName = file.name.replace(/\.hwpx?$/i, '');
    btnExportJson.onclick = () => exportJson(doc, `${baseName}.json`);
    btnExportHtml.onclick = () => exportHtml(doc, `${baseName}.html`);

    panels.hidden = false;
  } catch (err) {
    showError(err);
    setDropZoneVisible(true);
  } finally {
    spinner.hidden = true;
  }
}

// Redraw the three panels in the other language, keeping the document as it is.
document.addEventListener('hwp:lang', () => {
  if (!lastRender) return;
  const treeEl      = document.getElementById('doc-tree');
  const viewEl      = document.getElementById('doc-view');
  const inspectorEl = document.getElementById('inspector-content');
  treeEl.innerHTML = '';
  viewEl.innerHTML = '';
  inspectorEl.innerHTML = '';
  import('./render.js').then(({ renderTree, renderDocView, renderInspector }) => {
    renderTree(lastRender.doc, treeEl);
    renderDocView(lastRender.doc, viewEl);
    renderInspector(lastRender.cfb, lastRender.doc, inspectorEl);
  });
});

bindSwitch();

const btnOpenAnother = document.getElementById('btn-open-another');
if (btnOpenAnother) {
  btnOpenAnother.addEventListener('click', () => {
    setDropZoneVisible(true);
    const input = document.getElementById('file-input');
    if (input) { input.value = ''; input.click(); }
  });
}

// ── Drag-and-drop events ──────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Click anywhere in the drop zone (excluding the label/input) triggers picker
dropZone.addEventListener('click', (e) => {
  if (e.target !== fileInput && !e.target.closest('label')) {
    fileInput.click();
  }
});

// Keyboard: Enter or Space activates the file picker
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

// ── File input change ─────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
  // Reset so the same file can be picked again
  fileInput.value = '';
});
