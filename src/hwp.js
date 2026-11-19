/**
 * src/hwp.js — HWP 5.0 FileHeader parser, stream decompressor,
 * section / table parser, and top-level document model builder.
 *
 * Implements:
 *   parseFileHeader(bytes)              TASK-11
 *   decompressStream(bytes, name)       TASK-12
 *   findBodyTextStreams(cfb)             TASK-17
 *   parseSection(bytes, index)          TASK-18 / TASK-19
 *   buildDocument(buffer)               TASK-20
 *
 * No DOM dependencies; runs in Node for unit tests.
 */

import { parseCfb, readStream, HwpError,
         ERR_NOT_HWP, ERR_HWP_VERSION, ERR_ENCRYPTED, ERR_DISTRIBUTION,
         ERR_DECOMPRESS_FAILED, ERR_NO_BODY } from './cfb.js';
import { decodeRecords, decodeParagraphText, TAGS } from './records.js';
import { inflate, inflateWithConsumed } from './inflate.js';

// ── TASK-11: FileHeader parser ────────────────────────────────────────────────

/** ASCII bytes of the HWP 5.0 FileHeader signature (32 bytes). */
const HWP_SIGNATURE = 'HWP Document File'; // first 17 of the 32-byte signature field; the rest is NUL padding

/**
 * Parse the 256-byte FileHeader stream.
 *
 * @param {Uint8Array} bytes  Raw FileHeader stream bytes (never compressed)
 * @returns {{ version: object, flags: object }}
 */
export function parseFileHeader(bytes) {
  if (bytes.length < 256) {
    throw new HwpError(
      ERR_NOT_HWP,
      'FileHeader 스트림이 너무 짧습니다 (256바이트 미만)',
      'FileHeader stream is too short (less than 256 bytes)'
    );
  }

  // Validate the 32-byte signature field: "HWP Document File" then NUL padding.
  for (let i = 0; i < 32; i++) {
    const expected = i < HWP_SIGNATURE.length ? HWP_SIGNATURE.charCodeAt(i) : 0x00;
    if (bytes[i] !== expected) {
      throw new HwpError(
        ERR_NOT_HWP,
        'HWP 문서 서명이 일치하지 않습니다. HWP 5.0 파일이 아닙니다.',
        'HWP document signature does not match. File is not an HWP 5.0 document.'
      );
    }
  }

  // Version bytes at offsets 32–35: [revision, build, minor, major] LE
  // major is at byte offset 35
  const revision = bytes[32];
  const build    = bytes[33];
  const minor    = bytes[34];
  const major    = bytes[35];

  if (major !== 5) {
    throw new HwpError(
      ERR_HWP_VERSION,
      `지원하지 않는 HWP 버전입니다: ${major}.${minor}.${build}.${revision}`,
      `Unsupported HWP version: ${major}.${minor}.${build}.${revision} (only major version 5 is supported)`
    );
  }

  // Flags uint32 at offset 36 (little-endian)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flagsRaw = view.getUint32(36, true);

  const compressed   = (flagsRaw & (1 << 0)) !== 0;
  const encrypted    = (flagsRaw & (1 << 1)) !== 0;
  const distribution = (flagsRaw & (1 << 2)) !== 0;
  const script       = (flagsRaw & (1 << 3)) !== 0;
  const drm          = (flagsRaw & (1 << 4)) !== 0;
  const hasMemo      = (flagsRaw & (1 << 9)) !== 0;

  // Abort immediately on encrypted or DRM documents (bit 1 or bit 4)
  if (encrypted || drm) {
    throw new HwpError(
      ERR_ENCRYPTED,
      '암호화된 문서입니다. 이 뷰어는 암호화된 HWP 파일을 열 수 없습니다.',
      'Document is encrypted. This viewer cannot open encrypted HWP files.'
    );
  }

  // Abort on distribution documents (bit 2)
  if (distribution) {
    throw new HwpError(
      ERR_DISTRIBUTION,
      '배포용 문서입니다. 이 뷰어는 배포용 HWP 파일을 열 수 없습니다.',
      'Document is a distribution copy. This viewer cannot open distribution HWP files.'
    );
  }

  return {
    version: { major, minor, build, revision },
    flags: { compressed, encrypted, distribution, script, drm, hasMemo, raw: flagsRaw },
  };
}

// ── TASK-12: Stream decompressor ──────────────────────────────────────────────

/**
 * Decompress a raw-DEFLATE compressed HWP stream.
 *
 * Feature-detects `DecompressionStream` (available in modern browsers and
 * Node 18+). Falls back to the pure-JS `inflate` from src/inflate.js.
 *
 * @param {Uint8Array} bytes       Compressed stream bytes
 * @param {string}     streamName  Used in error messages only
 * @returns {Promise<Uint8Array>}
 */
export async function decompressStream(bytes, streamName) {
  if (bytes.length === 0) return new Uint8Array(0);
  try {
    // A single HWP stream may hold several independent raw-DEFLATE members
    // (the writer flushes periodically). Decode member by member, using the
    // pure-JS inflater because it reports exactly how many bytes it consumed —
    // DecompressionStream cannot tell us that and errors on trailing data.
    const chunks = [];
    let total = 0;
    let offset = 0;
    let members = 0;

    while (offset < bytes.length && members < 4096) {
      let result;
      try {
        result = inflateWithConsumed(bytes.subarray(offset));
      } catch (err) {
        // Trailing padding after the last member is normal; anything else is not.
        if (members > 0) break;
        throw err;
      }
      const { out, consumed } = result;
      if (consumed <= 0) {
        if (members === 0) throw new Error('no DEFLATE data consumed');
        break;
      }
      chunks.push(out);
      total += out.length;
      offset += consumed;
      members++;
      // A handful of bytes after the last member is writer padding, not data;
      // feeding it to the inflater only invents junk (a valid-looking block).
      if (bytes.length - offset < 16) break;
    }

    const merged = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      merged.set(chunk, pos);
      pos += chunk.length;
    }
    return merged;
  } catch (err) {
    throw new HwpError(
      ERR_DECOMPRESS_FAILED,
      `스트림 압축 해제에 실패했습니다: ${streamName}`,
      `Failed to decompress stream: ${streamName} (${err.message})`
    );
  }
}

// ── TASK-17: BodyText stream discovery ───────────────────────────────────────

/**
 * Find all BodyText/Section* stream names, sorted by numeric suffix.
 *
 * @param {import('./cfb.js').CfbFile} cfb
 * @returns {string[]}  Sorted section stream names, e.g. ['Section0','Section1']
 */
export function findBodyTextStreams(cfb) {
  const { directories } = cfb;

  // Locate the BodyText storage entry
  let bodyTextEntry = null;
  for (const entry of directories) {
    if (entry.name === 'BodyText' && entry.type === 1 /* TYPE_STORAGE */) {
      bodyTextEntry = entry;
      break;
    }
  }

  if (!bodyTextEntry) {
    throw new HwpError(
      ERR_NO_BODY,
      'BodyText 스토리지를 찾을 수 없습니다. 본문이 없는 문서입니다.',
      'BodyText storage not found. Document has no body content.'
    );
  }

  // Collect all Section\d+ stream entries that are children of BodyText
  // The directory tree uses left/right/child SID pointers; we do a full scan
  // of all entries and match by parent (BodyText is their storage container).
  // Since CfbFile doesn't store a parent pointer, we walk the subtree rooted
  // at bodyTextEntry.childSid.
  const sectionNames = [];
  const NOSTREAM = -1;

  function collectNames(sid) {
    if (sid === NOSTREAM || sid < 0 || sid >= directories.length) return;
    const entry = directories[sid];
    if (!entry || entry.type === 0 /* empty */) return;
    if (/^Section\d+$/.test(entry.name) && entry.type === 2 /* stream */) {
      sectionNames.push(entry.name);
    }
    collectNames(entry.leftSid);
    collectNames(entry.rightSid);
  }

  collectNames(bodyTextEntry.childSid);

  if (sectionNames.length === 0) {
    throw new HwpError(
      ERR_NO_BODY,
      'BodyText 스토리지에 섹션 스트림이 없습니다.',
      'BodyText storage contains no Section streams.'
    );
  }

  // Sort by numeric suffix: Section0, Section1, …
  sectionNames.sort((a, b) => {
    const na = parseInt(a.replace('Section', ''), 10);
    const nb = parseInt(b.replace('Section', ''), 10);
    return na - nb;
  });

  return sectionNames;
}

// ── TASK-18 / TASK-19: Section parser ────────────────────────────────────────

/**
 * @typedef {{ type: number, payload: Uint8Array }} InlineControl
 * @typedef {{ index: number, text: string, hasTable: boolean,
 *             hasInlineObject: boolean, table?: Table,
 *             inlineControls: InlineControl[] }} Paragraph
 * @typedef {{ rowCount: number, colCount: number, cells: Cell[] }} Table
 * @typedef {{ row: number, col: number, rowSpan: number, colSpan: number,
 *             paragraphs: Paragraph[] }} Cell
 * @typedef {{ index: number, paragraphs: Paragraph[] }} Section
 */

/**
 * Create a fresh empty Paragraph.
 * @param {number} index
 * @returns {Paragraph}
 */
function makeParagraph(index) {
  return {
    index,
    text: '',
    hasTable: false,
    hasInlineObject: false,
    inlineControls: [],
  };
}

// Control ID for a table: the four ASCII bytes "tbl " (0x20 0x74 0x62 0x6C
// in file order) read as a little-endian uint32.
const CTRL_ID_TABLE = 0x74626C20;
// Control IDs whose payload nests a paragraph list (footnote, header/footer,
// text box, ...). Their paragraphs are kept, but not as section paragraphs.
const CTRL_ID_NESTED_TEXT = new Set([
  0x6C6C7562, // 'bull' (bullet list)
  0x6E6E756D, // 'nnum' (numbered list)
]);

/**
 * Parse one decompressed BodyText/Section* stream into a Section model.
 *
 * Layout observed in real documents (verified against HWP 5.0 writers):
 *
 *   CTRL_HEADER (level L, payload starts "tbl ")
 *     TABLE     (level L+1, uint16 rows @4, uint16 cols @6)
 *       LIST_HEADER (level L+1)      ← one per table cell, document (row-major) order
 *         PARA_HEADER (level L+1)
 *           PARA_TEXT (level L+2)
 *   PARA_HEADER (level ≤ L)          ← table ended, section text resumes
 *
 * @param {Uint8Array} sectionBytes  Decompressed section stream bytes
 * @param {number}     sectionIndex
 * @returns {Section}
 */
export function parseSection(sectionBytes, sectionIndex) {
  /** @type {Paragraph[]} */
  const paragraphs = [];

  /** @type {Paragraph|null} */
  let current = null;
  /** @type {Table|null} */
  let currentTable = null;
  /** @type {Cell|null} */
  let currentCell = null;
  let tableCtlLevel = -1;
  let pendingTable = false;
  let paraIndex = 0;

  for (const { tagId, level, payload } of decodeRecords(sectionBytes)) {
    switch (tagId) {
      case TAGS.PARA_HEADER: {
        // A paragraph at or above the table's control level closes the table.
        if (currentTable && level <= tableCtlLevel) {
          currentTable = null;
          currentCell = null;
          tableCtlLevel = -1;
        }

        const para = makeParagraph(paraIndex++);
        if (currentTable && currentCell) currentCell.paragraphs.push(para);
        else paragraphs.push(para);
        current = para;
        break;
      }

      case TAGS.PARA_TEXT: {
        if (!current) break;
        const { text, controls } = decodeParagraphText(payload);
        // A paragraph may be split over several PARA_TEXT records (tabs,
        // inline objects); append in document order.
        current.text += text;
        if (controls.length) {
          current.inlineControls.push(...controls);
          current.hasInlineObject = true;
        }
        break;
      }

      case TAGS.CTRL_HEADER: {
        if (payload.length < 4) break;
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const ctrlId = view.getUint32(0, true);
        if (ctrlId === CTRL_ID_TABLE) {
          pendingTable = true;
          tableCtlLevel = level;
        } else if (CTRL_ID_NESTED_TEXT.has(ctrlId) && currentTable && level <= tableCtlLevel) {
          currentTable = null;
          currentCell = null;
          tableCtlLevel = -1;
        }
        break;
      }

      case TAGS.TABLE: {
        if (!pendingTable || payload.length < 8) break;
        pendingTable = false;

        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const rowCount = view.getUint16(4, true);
        const colCount = view.getUint16(6, true);
        if (rowCount === 0 || colCount === 0) break;

        /** @type {Table} */
        const table = { rowCount, colCount, cells: [] };
        if (current) {
          current.table = table;
          current.hasTable = true;
        }
        currentTable = table;
        currentCell = null;
        break;
      }

      case TAGS.LIST_HEADER: {
        // Inside a table, each list header opens one cell. Cells arrive in
        // document order (row-major), so the grid position is derived.
        if (!currentTable || level <= tableCtlLevel) break;
        const i = currentTable.cells.length;
        /** @type {Cell} */
        const cell = {
          row: Math.floor(i / currentTable.colCount),
          col: i % currentTable.colCount,
          rowSpan: 1,   // spans need the cell property record; not decoded here
          colSpan: 1,
          paragraphs: [],
        };
        currentTable.cells.push(cell);
        currentCell = cell;
        break;
      }

      default:
        break;
    }
  }

  return { index: sectionIndex, paragraphs };
}

// ── TASK-20: Document model builder ──────────────────────────────────────────

/**
 * @typedef {{
 *   version: { major: number, minor: number, build: number, revision: number },
 *   flags: { compressed: boolean, encrypted: boolean, distribution: boolean,
 *            script: boolean, drm: boolean, hasMemo: boolean },
 *   previewText: string | null,
 *   docInfo: { idMappings: number[] | null },
 *   sections: Section[]
 * }} HwpDocument
 */

/**
 * Build the full HwpDocument from a raw ArrayBuffer.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {Promise<HwpDocument>}
 */
export async function buildDocument(buffer) {
  // 1. Parse CFB container
  const cfb = parseCfb(buffer);

  // 2. Parse FileHeader (never compressed)
  const fileHeaderBytes = readStream(cfb, 'FileHeader');
  const { version, flags } = parseFileHeader(fileHeaderBytes);

  // 3. Preview text (PrvText stream, UTF-16LE, optional)
  let previewText = null;
  try {
    const prvTextBytes = readStream(cfb, 'PrvText');
    previewText = new TextDecoder('utf-16le').decode(prvTextBytes);
  } catch (_) {
    // PrvText is optional — ignore ERR_STREAM_NOT_FOUND
  }

  // 4. DocInfo — decompress if compressed, then extract idMappings
  let idMappings = null;
  try {
    let docInfoBytes = readStream(cfb, 'DocInfo');
    if (flags.compressed) {
      docInfoBytes = await decompressStream(docInfoBytes, 'DocInfo');
    }
    // Extract ID_MAPPINGS (tag 0x11) from DocInfo records
    for (const rec of decodeRecords(docInfoBytes)) {
      if (rec.tagId === TAGS.ID_MAPPINGS) {
        // idMappings payload: array of int32 counts
        const view = new DataView(rec.payload.buffer, rec.payload.byteOffset, rec.payload.byteLength);
        idMappings = [];
        for (let i = 0; i + 3 < rec.payload.length; i += 4) {
          idMappings.push(view.getInt32(i, true));
        }
        break;
      }
    }
  } catch (err) {
    if (err instanceof HwpError && err.code === 'ERR_STREAM_NOT_FOUND') {
      // DocInfo optional for minimal synthetic documents
    } else {
      throw err;
    }
  }

  // 5. Find and parse BodyText sections
  const sectionNames = findBodyTextStreams(cfb);
  const sections = [];

  for (let i = 0; i < sectionNames.length; i++) {
    let sectionBytes = readStream(cfb, sectionNames[i], ['BodyText']);
    if (flags.compressed) {
      sectionBytes = await decompressStream(sectionBytes, `BodyText/${sectionNames[i]}`);
    }
    sections.push(parseSection(sectionBytes, i));
  }

  return {
    version,
    flags,
    previewText,
    docInfo: { idMappings },
    sections,
  };
}
