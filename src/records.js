/**
 * src/records.js — HWP record stream decoder + HWPTAG constants.
 *
 * Implements:
 *   decodeRecords(bytes)         — generator yielding { tagId, level, size, payload }
 *   decodeParagraphText(payload) — { text: string, controls: InlineControl[] }
 *   TAGS                         — frozen object of HWPTAG_* constants
 *   TAG_NAMES                    — reverse map number → name
 *
 * No DOM dependencies; runs in Node for unit tests.
 * Imports only HwpError and ERR_RECORD_OVERRUN from src/cfb.js.
 */

import { HwpError, ERR_RECORD_OVERRUN } from './cfb.js';

// ── HWPTAG constants (design §4.2) ────────────────────────────────────────────

/**
 * All known HWPTAG identifiers.
 * Names follow the HWPTAG_* convention from the HWP 5.0 specification.
 */
export const TAGS = Object.freeze({
  // ── DocInfo records (HWPTAG_BEGIN = 0x10) ──────────────────────────────────
  DOCUMENT_PROPERTIES:    0x10,
  ID_MAPPINGS:            0x11,
  BIN_DATA:               0x12,
  FACE_NAME:              0x13,
  BORDER_FILL:            0x14,
  CHAR_SHAPE:             0x15,
  TAB_DEF:                0x16,
  NUMBERING:              0x17,
  BULLET:                 0x18,
  PARA_SHAPE:             0x19,
  STYLE:                  0x1A,
  DOC_DATA:               0x1B,
  DISTRIBUTE_DOC_DATA:    0x1C,
  COMPATIBLE_DOCUMENT:    0x1E,
  LAYOUT_COMPATIBILITY:   0x1F,
  TRACKCHANGE:            0x20,

  // ── BodyText section records ──────────────────────────────────────────────
  PARA_HEADER:            0x42,
  PARA_TEXT:              0x43,
  PARA_CHAR_SHAPE:        0x44,
  PARA_LINE_SEG:          0x45,
  PARA_RANGE_TAG:         0x46,
  CTRL_HEADER:            0x47,
  LIST_HEADER:            0x48,
  PAGE_DEF:               0x49,
  FOOTNOTE_SHAPE:         0x4A,
  PAGE_BORDER_FILL:       0x4B,
  SHAPE_COMPONENT:        0x4C,
  TABLE:                  0x4D,
  SHAPE_COMPONENT_LINE:   0x4E,
  SHAPE_COMPONENT_RECT:   0x4F,
  SHAPE_COMPONENT_ELLIPSE:0x50,
  SHAPE_COMPONENT_ARC:    0x51,
  SHAPE_COMPONENT_POLYGON:0x52,
  SHAPE_COMPONENT_CURVE:  0x53,
  SHAPE_COMPONENT_OLE:    0x54,
  SHAPE_COMPONENT_PICTURE:0x55,
  SHAPE_COMPONENT_CONTAINER:0x56,
  CTRL_DATA:              0x57,
  EQEDIT:                 0x58,
  SHAPE_COMPONENT_TEXTART:0x59,
  FORM_OBJECT:            0x5A,
  MEMO_SHAPE:             0x5B,
  MEMO_LIST:              0x5C,
  FORBIDDEN_CHAR:         0x5D,
  CHART_DATA:             0x5E,
  TRACK_CHANGE:           0x60,
});

/**
 * Reverse map: tag number → name string.
 * Built from TAGS; duplicate values (TABLE/SHAPE_COMPONENT_LINE, CELL/etc.)
 * keep the last name encountered in object iteration order.
 */
export const TAG_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(TAGS).map(([name, id]) => [id, name])
  )
);

// ── Record decoder (design §4.1) ──────────────────────────────────────────────

/**
 * Decode an HWP record stream as a generator.
 *
 * Each yielded record is:
 *   { tagId: number, level: number, size: number, payload: Uint8Array }
 *
 * The `payload` is a subarray of `bytes` (zero-copy slice).
 *
 * @param {Uint8Array} bytes  Raw record stream bytes (decompressed)
 * @yields {{ tagId: number, level: number, size: number, payload: Uint8Array }}
 */
export function* decodeRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) {
      throw new HwpError(
        ERR_RECORD_OVERRUN,
        '레코드 헤더가 스트림 끝을 넘어섭니다',
        'Record header extends past end of stream'
      );
    }

    const hdr   = view.getUint32(pos, true);
    pos += 4;

    const tagId = hdr & 0x3FF;
    const level = (hdr >>> 10) & 0x3FF;
    let   size  = (hdr >>> 20) & 0xFFF;

    // HWPTAG ids live in 0x10–0x60. An unknown id in the last few bytes of a
    // stream is writer padding, not a record; anywhere else it is corruption.
    if (tagId < 0x10 || tagId > 0x60) {
      if (bytes.length - (pos - 4) <= 20) break;
    }

    // Extended size: if the 12-bit size field is 0xFFF, the real size follows
    // as a full uint32.
    if (size === 0xFFF) {
      if (pos + 4 > bytes.length) {
        throw new HwpError(
          ERR_RECORD_OVERRUN,
          '확장 레코드 크기 필드가 스트림 끝을 넘어섭니다',
          'Extended record size field extends past end of stream'
        );
      }
      size = view.getUint32(pos, true);
      pos += 4;
    }

    if (pos + size > bytes.length) {
      throw new HwpError(
        ERR_RECORD_OVERRUN,
        `레코드 페이로드가 스트림 끝을 넘어섭니다 (tagId=0x${tagId.toString(16)}, size=${size})`,
        `Record payload extends past end of stream (tagId=0x${tagId.toString(16)}, size=${size})`
      );
    }

    yield {
      tagId,
      level,
      size,
      payload: bytes.subarray(pos, pos + size),
    };

    pos += size;
  }
}

// ── Paragraph text decoder (design §4.3) ─────────────────────────────────────

/**
 * @typedef {{ type: number, payload: Uint8Array }} InlineControl
 */

/**
 * Decode a HWPTAG_PARA_TEXT payload into plain text and inline controls.
 *
 * The payload is a sequence of UTF-16LE 16-bit code units.  Special values
 * below 0x0020 carry inline formatting or control codes that are 16 bytes
 * total (2 bytes for the code unit + 14 bytes of additional data).
 *
 * @param {Uint8Array} payload
 * @returns {{ text: string, controls: InlineControl[] }}
 */
/**
 * Bytes that follow each control code inside a PARA_TEXT record (excluding the
 * 2-byte code itself). Measured against documents written by Hangul 2022/2024:
 * the block controls (0x02 section, 0x03 column, 0x0B table, 0x0C picture,
 * 0x04–0x08 notes/headers/drawings) carry 4-byte id + 8-byte parameters = 12.
 * Character markers (0x001F and friends) carry none.
 */
const CONTROL_EXTRA_BYTES = Object.freeze({
  0x0000: 0, 0x0001: 12, 0x0002: 12, 0x0003: 12, 0x0004: 12, 0x0005: 12,
  0x0006: 12, 0x0007: 12, 0x0008: 12, 0x000B: 12, 0x000C: 12, 0x000E: 12,
  0x000F: 12, 0x0010: 12, 0x0011: 12, 0x0012: 12, 0x0013: 12, 0x0014: 12,
  0x0015: 12, 0x0016: 12, 0x0017: 12, 0x0018: 12, 0x0019: 12, 0x001A: 12,
  0x001B: 12, 0x001C: 12, 0x001D: 12, 0x001E: 12, 0x001F: 0,
});

export function decodeParagraphText(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  /** @type {number[]} Accumulated UTF-16LE code units for plain text */
  const charUnits = [];
  /** @type {InlineControl[]} */
  const controls = [];

  let pos = 0;
  while (pos + 2 <= payload.length) {
    const cp = view.getUint16(pos, true);
    pos += 2;

    if (cp >= 0x0020) {
      // Plain character — accumulate as UTF-16LE code unit
      charUnits.push(cp);
    } else if (cp === 0x000D || cp === 0x000A) {
      // Paragraph break or line break → newline
      charUnits.push(0x000A); // '\n'
    } else if (cp === 0x0009) {
      // Tab
      charUnits.push(0x0009); // '\t'
    } else if (cp === 0x001F) {
      // HWP's non-breaking space ("묶음 빈칸"): renders as a space, no payload.
      charUnits.push(0x0020);
    } else {
      // Inline / extended control (0x0000–0x001F, excluding tab/CR/LF).
      // How many bytes follow depends on the control: the block-level controls
      // (section, column, table, footnote, header/footer, drawing object) carry
      // a 4-byte control id plus 8 bytes of parameters, while character-level
      // markers such as 0x001F carry nothing. Getting this wrong shifts every
      // following character, so the sizes are listed explicitly.
      const extra = CONTROL_EXTRA_BYTES[cp] ?? 0;
      const ctrlPayload = payload.subarray(pos, Math.min(pos + extra, payload.length));
      pos += extra;
      controls.push({ type: cp, payload: ctrlPayload });
    }
  }

  // Decode all accumulated code units as UTF-16LE in one shot so that
  // surrogate pairs (rare but valid in Korean text) are handled correctly.
  let text;
  if (charUnits.length === 0) {
    text = '';
  } else {
    // Build a Uint8Array of little-endian uint16 values
    const textBytes = new Uint8Array(charUnits.length * 2);
    const textView  = new DataView(textBytes.buffer);
    for (let i = 0; i < charUnits.length; i++) {
      textView.setUint16(i * 2, charUnits[i], true);
    }
    text = new TextDecoder('utf-16le').decode(textBytes);
  }

  return { text, controls };
}
