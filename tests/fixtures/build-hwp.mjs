/**
 * tests/fixtures/build-hwp.mjs
 *
 * Builds a minimal valid HWP 5.0 file and writes it to
 * tests/fixtures/sample.hwp.
 *
 * The document contains:
 *   • Paragraph 0 — "가나다" (Korean)
 *   • Paragraph 1 — "ABC"   (ASCII)
 *   • Paragraph 2 — a 1×2 table
 *       cell (0,0): "표1" (Korean: "table 1")
 *       cell (0,1): "표2"
 *
 * Container: OLE2 Compound File Binary v3, 512-byte sectors, uncompressed.
 *
 * Stream layout:
 *   FileHeader  (256 bytes, top-level)
 *   DocInfo     (record stream, top-level)
 *   PrvText     (UTF-16LE preview, top-level)
 *   BodyText/
 *     Section0  (record stream with paragraphs and table)
 *
 * Run:  node tests/fixtures/build-hwp.mjs
 * Keep: this file documents the binary format; do not delete it.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Low-level write helpers ───────────────────────────────────────────────────

function writeUint8(buf, offset, v)  { buf[offset] = v & 0xFF; }
function writeUint16LE(buf, offset, v) {
  buf[offset]     =  v        & 0xFF;
  buf[offset + 1] = (v >>> 8) & 0xFF;
}
function writeUint32LE(buf, offset, v) {
  buf[offset]     =  v         & 0xFF;
  buf[offset + 1] = (v >>>  8) & 0xFF;
  buf[offset + 2] = (v >>> 16) & 0xFF;
  buf[offset + 3] = (v >>> 24) & 0xFF;
}
function writeInt32LE(buf, offset, v) { writeUint32LE(buf, offset, v >>> 0); }

function encodeUtf16LE(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    writeUint16LE(out, i * 2, str.charCodeAt(i));
  }
  return out;
}

// ── HWP record builder ────────────────────────────────────────────────────────

/**
 * Build a 4-byte record header word.
 *   bits  0– 9: tagId
 *   bits 10–19: level
 *   bits 20–31: size (capped at 0xFFE for inline; 0xFFF triggers extended)
 */
function makeRecordHeader(tagId, level, size) {
  const inlineSize = size >= 0xFFF ? 0xFFF : size;
  return (tagId & 0x3FF) | ((level & 0x3FF) << 10) | (inlineSize << 20);
}

/**
 * Encode one record as bytes.
 * Uses extended size header when payload >= 0xFFF bytes.
 */
function encodeRecord(tagId, level, payload) {
  const size = payload.length;
  const useExtended = size >= 0xFFF;
  const headerBytes = useExtended ? 8 : 4;
  const out = new Uint8Array(headerBytes + size);
  writeUint32LE(out, 0, makeRecordHeader(tagId, level, size));
  if (useExtended) writeUint32LE(out, 4, size);
  out.set(payload, headerBytes);
  return out;
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

// ── HWPTAG constants ──────────────────────────────────────────────────────────
const HWPTAG_DOCUMENT_PROPERTIES = 0x10;
const HWPTAG_PARA_HEADER         = 0x42;
const HWPTAG_PARA_TEXT           = 0x43;
const HWPTAG_CTRL_HEADER         = 0x47;
const HWPTAG_LIST_HEADER         = 0x48;
const HWPTAG_TABLE               = 0x4D;

// Table control ID: "tbl " as little-endian uint32
// bytes: 0x74='t', 0x62='b', 0x6C='l', 0x20=' '
const CTRL_ID_TABLE = 0x74626C20;

// ── HWP stream builders ───────────────────────────────────────────────────────

/**
 * Build the 256-byte FileHeader stream.
 * Flags = 0: not compressed, not encrypted, not distribution copy.
 */
function buildFileHeader() {
  const buf = new Uint8Array(256);
  // 32-byte signature: "HWP Document File" + NUL padding
  const sig = 'HWP Document File';
  for (let i = 0; i < sig.length; i++) buf[i] = sig.charCodeAt(i);
  // version: [revision, build, minor, major] at offsets 32–35
  buf[32] = 0; // revision
  buf[33] = 0; // build
  buf[34] = 0; // minor
  buf[35] = 5; // major = 5
  // flags uint32 at offset 36: 0x00 = uncompressed, unencrypted
  writeUint32LE(buf, 36, 0x00000000);
  return buf;
}

/**
 * Build the DocInfo stream.
 * Contains a minimal HWPTAG_DOCUMENT_PROPERTIES record (8 bytes of zeros).
 * Uncompressed (flags.compressed = false).
 */
function buildDocInfo() {
  // DOCUMENT_PROPERTIES payload: at minimum 8 bytes for the basic property fields
  const payload = new Uint8Array(8); // all zeros: sectionCount=0, etc.
  return encodeRecord(HWPTAG_DOCUMENT_PROPERTIES, 0, payload);
}

/**
 * Build the PrvText stream.
 * Preview text: first few chars of the document, UTF-16LE, no BOM.
 */
function buildPrvText() {
  return encodeUtf16LE('가나다 ABC');
}

/**
 * Build a PARA_TEXT payload encoding `str` as plain UTF-16LE code units.
 * All characters are >= 0x0020, so there are no inline controls.
 */
function buildParaText(str) {
  return encodeUtf16LE(str);
}

/**
 * Build the BodyText/Section0 stream.
 *
 * Record tree:
 *
 *  PARA_HEADER  level=0            paragraph 0 ("가나다")
 *    PARA_TEXT  level=1
 *  PARA_HEADER  level=0            paragraph 1 ("ABC")
 *    PARA_TEXT  level=1
 *  PARA_HEADER  level=0            paragraph 2 (table host)
 *    CTRL_HEADER level=1  ctrlId=CTRL_ID_TABLE
 *    TABLE       level=1  rowCount=1, colCount=2
 *    LIST_HEADER level=2            cell (0,0)
 *      PARA_HEADER level=2
 *        PARA_TEXT   level=3
 *    LIST_HEADER level=2            cell (0,1)
 *      PARA_HEADER level=2
 *        PARA_TEXT   level=3
 *
 * Level analysis against parseSection:
 *   tableCtlLevel = 1 (CTRL_HEADER level)
 *   LIST_HEADER level=2 > tableCtlLevel=1 → opens cell ✓
 *   PARA_HEADER inside cell level=2 > tableCtlLevel=1 → stays in table ✓
 *   (no PARA_HEADER after table at level 0: table closes when stream ends)
 */
function buildSection0() {
  // CTRL_HEADER payload: 4-byte ctrlId
  const ctrlHeaderPayload = new Uint8Array(4);
  writeUint32LE(ctrlHeaderPayload, 0, CTRL_ID_TABLE);

  // TABLE payload: at least 8 bytes; rowCount at offset 4, colCount at offset 6
  const tablePayload = new Uint8Array(8);
  writeUint16LE(tablePayload, 4, 1); // rowCount = 1
  writeUint16LE(tablePayload, 6, 2); // colCount = 2

  // LIST_HEADER payload: minimal (8 bytes of zeros)
  const listHeaderPayload = new Uint8Array(8);

  return concat(
    // ── Paragraph 0: "가나다" ─────────────────────────────────────────────
    encodeRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
    encodeRecord(HWPTAG_PARA_TEXT,   1, buildParaText('가나다')),
    // ── Paragraph 1: "ABC" ───────────────────────────────────────────────
    encodeRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
    encodeRecord(HWPTAG_PARA_TEXT,   1, buildParaText('ABC')),
    // ── Paragraph 2: table host ──────────────────────────────────────────
    encodeRecord(HWPTAG_PARA_HEADER, 0, new Uint8Array(0)),
    encodeRecord(HWPTAG_CTRL_HEADER, 1, ctrlHeaderPayload),
    encodeRecord(HWPTAG_TABLE,       1, tablePayload),
    // ── Cell (0,0): "표1" ────────────────────────────────────────────────
    encodeRecord(HWPTAG_LIST_HEADER, 2, listHeaderPayload),
    encodeRecord(HWPTAG_PARA_HEADER, 2, new Uint8Array(0)),
    encodeRecord(HWPTAG_PARA_TEXT,   3, buildParaText('표1')),
    // ── Cell (0,1): "표2" ────────────────────────────────────────────────
    encodeRecord(HWPTAG_LIST_HEADER, 2, listHeaderPayload),
    encodeRecord(HWPTAG_PARA_HEADER, 2, new Uint8Array(0)),
    encodeRecord(HWPTAG_PARA_TEXT,   3, buildParaText('표2')),
  );
}

// ── CFB v3 container builder ──────────────────────────────────────────────────

const ENDOFCHAIN = 0xFFFFFFFE;
const FREESECT   = 0xFFFFFFFF;
const FATSECT    = 0xFFFFFFFD;
const NOSTREAM   = 0xFFFFFFFF;
const SECTOR     = 512;

/**
 * Write a 128-byte directory entry at `offset` in `buf`.
 *
 * Entry layout per [MS-CFB] §2.6.1:
 *   0–63   : UTF-16LE name (zero-padded)
 *   64–65  : name byte length (including NUL terminator)
 *   66     : object type (0=empty, 1=storage, 2=stream, 5=root)
 *   67     : colour (0=red, 1=black; use black for all)
 *   68–71  : left SID
 *   72–75  : right SID
 *   76–79  : child SID
 *   116–119: start sector (or ENDOFCHAIN if empty)
 *   120–123: size in bytes
 */
function writeDirEntry(buf, offset, {
  name         = '',
  type         = 0,
  leftSid      = NOSTREAM,
  rightSid     = NOSTREAM,
  childSid     = NOSTREAM,
  startSector  = ENDOFCHAIN,
  size         = 0,
  color        = 1,
}) {
  // Clear the 128-byte slot first (important: name field must be zero-padded)
  buf.fill(0, offset, offset + 128);

  if (name.length > 0) {
    const nameBytes = encodeUtf16LE(name);
    buf.set(nameBytes, offset);
    // nameByteLen includes the two-byte NUL terminator
    writeUint16LE(buf, offset + 64, nameBytes.length + 2);
  }
  buf[offset + 66] = type;
  buf[offset + 67] = color;
  writeInt32LE(buf, offset + 68, leftSid);
  writeInt32LE(buf, offset + 72, rightSid);
  writeInt32LE(buf, offset + 76, childSid);
  writeInt32LE(buf, offset + 116, startSector);
  writeUint32LE(buf, offset + 120, size);
}

/**
 * Pad a byte array to a multiple of `align` bytes.
 */
function padTo(bytes, align) {
  const rem = bytes.length % align;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (align - rem));
  out.set(bytes);
  return out;
}

/**
 * Assign FAT sectors to a data buffer and return the sector chain.
 *
 * @param {Int32Array} fat      FAT table (modified in place)
 * @param {number}     startId  First free sector ID
 * @param {number}     byteLen  Byte length of the data
 * @returns {{ firstSector: number, sectorCount: number, nextFree: number }}
 */
function allocChain(fat, startId, byteLen) {
  if (byteLen === 0) return { firstSector: ENDOFCHAIN >>> 0, sectorCount: 0, nextFree: startId };
  const count = Math.ceil(byteLen / SECTOR);
  for (let i = 0; i < count - 1; i++) fat[startId + i] = startId + i + 1;
  fat[startId + count - 1] = ENDOFCHAIN | 0;
  return { firstSector: startId, sectorCount: count, nextFree: startId + count };
}

/**
 * Build a complete CFB v3 file buffer containing the HWP streams.
 *
 * Directory entry tree (SID assignments):
 *
 *   0: Root Entry     (type=5, root storage)
 *      child → 1
 *   1: FileHeader     (type=2, stream)
 *      left  → 2
 *      right → 3
 *   2: DocInfo        (type=2, stream)
 *   3: PrvText        (type=2, stream)
 *      left  → 4
 *   4: BodyText       (type=1, storage)
 *      child → 5
 *   5: Section0       (type=2, stream)
 *
 * Red-black tree colouring: all entries black (colour=1) is valid per spec
 * (the spec requires a valid RB tree only for directories with ≥ 2 entries
 * on the same level; a chain of one child is always valid with any colour).
 *
 * Sector layout (sector IDs are 0-based after the 512-byte file header):
 *
 *   Sector 0           : FAT sector
 *   Sectors 1–N_dir    : directory
 *   Sectors …          : FileHeader data
 *   Sectors …          : DocInfo data
 *   Sectors …          : PrvText data
 *   Sectors …          : BodyText/Section0 data
 */
function buildCfb(streams) {
  const {
    fileHeader,   // Uint8Array, exactly 256 bytes
    docInfo,      // Uint8Array
    prvText,      // Uint8Array
    section0,     // Uint8Array
  } = streams;

  // ── Pad all data to sector multiples ───────────────────────────────────────
  const fileHeaderPadded = padTo(fileHeader, SECTOR);
  const docInfoPadded    = padTo(docInfo,    SECTOR);
  const prvTextPadded    = padTo(prvText,    SECTOR);
  const section0Padded   = padTo(section0,   SECTOR);

  // ── Sector allocation plan ─────────────────────────────────────────────────
  // Sector 0 is the FAT sector.
  // Sector 1 is the directory sector (one sector = 4 entries × 128 bytes = 512
  //   bytes; we have 6 entries so we need 2 directory sectors).
  // Data sectors follow.

  const dirEntriesNeeded = 6; // 0:Root 1:FileHeader 2:DocInfo 3:PrvText 4:BodyText 5:Section0
  const dirSectorCount   = Math.ceil(dirEntriesNeeded * 128 / SECTOR); // = 2

  // Data sector offsets (sector IDs):
  //   0 = FAT
  //   1..dirSectorCount = directory
  let nextFree = 1 + dirSectorCount;

  const FAT_SIZE = 512; // one FAT sector handles up to 128 chains
  const fat = new Int32Array(128).fill(FREESECT | 0);

  // FAT sector itself is marked FATSECT
  fat[0] = FATSECT | 0;
  // Directory sectors: build a chain over sectors 1..dirSectorCount
  for (let s = 1; s < dirSectorCount; s++) fat[s] = s + 1;
  fat[dirSectorCount] = ENDOFCHAIN | 0;

  const dirFirstSector = 1;

  const fhAlloc = allocChain(fat, nextFree, fileHeader.length);
  nextFree = fhAlloc.nextFree;

  const diAlloc = allocChain(fat, nextFree, docInfo.length);
  nextFree = diAlloc.nextFree;

  const ptAlloc = allocChain(fat, nextFree, prvText.length);
  nextFree = ptAlloc.nextFree;

  const s0Alloc = allocChain(fat, nextFree, section0.length);
  nextFree = s0Alloc.nextFree;

  // ── File size ──────────────────────────────────────────────────────────────
  const totalSectors = nextFree;
  const fileSize = 512 + totalSectors * SECTOR;
  const buf = new Uint8Array(fileSize);

  // ── CFB header (512 bytes) ─────────────────────────────────────────────────
  const magic = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  buf.set(magic, 0);
  writeUint16LE(buf, 24, 0x003E);         // minor version
  writeUint16LE(buf, 26, 0x0003);         // major version = 3
  writeUint16LE(buf, 28, 0xFFFE);         // byte order LE
  writeUint16LE(buf, 30, 9);              // sector size = 2^9 = 512
  writeUint16LE(buf, 32, 6);              // mini sector size = 2^6 = 64
  writeUint32LE(buf, 44, 1);              // 1 FAT sector
  writeUint32LE(buf, 48, dirFirstSector); // first directory sector
  writeUint32LE(buf, 56, 4096);           // mini stream cutoff = 4096
  writeUint32LE(buf, 60, FREESECT);       // no mini-FAT
  writeUint32LE(buf, 64, 0);              // mini-FAT sector count = 0
  writeUint32LE(buf, 68, FREESECT);       // no DIFAT chain
  writeUint32LE(buf, 72, 0);              // DIFAT chain sector count = 0
  // DIFAT array: sector 0 is the FAT sector
  writeUint32LE(buf, 76, 0);              // DIFAT[0] = sector 0
  for (let i = 1; i < 109; i++) writeUint32LE(buf, 76 + i * 4, FREESECT);

  // ── Sector 0: FAT ─────────────────────────────────────────────────────────
  const fatOff = 512;
  for (let i = 0; i < 128; i++) {
    writeInt32LE(buf, fatOff + i * 4, fat[i]);
  }

  // ── Directory sectors ──────────────────────────────────────────────────────
  const dirOff = 512 + dirFirstSector * SECTOR;

  // SID 0: Root Entry  — child=1 (FileHeader)
  writeDirEntry(buf, dirOff,       {
    name: 'Root Entry', type: 5,
    childSid: 1,
    startSector: ENDOFCHAIN, size: 0,
  });

  // SID 1: FileHeader  — left=2, right=3
  writeDirEntry(buf, dirOff + 128, {
    name: 'FileHeader', type: 2,
    leftSid: 2, rightSid: 3,
    startSector: fhAlloc.firstSector, size: fileHeader.length,
  });

  // SID 2: DocInfo
  writeDirEntry(buf, dirOff + 256, {
    name: 'DocInfo', type: 2,
    startSector: diAlloc.firstSector, size: docInfo.length,
  });

  // SID 3: PrvText  — left=4 (BodyText)
  writeDirEntry(buf, dirOff + 384, {
    name: 'PrvText', type: 2,
    leftSid: 4,
    startSector: ptAlloc.firstSector, size: prvText.length,
  });

  // SID 4: BodyText storage  — child=5 (Section0)
  writeDirEntry(buf, dirOff + 512, {
    name: 'BodyText', type: 1,
    childSid: 5,
    startSector: ENDOFCHAIN, size: 0,
  });

  // SID 5: Section0
  writeDirEntry(buf, dirOff + 640, {
    name: 'Section0', type: 2,
    startSector: s0Alloc.firstSector, size: section0.length,
  });

  // ── Data sectors: FileHeader ───────────────────────────────────────────────
  buf.set(fileHeaderPadded, 512 + fhAlloc.firstSector * SECTOR);

  // ── Data sectors: DocInfo ─────────────────────────────────────────────────
  buf.set(docInfoPadded, 512 + diAlloc.firstSector * SECTOR);

  // ── Data sectors: PrvText ─────────────────────────────────────────────────
  buf.set(prvTextPadded, 512 + ptAlloc.firstSector * SECTOR);

  // ── Data sectors: BodyText/Section0 ──────────────────────────────────────
  buf.set(section0Padded, 512 + s0Alloc.firstSector * SECTOR);

  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const fileHeader = buildFileHeader();
const docInfo    = buildDocInfo();
const prvText    = buildPrvText();
const section0   = buildSection0();

const hwpBuffer = buildCfb({ fileHeader, docInfo, prvText, section0 });

const outPath = join(__dirname, 'sample.hwp');
writeFileSync(outPath, hwpBuffer);
console.log(`Wrote ${hwpBuffer.length} bytes to ${outPath}`);

// Verify it round-trips through the parser
// (requires the src/ modules to be importable from Node)
