/**
 * src/render.js — DOM renderer: tree panel, text view, inspector, export.
 *
 * Implements:
 *   renderTree(doc, container)              TASK-24
 *   renderDocView(doc, container)           TASK-25
 *   renderInspector(cfb, doc, container)    TASK-26
 *   exportJson(doc, filename)               TASK-27
 *   exportHtml(doc, filename)               TASK-27
 *
 * Browser-only. No DOM dependencies in parser modules.
 * Never uses innerHTML for document text — only for static chrome scaffolding.
 */

import { readStream } from './cfb.js';
import { t, getLang, errorMessage } from './i18n.js';
import { decodeRecords, TAG_NAMES } from './records.js';

// ── TASK-24: Document tree ───────────────────────────────────────────────────

/**
 * Build a document tree panel showing sections and their paragraphs.
 * Clicking a paragraph entry scrolls it into view in the main text panel.
 *
 * @param {import('./hwp.js').HwpDocument} doc
 * @param {HTMLElement} container   The #doc-tree element
 */
export function renderTree(doc, container) {
  const root = document.createElement('ul');

  for (const section of doc.sections) {
    const sectionLi = document.createElement('li');
    sectionLi.className = 'tree-section';
    sectionLi.textContent = t('section', { n: section.index + 1 });
    root.appendChild(sectionLi);

    const paraList = document.createElement('ul');

    for (const para of section.paragraphs) {
      const paraLi = document.createElement('li');
      paraLi.className = 'tree-para';

      if (para.hasTable && para.table) {
        const { rowCount, colCount } = para.table;
        paraLi.textContent = t('table', { rows: rowCount, cols: colCount });
      } else {
        const preview = para.text.trim();
        paraLi.textContent = preview.length > 0
          ? preview.slice(0, 40)
          : t('empty_para');
      }

      paraLi.setAttribute('data-section', section.index);
      paraLi.setAttribute('data-para', para.index);
      paraLi.setAttribute('tabindex', '0');
      paraLi.setAttribute('role', 'button');
      paraLi.setAttribute('aria-label', t('go_to', { s: section.index + 1, p: para.index + 1 }));

      const onClick = () => scrollToElement(section.index, para.index);
      paraLi.addEventListener('click', onClick);
      paraLi.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      });

      paraList.appendChild(paraLi);
    }

    root.appendChild(paraList);
  }

  container.appendChild(root);
}

/**
 * Scroll the paragraph element with matching data attributes into view.
 *
 * @param {number} sectionIndex
 * @param {number} paraIndex
 */
function scrollToElement(sectionIndex, paraIndex) {
  const el = document.querySelector(
    `[data-section="${sectionIndex}"][data-para="${paraIndex}"]`
  );
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── TASK-25: Document text view ──────────────────────────────────────────────

/**
 * Render the document content into the main view panel.
 * Paragraph text is set via textContent (never innerHTML).
 * Tables use insertRow / insertCell.
 *
 * @param {import('./hwp.js').HwpDocument} doc
 * @param {HTMLElement} container  The #doc-view element
 */
export function renderDocView(doc, container) {
  for (const section of doc.sections) {
    const sectionEl = document.createElement('section');
    sectionEl.className = 'hwp-section';
    sectionEl.setAttribute('data-section-idx', section.index);

    for (const para of section.paragraphs) {
      if (para.hasTable && para.table) {
        // Paragraph is a table container
        const wrapper = document.createElement('div');
        wrapper.className = 'hwp-table';
        wrapper.setAttribute('data-section', section.index);
        wrapper.setAttribute('data-para', para.index);

        const tableEl = document.createElement('table');
        const { table } = para;

        // Build a 2-D grid for rowspan/colspan layout
        for (let r = 0; r < table.rowCount; r++) {
          tableEl.insertRow();
        }

        for (const cell of table.cells) {
          const row = tableEl.rows[cell.row];
          if (!row) continue;
          const td = row.insertCell();
          if (cell.colSpan > 1) td.colSpan = cell.colSpan;
          if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;

          // Render cell paragraphs as text separated by newlines
          const cellText = cell.paragraphs.map(p => p.text).join('\n');
          td.textContent = cellText;
        }

        wrapper.appendChild(tableEl);
        sectionEl.appendChild(wrapper);
      } else {
        // Plain paragraph
        const pEl = document.createElement('p');
        pEl.className = 'hwp-para';
        pEl.setAttribute('data-section', section.index);
        pEl.setAttribute('data-para', para.index);

        // Insert image placeholders and text runs in document order.
        // If the paragraph has inline controls that reference images, emit
        // placeholders. Otherwise just set the text.
        if (para.hasInlineObject && para.inlineControls.length > 0) {
          _renderParaWithControls(pEl, para);
        } else {
          pEl.textContent = para.text;
        }

        sectionEl.appendChild(pEl);
      }
    }

    container.appendChild(sectionEl);
  }
}

/**
 * Render a paragraph that contains inline controls (e.g. image references).
 * Text is split at control positions and inserted as text nodes; each control
 * gets a placeholder <span>.
 *
 * @param {HTMLElement} pEl
 * @param {import('./hwp.js').Paragraph} para
 */
function _renderParaWithControls(pEl, para) {
  // For the initial implementation, render all text then append placeholders.
  // A full implementation would interleave text and controls at the character
  // level using the control positions, but that requires position tracking in
  // decodeParagraphText. For now, text first then labelled placeholders.
  if (para.text) {
    pEl.appendChild(document.createTextNode(para.text));
  }
  for (const ctrl of para.inlineControls) {
    if (ctrl.type === 0x0C || ctrl.type === 0x07) {
      // 0x0C = picture/image object, 0x07 = OLE object
      const span = document.createElement('span');
      span.className = 'hwp-image-placeholder';
      // Try to extract a BIN-ID from the first 2 bytes of the control payload
      let binId = '';
      if (ctrl.payload && ctrl.payload.length >= 2) {
        const v = new DataView(ctrl.payload.buffer, ctrl.payload.byteOffset, ctrl.payload.byteLength);
        binId = `BIN#${v.getUint16(0, true)}`;
      }
      span.textContent = binId || t('image');
      pEl.appendChild(span);
    }
  }
}

// ── TASK-26: Structure inspector ─────────────────────────────────────────────

/**
 * Render the three-panel structure inspector.
 *
 * @param {import('./cfb.js').CfbFile} cfb
 * @param {import('./hwp.js').HwpDocument} doc
 * @param {HTMLElement} container  The #inspector-content element
 */
export function renderInspector(cfb, doc, container) {
  container.appendChild(_buildCfbOverview(cfb));
  container.appendChild(_buildStreamList(cfb));
  // Record inspector panel is built lazily when a stream is clicked
  const recordPanel = _buildRecordPanel();
  container.appendChild(recordPanel);

  // Wire stream-row clicks to populate the record panel
  const streamTable = container.querySelector('.inspector-stream-table');
  if (streamTable) {
    streamTable.addEventListener('click', (e) => {
      const tr = e.target.closest('tr.clickable');
      if (!tr) return;
      const streamName  = tr.dataset.streamName;
      const storagePath = tr.dataset.storagePath
        ? JSON.parse(tr.dataset.storagePath)
        : [];
      _populateRecordPanel(cfb, recordPanel, streamName, storagePath);
    });
  }
}

// ── CFB overview ──────────────────────────────────────────────────────────────

/**
 * Build the CFB overview <details> panel.
 * @param {import('./cfb.js').CfbFile} cfb
 * @returns {HTMLDetailsElement}
 */
function _buildCfbOverview(cfb) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t('cfb_overview');
  details.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'inspector-table';

  const totalSectors = cfb.fat ? cfb.fat.length : 0;
  const fatSectorIds = [];
  if (cfb.fat) {
    for (let i = 0; i < cfb.fat.length; i++) {
      // FATSECT = -3 (0xFFFFFFFD): sector is itself a FAT sector
      if (cfb.fat[i] === (-3 | 0)) fatSectorIds.push(i);
    }
  }

  const root = cfb.directories && cfb.directories[0];

  const rows = [
    [t('row_sector_size'), `${cfb.sectorSize} bytes`],
    [t('row_mini_sector'), `${cfb.miniSectorSize} bytes`],
    [t('row_mini_cutoff'), `${cfb.miniStreamCutoff} bytes`],
    [t('row_total_sectors'), totalSectors],
    [t('row_fat_ids'), fatSectorIds.length > 0 ? fatSectorIds.join(', ') : t('none')],
    [t('row_dir_start'),
      root ? `0x${(root.startSector >>> 0).toString(16).padStart(8, '0')}` : '—'],
    [t('row_dir_entries'), cfb.directories ? cfb.directories.length : 0],
  ];

  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = label;
    const td = document.createElement('td');
    td.textContent = String(value);
    tr.appendChild(th);
    tr.appendChild(td);
    table.appendChild(tr);
  }

  details.appendChild(table);
  return details;
}

// ── Stream list ───────────────────────────────────────────────────────────────

/**
 * Build the stream list <details> panel.
 * @param {import('./cfb.js').CfbFile} cfb
 * @returns {HTMLDetailsElement}
 */
function _buildStreamList(cfb) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t('stream_list');
  details.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'inspector-table inspector-stream-table';

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of [t('th_name'), t('th_size'), t('th_start_sector'), t('th_path'), t('th_mini')]) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Collect all stream entries with their storage path
  const streams = _collectStreams(cfb);
  for (const { entry, storagePath } of streams) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.dataset.streamName  = entry.name;
    tr.dataset.storagePath = JSON.stringify(storagePath);

    const isMini = entry.size < cfb.miniStreamCutoff &&
                   cfb.miniStreamData && cfb.miniStreamData.length > 0;

    const cells = [
      entry.name,
      `${entry.size} bytes`,
      `0x${(entry.startSector >>> 0).toString(16).padStart(8, '0')}`,
      storagePath.length > 0 ? storagePath.join('/') + '/' + entry.name : entry.name,
      isMini ? '✓' : '',
    ];

    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  details.appendChild(table);
  return details;
}

/**
 * Walk the CFB directory tree and collect all stream (type=2) entries
 * along with the storage path that leads to each one.
 *
 * @param {import('./cfb.js').CfbFile} cfb
 * @returns {Array<{ entry: import('./cfb.js').DirEntry, storagePath: string[] }>}
 */
function _collectStreams(cfb) {
  const results = [];
  const { directories } = cfb;
  const NOSTREAM = -1;
  const TYPE_EMPTY  = 0;
  const TYPE_STREAM = 2;

  function walk(sid, path) {
    if (sid === NOSTREAM || sid < 0 || sid >= directories.length) return;
    const entry = directories[sid];
    if (!entry || entry.type === TYPE_EMPTY) return;

    if (entry.type === TYPE_STREAM) {
      results.push({ entry, storagePath: path.slice() });
    }

    // Recurse into child (sub-storage) and siblings
    walk(entry.childSid, [...path, entry.name]);
    walk(entry.leftSid,  path);
    walk(entry.rightSid, path);
  }

  // Start from root's child
  const root = directories[0];
  if (root && root.childSid !== NOSTREAM) {
    walk(root.childSid, []);
  }

  return results;
}

// ── Record inspector ─────────────────────────────────────────────────────────

/**
 * Build the (initially empty) record inspector <details> panel.
 * @returns {HTMLDetailsElement}
 */
function _buildRecordPanel() {
  const details = document.createElement('details');
  details.id = 'record-inspector-panel';
  const summary = document.createElement('summary');
  summary.textContent = t('record_inspector');
  details.appendChild(summary);

  const placeholder = document.createElement('p');
  placeholder.style.cssText = 'padding:0.5rem 0.75rem;font-size:0.8rem;color:var(--color-text-muted)';
  placeholder.textContent = t('record_placeholder');
  details.appendChild(placeholder);

  return details;
}

/**
 * Decode a stream's records and render them into the record inspector panel.
 *
 * @param {import('./cfb.js').CfbFile} cfb
 * @param {HTMLDetailsElement} panel
 * @param {string}   streamName
 * @param {string[]} storagePath
 */
function _populateRecordPanel(cfb, panel, streamName, storagePath) {
  // Clear everything after the summary
  while (panel.children.length > 1) {
    panel.removeChild(panel.lastChild);
  }

  // Expand the panel
  panel.open = true;

  let bytes;
  try {
    bytes = readStream(cfb, streamName, storagePath);
  } catch (err) {
    const msg = document.createElement('p');
    msg.style.cssText = 'padding:0.5rem 0.75rem;font-size:0.8rem;color:var(--color-error-text)';
    msg.textContent = `${t('stream_read_failed')}: ${errorMessage(err)}`;
    panel.appendChild(msg);
    return;
  }

  // Heading for the stream being inspected
  const heading = document.createElement('p');
  heading.style.cssText = 'padding:0.4rem 0.75rem;font-size:0.8rem;font-weight:600;border-bottom:1px solid var(--color-border)';
  const fullPath = storagePath.length > 0
    ? storagePath.join('/') + '/' + streamName
    : streamName;
  heading.textContent = `${fullPath} (${bytes.length} bytes)`;
  panel.appendChild(heading);

  // Build record table
  const table = document.createElement('table');
  table.className = 'inspector-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of [t('th_tag_id'), t('th_name'), t('th_level'), t('th_size'), t('th_first_bytes')]) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  let recordCount = 0;
  const MAX_RECORDS = 2000; // avoid locking the page on huge streams

  try {
    for (const { tagId, level, size, payload } of decodeRecords(bytes)) {
      if (recordCount >= MAX_RECORDS) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.style.cssText = 'color:var(--color-text-muted);font-style:italic';
        td.textContent = t('record_limit', { n: MAX_RECORDS });
        tr.appendChild(td);
        tbody.appendChild(tr);
        break;
      }

      const tr = document.createElement('tr');

      const tagHex  = `0x${tagId.toString(16).padStart(2, '0')}`;
      const tagName = TAG_NAMES[tagId] || '(unknown)';
      const hexDump = _hexDump(payload, 16);

      const cells = [tagHex, tagName, String(level), String(size), hexDump];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
      recordCount++;
    }
  } catch (err) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.style.cssText = 'color:var(--color-error-text)';
    td.textContent = `${t('record_error')}: ${errorMessage(err)}`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  if (recordCount === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.style.cssText = 'color:var(--color-text-muted);font-style:italic';
    td.textContent = t('no_records');
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  panel.appendChild(table);
}

/**
 * Format up to `maxBytes` bytes of a Uint8Array as a hex string.
 * @param {Uint8Array} bytes
 * @param {number}     maxBytes
 * @returns {string}
 */
function _hexDump(bytes, maxBytes) {
  const len = Math.min(bytes.length, maxBytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
    if (i < len - 1) out += ' ';
  }
  if (bytes.length > maxBytes) out += ' …';
  return out;
}

// ── TASK-27: JSON export ──────────────────────────────────────────────────────

/**
 * JSON replacer that converts Uint8Array → hex string and skips ArrayBuffer.
 */
function _jsonReplacer(key, value) {
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (value instanceof ArrayBuffer) {
    return undefined; // omit
  }
  return value;
}

/**
 * Serialise the document model and trigger a download.
 *
 * @param {import('./hwp.js').HwpDocument} doc
 * @param {string} filename  Suggested filename (without extension)
 */
export function exportJson(doc, filename) {
  const json = JSON.stringify(doc, _jsonReplacer, 2);
  _download(json, `${filename}`, 'application/json');
}

// ── TASK-27: HTML export ──────────────────────────────────────────────────────

/**
 * Build a minimal standalone HTML document from the current #doc-view and
 * trigger a download.
 *
 * @param {import('./hwp.js').HwpDocument} doc
 * @param {string} filename  Suggested filename (without extension)
 */
export function exportHtml(doc, filename) {
  const docViewEl = document.getElementById('doc-view');
  if (!docViewEl) return;

  // Clone the rendered tree so we can annotate it without touching the live DOM
  const clone = docViewEl.cloneNode(true);

  // Minimal inline styles for tables (so the exported file is self-contained)
  const tableStyle = [
    'border-collapse:collapse',
    'width:100%',
  ].join(';');
  const tdStyle = [
    'border:1px solid #ccc',
    'padding:4px 8px',
    'vertical-align:top',
  ].join(';');

  for (const table of clone.querySelectorAll('table')) {
    table.setAttribute('style', tableStyle);
  }
  for (const td of clone.querySelectorAll('td, th')) {
    td.setAttribute('style', tdStyle);
  }

  const bodyHtml = clone.innerHTML;

  const html = `<!DOCTYPE html>
<html lang="${getLang()}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${t('export_title')}</title>
<style>
  body { font-family: 'Apple SD Gothic Neo', 'Nanum Gothic', 'Malgun Gothic', system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; line-height: 1.8; }
  .hwp-section { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #d1d9e6; }
  .hwp-section:last-child { border-bottom: none; }
  .hwp-para { font-size: 1rem; margin-bottom: 0.6rem; white-space: pre-wrap; word-break: break-word; }
  .hwp-table { overflow-x: auto; margin: 1rem 0; }
  .hwp-image-placeholder { display:inline-block; padding:0.2rem 0.5rem; background:#f4f6f9; border:1px solid #d1d9e6; border-radius:3px; font-size:0.8rem; color:#5a6474; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

  _download(html, `${filename}`, 'text/html');
}

// ── Download helper ───────────────────────────────────────────────────────────

/**
 * Trigger a file download using a temporary object URL.
 *
 * @param {string} content   Text content
 * @param {string} filename  Full suggested filename (with extension)
 * @param {string} mimeType
 */
function _download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to let the browser initiate the download
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
