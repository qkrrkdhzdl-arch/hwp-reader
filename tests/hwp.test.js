/**
 * tests/hwp.test.js — Unit tests for src/hwp.js
 *
 * Covers:
 *   - decodeParagraphText (TASK-16)
 *   - parseFileHeader
 *   - parseSection
 *   - buildDocument golden test against tests/fixtures/sample.hwp (TASK-22)
 *
 * Run with: node --test tests/hwp.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeParagraphText } from '../src/records.js';
import { parseFileHeader, parseSection, findBodyTextStreams, buildDocument } from '../src/hwp.js';
import { HwpError, ERR_NOT_HWP, ERR_HWP_VERSION, ERR_ENCRYPTED,
         ERR_DISTRIBUTION } from '../src/cfb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeUint16LE(buf, offset, value) {
  buf[offset]     =  value        & 0xFF;
  buf[offset + 1] = (value >>>  8) & 0xFF;
}

function writeUint32LE(buf, offset, value) {
  buf[offset]     =  value        & 0xFF;
  buf[offset + 1] = (value >>>  8) & 0xFF;
  buf[offset + 2] = (value >>> 16) & 0xFF;
  buf[offset + 3] = (value >>> 24) & 0xFF;
}

function writeInt32LE(buf, offset, value) {
  writeUint32LE(buf, offset, value >>> 0);
}

function encodeUtf16LE(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    writeUint16LE(out, i * 2, str.charCodeAt(i));
  }
  return out;
}

/**
 * Build a HWPTAG_PARA_TEXT payload from a mix of:
 *   - plain string segments (encoded as UTF-16LE code units)
 *   - special code points (number)
 *   - inline controls ({ type: number, extraBytes: Uint8Array })
 */
function buildParaTextPayload(items) {
  const parts = [];
  for (const item of items) {
    if (typeof item === 'string') {
      parts.push(encodeUtf16LE(item));
    } else if (typeof item === 'number') {
      const b = new Uint8Array(2);
      writeUint16LE(b, 0, item);
      parts.push(b);
    } else if (item && typeof item === 'object' && 'type' in item) {
      // Inline control: 2-byte code point followed by its payload
      const extra = item.extraBytes ? item.extraBytes.length : 0;
      const b = new Uint8Array(2 + extra);
      writeUint16LE(b, 0, item.type);
      if (item.extraBytes) b.set(item.extraBytes, 2);
      parts.push(b);
    }
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

/**
 * Build a minimal record header for a single record.
 * bits 0-9: tagId, bits 10-19: level, bits 20-31: size
 */
function makeRecordHeader(tagId, level, size) {
  return (tagId & 0x3FF) | ((level & 0x3FF) << 10) | ((size & 0xFFF) << 20);
}

function buildOneRecord(tagId, level, payloadBytes) {
  const buf = new Uint8Array(4 + payloadBytes.length);
  writeUint32LE(buf, 0, makeRecordHeader(tagId, level, payloadBytes.length));
  buf.set(payloadBytes, 4);
  return buf;
}

// ── TASK-16: decodeParagraphText ──────────────────────────────────────────────

describe('decodeParagraphText — basic Korean + ASCII', () => {
  it('extracts Korean text, paragraph break, and ASCII text', () => {
    // 안녕하세요 (5 chars) + 0x000D (paragraph break) + Hello (5 chars)
    const payload = buildParaTextPayload(['안녕하세요', 0x000D, 'Hello']);
    const { text, controls } = decodeParagraphText(payload);
    assert.equal(text, '안녕하세요\nHello');
    assert.equal(controls.length, 0);
  });

  it('extracts text with one inline control', () => {
    // 안녕하세요 + 0x000D + Hello + inline control (type=0x0000)
    // Block control 0x0002 (section definition) carries 12 payload bytes.
    const extraBytes = new Uint8Array(12).fill(0xAB);
    const payload = buildParaTextPayload([
      '안녕하세요',
      0x000D,
      'Hello',
      { type: 0x0002, extraBytes },
    ]);
    const { text, controls } = decodeParagraphText(payload);
    assert.equal(text, '안녕하세요\nHello');
    assert.equal(controls.length, 1);
    assert.equal(controls[0].type, 0x0002);
  });
});

describe('decodeParagraphText — special code points', () => {
  it('converts 0x000A (line break) to \\n', () => {
    const payload = buildParaTextPayload(['A', 0x000A, 'B']);
    const { text } = decodeParagraphText(payload);
    assert.equal(text, 'A\nB');
  });

  it('converts 0x0009 (tab) to \\t', () => {
    const payload = buildParaTextPayload(['A', 0x0009, 'B']);
    const { text } = decodeParagraphText(payload);
    assert.equal(text, 'A\tB');
  });

  it('handles multiple inline controls', () => {
    const payload = buildParaTextPayload([
      { type: 0x0001, extraBytes: new Uint8Array(12) },
      'X',
      { type: 0x0002, extraBytes: new Uint8Array(12) },
    ]);
    const { text, controls } = decodeParagraphText(payload);
    assert.equal(text, 'X');
    assert.equal(controls.length, 2);
    assert.equal(controls[0].type, 0x0001);
    assert.equal(controls[1].type, 0x0002);
  });

  it('returns empty text and no controls for an empty payload', () => {
    const { text, controls } = decodeParagraphText(new Uint8Array(0));
    assert.equal(text, '');
    assert.equal(controls.length, 0);
  });
});

// ── parseFileHeader ───────────────────────────────────────────────────────────

function makeFileHeader({
  signature = 'HWP Document File\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00',
  major = 5, minor = 0, build = 0, revision = 0,
  flags = 0,
} = {}) {
  const buf = new Uint8Array(256);
  for (let i = 0; i < 32; i++) buf[i] = signature.charCodeAt(i) & 0xFF;
  buf[32] = revision;
  buf[33] = build;
  buf[34] = minor;
  buf[35] = major;
  writeUint32LE(buf, 36, flags);
  return buf;
}

describe('parseFileHeader', () => {
  it('parses a valid v5 header with no flags', () => {
    const bytes = makeFileHeader();
    const { version, flags } = parseFileHeader(bytes);
    assert.equal(version.major, 5);
    assert.equal(version.minor, 0);
    assert.equal(flags.compressed, false);
    assert.equal(flags.encrypted, false);
  });

  it('recognises the compressed flag (bit 0)', () => {
    const bytes = makeFileHeader({ flags: 0x01 });
    const { flags } = parseFileHeader(bytes);
    assert.equal(flags.compressed, true);
  });

  it('throws ERR_NOT_HWP on wrong signature', () => {
    const bytes = makeFileHeader({ signature: 'WRONG SIGNATURE\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00' });
    assert.throws(
      () => parseFileHeader(bytes),
      (err) => err instanceof HwpError && err.code === ERR_NOT_HWP
    );
  });

  it('throws ERR_HWP_VERSION for major version 4', () => {
    const bytes = makeFileHeader({ major: 4 });
    assert.throws(
      () => parseFileHeader(bytes),
      (err) => err instanceof HwpError && err.code === ERR_HWP_VERSION
    );
  });

  it('throws ERR_ENCRYPTED for encrypted flag (bit 1)', () => {
    const bytes = makeFileHeader({ flags: 0x02 });
    assert.throws(
      () => parseFileHeader(bytes),
      (err) => err instanceof HwpError && err.code === ERR_ENCRYPTED
    );
  });

  it('throws ERR_ENCRYPTED for DRM flag (bit 4)', () => {
    const bytes = makeFileHeader({ flags: 0x10 });
    assert.throws(
      () => parseFileHeader(bytes),
      (err) => err instanceof HwpError && err.code === ERR_ENCRYPTED
    );
  });

  it('throws ERR_DISTRIBUTION for distribution flag (bit 2)', () => {
    const bytes = makeFileHeader({ flags: 0x04 });
    assert.throws(
      () => parseFileHeader(bytes),
      (err) => err instanceof HwpError && err.code === ERR_DISTRIBUTION
    );
  });
});

// ── parseSection ──────────────────────────────────────────────────────────────

const HWPTAG_PARA_HEADER = 0x42;
const HWPTAG_PARA_TEXT   = 0x43;
const HWPTAG_CTRL_HEADER = 0x47;
const HWPTAG_TABLE       = 0x4D;
const HWPTAG_CELL        = 0x48; // LIST_HEADER opens one table cell

function concatBuffers(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

describe('parseSection — basic paragraphs', () => {
  it('parses two paragraphs with text', () => {
    // Build a minimal section stream: PARA_HEADER + PARA_TEXT × 2
    const p1Text = buildParaTextPayload(['가나다']);
    const p2Text = buildParaTextPayload(['ABC']);

    const stream = concatBuffers(
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
      buildOneRecord(HWPTAG_PARA_TEXT,   1, p1Text),
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
      buildOneRecord(HWPTAG_PARA_TEXT,   1, p2Text),
    );

    const section = parseSection(stream, 0);
    assert.equal(section.index, 0);
    assert.equal(section.paragraphs.length, 2);
    assert.equal(section.paragraphs[0].text, '가나다');
    assert.equal(section.paragraphs[1].text, 'ABC');
  });

  it('assigns paragraph indices sequentially', () => {
    const stream = concatBuffers(
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
    );
    const { paragraphs } = parseSection(stream, 0);
    assert.equal(paragraphs.length, 3);
    assert.equal(paragraphs[0].index, 0);
    assert.equal(paragraphs[1].index, 1);
    assert.equal(paragraphs[2].index, 2);
  });

  it('returns an empty section for an empty stream', () => {
    const section = parseSection(new Uint8Array(0), 2);
    assert.equal(section.index, 2);
    assert.equal(section.paragraphs.length, 0);
  });
});

describe('parseSection — table', () => {
  it('attaches a table to the paragraph that contains it', () => {
    // CTRL_HEADER with ctrlId = 0x74626C20 (table) + TABLE record (rowCount=2, colCount=3)
    const ctrlPayload = new Uint8Array(4);
    // Write ctrlId = 0x74626C20 LE
    writeUint32LE(ctrlPayload, 0, 0x74626C20);

    const tablePayload = new Uint8Array(8);
    // offset 4: rowCount=2, offset 6: colCount=3
    writeUint16LE(tablePayload, 4, 2);
    writeUint16LE(tablePayload, 6, 3);

    const stream = concatBuffers(
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
      buildOneRecord(HWPTAG_CTRL_HEADER, 1, ctrlPayload),
      buildOneRecord(HWPTAG_TABLE,       1, tablePayload),
    );

    const { paragraphs } = parseSection(stream, 0);
    assert.equal(paragraphs.length, 1);
    assert.equal(paragraphs[0].hasTable, true);
    assert.ok(paragraphs[0].table);
    assert.equal(paragraphs[0].table.rowCount, 2);
    assert.equal(paragraphs[0].table.colCount, 3);
  });

  it('attaches cells to the table', () => {
    const ctrlPayload = new Uint8Array(4);
    writeUint32LE(ctrlPayload, 0, 0x74626C20);

    const tablePayload = new Uint8Array(8);
    writeUint16LE(tablePayload, 4, 1); // rowCount=1
    writeUint16LE(tablePayload, 6, 2); // colCount=2

    // Cells are LIST_HEADER records in document (row-major) order; the grid
    // position is derived from that order, not stored per record.
    const cell0 = new Uint8Array(8);
    const cell1 = new Uint8Array(8);

    const stream = concatBuffers(
      buildOneRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
      buildOneRecord(HWPTAG_CTRL_HEADER, 1, ctrlPayload),
      buildOneRecord(HWPTAG_TABLE,       1, tablePayload),
      buildOneRecord(HWPTAG_CELL,        2, cell0),
      buildOneRecord(HWPTAG_CELL,        2, cell1),
    );

    const { paragraphs } = parseSection(stream, 0);
    const table = paragraphs[0].table;
    assert.ok(table);
    assert.equal(table.cells.length, 2);
    assert.equal(table.cells[0].col, 0);
    assert.equal(table.cells[0].row, 0);
    assert.equal(table.cells[1].col, 1);
    assert.equal(table.cells[1].row, 0);
  });
});

// ── TASK-22: Golden test — sample.hwp vs sample.expected.json ─────────────────

/**
 * Replacer used to serialise the live document to a comparable JSON string.
 * Uint8Array → lowercase hex string; ArrayBuffer fields are dropped.
 * Must match the replacer used to generate sample.expected.json.
 */
function docReplacer(key, value) {
  if (value instanceof Uint8Array) {
    return Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  if (value instanceof ArrayBuffer) return undefined;
  return value;
}

describe('buildDocument — golden test against sample.hwp', () => {
  it('parses sample.hwp and matches sample.expected.json exactly', async () => {
    const fixturesDir = join(__dirname, 'fixtures');
    // Use Uint8Array directly to avoid Node.js Buffer offset issues with ArrayBuffer
    const hwpBytes    = new Uint8Array(readFileSync(join(fixturesDir, 'sample.hwp')));
    const expected    = JSON.parse(
      readFileSync(join(fixturesDir, 'sample.expected.json'), 'utf-8')
    );

    const doc    = await buildDocument(hwpBytes);
    const actual = JSON.parse(JSON.stringify(doc, docReplacer));

    assert.deepEqual(actual, expected);
  });

  it('sample.hwp has two top-level paragraphs with correct text', async () => {
    const hwpBytes = new Uint8Array(
      readFileSync(join(__dirname, 'fixtures', 'sample.hwp'))
    );
    const doc = await buildDocument(hwpBytes);
    const paras = doc.sections[0].paragraphs;
    assert.equal(paras[0].text, '가나다');
    assert.equal(paras[1].text, 'ABC');
  });

  it('sample.hwp has a 1×2 table in paragraph 2', async () => {
    const hwpBytes = new Uint8Array(
      readFileSync(join(__dirname, 'fixtures', 'sample.hwp'))
    );
    const doc   = await buildDocument(hwpBytes);
    const para2 = doc.sections[0].paragraphs[2];
    assert.equal(para2.hasTable, true);
    assert.equal(para2.table.rowCount, 1);
    assert.equal(para2.table.colCount, 2);
    assert.equal(para2.table.cells[0].paragraphs[0].text, '표1');
    assert.equal(para2.table.cells[1].paragraphs[0].text, '표2');
  });

  it('sample.hwp preview text matches the first paragraph text', async () => {
    const hwpBytes = new Uint8Array(
      readFileSync(join(__dirname, 'fixtures', 'sample.hwp'))
    );
    const doc = await buildDocument(hwpBytes);
    assert.equal(doc.previewText, '가나다 ABC');
  });
});
