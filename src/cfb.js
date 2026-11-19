/**
 * src/cfb.js — OLE2 Compound File Binary (CFB) parser.
 *
 * Implements the full CFB v3/v4 read path:
 *   parseHeader → buildFat → parseDirectories → buildMiniStream → readStream
 *
 * All entry points accept Uint8Array or ArrayBuffer and have zero DOM
 * dependencies, so they run in Node for unit tests.
 *
 * References:
 *   [MS-CFB] Compound File Binary Format, Revision 8.0
 *   https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb
 */

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Structured parsing error.  All parser modules throw HwpError, never plain
 * Error, so the caller can distinguish categories by `err.code`.
 */
export class HwpError extends Error {
  /**
   * @param {string} code      ERR_* constant
   * @param {string} messageKo Human-readable Korean message
   * @param {string} messageEn Human-readable English message
   */
  constructor(code, messageKo, messageEn) {
    super(`${messageKo} / ${messageEn}`);
    this.code = code;
    this.name = 'HwpError';
  }
}

// ── ERR_* codes ───────────────────────────────────────────────────────────────

export const ERR_NOT_CFB          = 'ERR_NOT_CFB';
export const ERR_CFB_VERSION      = 'ERR_CFB_VERSION';
export const ERR_CFB_CORRUPT      = 'ERR_CFB_CORRUPT';
export const ERR_STREAM_NOT_FOUND = 'ERR_STREAM_NOT_FOUND';
export const ERR_NOT_HWP          = 'ERR_NOT_HWP';
export const ERR_HWP_VERSION      = 'ERR_HWP_VERSION';
export const ERR_ENCRYPTED        = 'ERR_ENCRYPTED';
export const ERR_DISTRIBUTION     = 'ERR_DISTRIBUTION';
export const ERR_DECOMPRESS_FAILED = 'ERR_DECOMPRESS_FAILED';
export const ERR_RECORD_OVERRUN   = 'ERR_RECORD_OVERRUN';
export const ERR_NO_BODY          = 'ERR_NO_BODY';

// ── CFB constants ─────────────────────────────────────────────────────────────

const CFB_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

const ENDOFCHAIN  = 0xFFFFFFFE | 0; // -2  as Int32
const FREESECT    = 0xFFFFFFFF | 0; // -1  as Int32
const DIFSECT     = 0xFFFFFFFC | 0; // -4  as Int32
const FATSECT     = 0xFFFFFFFD | 0; // -3  as Int32
const NOSTREAM    = 0xFFFFFFFF | 0; // -1  as Int32 (also used for SID "none")

// Directory entry types
const TYPE_EMPTY   = 0;
const TYPE_STORAGE = 1;
const TYPE_STREAM  = 2;
const TYPE_ROOT    = 5;

// ── Data classes ──────────────────────────────────────────────────────────────

/**
 * Represents the parsed state of one CFB file.
 */
export class CfbFile {
  constructor() {
    /** @type {number} */
    this.sectorSize = 512;
    /** @type {number} */
    this.miniSectorSize = 64;
    /** @type {number} */
    this.miniStreamCutoff = 4096;
    /** @type {Int32Array} */
    this.fat = null;
    /** @type {Int32Array} */
    this.miniFat = null;
    /** @type {DirEntry[]} */
    this.directories = [];
    /** @type {Uint8Array} — content of the root entry's stream container */
    this.miniStreamData = null;
    /** @type {Uint8Array} — raw byte view of the full file */
    this._bytes = null;
  }
}

/**
 * One directory entry (128 bytes on disk).
 */
export class DirEntry {
  constructor() {
    /** @type {number} 0-based index */
    this.sid = 0;
    /** @type {string} decoded UTF-16LE name */
    this.name = '';
    /** @type {number} 0=empty 1=storage 2=stream 5=root */
    this.type = TYPE_EMPTY;
    /** @type {number} */
    this.startSector = 0;
    /** @type {number} */
    this.size = 0;
    /** @type {number} */
    this.childSid = NOSTREAM;
    /** @type {number} */
    this.leftSid = NOSTREAM;
    /** @type {number} */
    this.rightSid = NOSTREAM;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Convert ArrayBuffer → Uint8Array if needed. */
function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new HwpError(ERR_NOT_CFB,
    '입력이 ArrayBuffer 또는 Uint8Array가 아닙니다',
    'Input is not an ArrayBuffer or Uint8Array');
}

/**
 * Byte offset of the first byte of sector `id` in the file.
 * The 512-byte file header always precedes sector 0, regardless of sector size.
 */
function sectorOffset(id, sectorSize) {
  return 512 + id * sectorSize;
}

/**
 * Read a chain of sectors from the main FAT and return them concatenated.
 * `maxLength` limits the output to the entry's declared size (avoids reading
 * slack bytes in the last sector).
 */
function readFatChain(cfb, startSector, maxLength) {
  const { fat, sectorSize, _bytes } = cfb;
  const chunks = [];
  let total = 0;
  const visited = new Set();

  let sector = startSector;
  while (sector !== ENDOFCHAIN && sector !== FREESECT) {
    if (visited.has(sector)) {
      throw new HwpError(ERR_CFB_CORRUPT,
        'FAT 체인에 순환 참조가 있습니다',
        'FAT chain contains a cycle');
    }
    visited.add(sector);

    const off = sectorOffset(sector, sectorSize);
    if (off + sectorSize > _bytes.length) {
      throw new HwpError(ERR_CFB_CORRUPT,
        '섹터 오프셋이 파일 범위를 벗어납니다',
        'Sector offset is out of file bounds');
    }

    // Collect only what the caller asked for, but keep walking the chain to
    // ENDOFCHAIN: a corrupted (cyclic) chain is a real defect in the file and
    // must be reported even when the requested byte count is reached early.
    if (maxLength === undefined || total < maxLength) {
      const remaining = maxLength !== undefined ? maxLength - total : sectorSize;
      const take = Math.min(sectorSize, remaining);
      chunks.push(_bytes.subarray(off, off + take));
      total += take;
    }

    sector = fat[sector];
  }

  // Concatenate all chunks into a single Uint8Array
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

/**
 * Read a chain of mini-sectors from the mini-FAT and return them concatenated.
 */
function readMiniFatChain(cfb, startSector, size) {
  const { miniFat, miniSectorSize, miniStreamData } = cfb;
  const chunks = [];
  let total = 0;
  const visited = new Set();

  let sector = startSector;
  while (sector !== ENDOFCHAIN && sector !== FREESECT) {
    if (visited.has(sector)) {
      throw new HwpError(ERR_CFB_CORRUPT,
        '미니 FAT 체인에 순환 참조가 있습니다',
        'Mini-FAT chain contains a cycle');
    }
    visited.add(sector);

    const off = sector * miniSectorSize;
    if (off + miniSectorSize > miniStreamData.length) {
      throw new HwpError(ERR_CFB_CORRUPT,
        '미니 섹터 오프셋이 미니 스트림 범위를 벗어납니다',
        'Mini-sector offset is out of mini-stream bounds');
    }

    const remaining = size - total;
    const take = Math.min(miniSectorSize, remaining);
    chunks.push(miniStreamData.subarray(off, off + take));
    total += take;

    if (total >= size) break;

    sector = miniFat[sector];
  }

  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

// ── TASK-04: Header parsing ───────────────────────────────────────────────────

/**
 * Parse the 512-byte CFB header.
 * @param {Uint8Array} bytes  Full file bytes
 * @returns {object}  Parsed header fields
 */
function parseHeader(bytes) {
  if (bytes.length < 512) {
    throw new HwpError(ERR_NOT_CFB,
      'CFB 파일 헤더가 너무 짧습니다 (512바이트 미만)',
      'File is too short to be a CFB (less than 512 bytes)');
  }

  // Validate magic bytes D0 CF 11 E0 A1 B1 1A E1
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== CFB_MAGIC[i]) {
      throw new HwpError(ERR_NOT_CFB,
        'CFB 매직 바이트가 일치하지 않습니다. OLE2 복합 문서가 아닙니다.',
        'CFB magic bytes do not match. File is not an OLE2 compound document.');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Minor version at offset 24, major at offset 26
  const minorVersion = view.getUint16(24, true);
  const majorVersion = view.getUint16(26, true);

  // Only CFB versions 3 (512-byte sectors) and 4 (4096-byte sectors) are defined
  if (majorVersion !== 3 && majorVersion !== 4) {
    throw new HwpError(ERR_CFB_VERSION,
      `지원하지 않는 CFB 버전입니다: ${majorVersion}`,
      `Unsupported CFB major version: ${majorVersion}`);
  }

  // Byte order must be 0xFFFE (little-endian)
  const byteOrder = view.getUint16(28, true);
  if (byteOrder !== 0xFFFE) {
    throw new HwpError(ERR_CFB_CORRUPT,
      'CFB 바이트 오더 마크가 잘못되었습니다',
      'CFB byte-order mark is invalid (expected 0xFFFE)');
  }

  const sectorSizePower    = view.getUint16(30, true);  // log2 of sector size
  const miniSectorSizePower = view.getUint16(32, true); // log2 of mini-sector size

  const sectorSize     = 1 << sectorSizePower;
  const miniSectorSize = 1 << miniSectorSizePower;

  // Version 3 must have 512-byte sectors; version 4 must have 4096-byte
  if (majorVersion === 3 && sectorSize !== 512) {
    throw new HwpError(ERR_CFB_CORRUPT,
      'CFB v3의 섹터 크기가 512바이트가 아닙니다',
      'CFB v3 sector size must be 512 bytes');
  }
  if (majorVersion === 4 && sectorSize !== 4096) {
    throw new HwpError(ERR_CFB_CORRUPT,
      'CFB v4의 섹터 크기가 4096바이트가 아닙니다',
      'CFB v4 sector size must be 4096 bytes');
  }

  const fatSectorCount     = view.getUint32(44, true);
  const firstDirSector     = view.getUint32(48, true);
  const miniStreamCutoff   = view.getUint32(56, true);
  const firstMiniFatSector = view.getUint32(60, true);
  const miniFatSectorCount = view.getUint32(64, true);
  const firstDifatSector   = view.getUint32(68, true);
  const difatSectorCount   = view.getUint32(72, true);

  // 109-entry DIFAT array starts at offset 76
  const difatArray = [];
  for (let i = 0; i < 109; i++) {
    difatArray.push(view.getInt32(76 + i * 4, true));
  }

  return {
    majorVersion,
    minorVersion,
    sectorSize,
    miniSectorSize,
    fatSectorCount,
    firstDirSector,
    miniStreamCutoff,
    firstMiniFatSector,
    miniFatSectorCount,
    firstDifatSector,
    difatSectorCount,
    difatArray,
  };
}

// ── TASK-05: FAT construction ─────────────────────────────────────────────────

/**
 * Build the full flat FAT (File Allocation Table) from the DIFAT chain.
 * @param {Uint8Array}  bytes   Full file bytes
 * @param {object}      header  Parsed header
 * @returns {Int32Array}
 */
function buildFat(bytes, header) {
  const {
    sectorSize,
    fatSectorCount,
    firstDifatSector,
    difatSectorCount,
    difatArray,
  } = header;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entriesPerSector = sectorSize / 4;

  // Collect all FAT sector IDs from the header DIFAT array + DIFAT chain sectors
  const fatSectorIds = [];

  // Header DIFAT array (up to 109 entries; skip FREESECT = -1)
  for (const id of difatArray) {
    if (id === FREESECT) break;
    fatSectorIds.push(id);
  }

  // Follow the DIFAT chain for files with more than 109 FAT sectors
  if (difatSectorCount > 0) {
    const visited = new Set();
    let difatSector = firstDifatSector;

    while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT) {
      if (visited.has(difatSector)) {
        throw new HwpError(ERR_CFB_CORRUPT,
          'DIFAT 체인에 순환 참조가 있습니다',
          'DIFAT chain contains a cycle');
      }
      visited.add(difatSector);

      const off = sectorOffset(difatSector, sectorSize);
      if (off + sectorSize > bytes.length) {
        throw new HwpError(ERR_CFB_CORRUPT,
          'DIFAT 섹터 오프셋이 파일 범위를 벗어납니다',
          'DIFAT sector offset is out of file bounds');
      }

      // Each DIFAT sector holds (entriesPerSector - 1) FAT sector IDs;
      // the last 4 bytes are the next DIFAT sector ID.
      for (let i = 0; i < entriesPerSector - 1; i++) {
        const id = view.getInt32(off + i * 4, true);
        if (id === FREESECT) break;
        fatSectorIds.push(id);
      }

      difatSector = view.getInt32(off + (entriesPerSector - 1) * 4, true);
    }
  }

  // Allocate the flat FAT array
  const totalSectors = Math.ceil((bytes.length - 512) / sectorSize);
  const fat = new Int32Array(totalSectors);
  fat.fill(FREESECT);

  for (let i = 0; i < fatSectorIds.length; i++) {
    const fatSectorId = fatSectorIds[i];
    if (fatSectorId < 0 || fatSectorId >= totalSectors) {
      throw new HwpError(ERR_CFB_CORRUPT,
        `FAT 섹터 ID가 범위를 벗어납니다: ${fatSectorId}`,
        `FAT sector ID out of range: ${fatSectorId}`);
    }
    const off = sectorOffset(fatSectorId, sectorSize);
    for (let j = 0; j < entriesPerSector; j++) {
      const idx = i * entriesPerSector + j;
      if (idx >= totalSectors) break;
      fat[idx] = view.getInt32(off + j * 4, true);
    }
  }

  return fat;
}

// ── TASK-05: Mini-FAT construction ───────────────────────────────────────────

/**
 * Build the mini-FAT from its sector chain.
 */
function buildMiniFat(cfb, header) {
  const { sectorSize } = header;
  const { fat, _bytes } = cfb;
  const { firstMiniFatSector, miniFatSectorCount } = header;

  if (firstMiniFatSector === ENDOFCHAIN || firstMiniFatSector === FREESECT ||
      miniFatSectorCount === 0) {
    return new Int32Array(0);
  }

  const view = new DataView(_bytes.buffer, _bytes.byteOffset, _bytes.byteLength);
  const entriesPerSector = sectorSize / 4;
  const totalEntries = miniFatSectorCount * entriesPerSector;
  const miniFat = new Int32Array(totalEntries);
  miniFat.fill(FREESECT);

  const visited = new Set();
  let sector = firstMiniFatSector;
  let entryOffset = 0;

  while (sector !== ENDOFCHAIN && sector !== FREESECT) {
    if (visited.has(sector)) {
      throw new HwpError(ERR_CFB_CORRUPT,
        '미니 FAT 섹터 체인에 순환 참조가 있습니다',
        'Mini-FAT sector chain contains a cycle');
    }
    visited.add(sector);

    const off = sectorOffset(sector, sectorSize);
    for (let i = 0; i < entriesPerSector && entryOffset < totalEntries; i++) {
      miniFat[entryOffset++] = view.getInt32(off + i * 4, true);
    }

    sector = fat[sector];
  }

  return miniFat;
}

// ── TASK-06: Directory parsing ────────────────────────────────────────────────

/**
 * Decode a single 128-byte directory entry.
 * @param {DataView} view
 * @param {number}   baseOffset  Byte offset of this entry in `view`
 * @param {number}   sid         0-based index of this entry
 */
function decodeDirEntry(view, baseOffset, sid) {
  const entry = new DirEntry();
  entry.sid = sid;

  // Name: UTF-16LE, bytes 0–63; name byte length at offset 64 (uint16)
  const nameByteLen = view.getUint16(baseOffset + 64, true);
  // nameByteLen includes the NUL terminator; cap at 64 for safety
  const actualLen = Math.min(nameByteLen, 64);
  if (actualLen >= 2) {
    // Decode the UTF-16LE name, excluding the trailing NUL
    const nameBytes = new Uint8Array(
      view.buffer, view.byteOffset + baseOffset, actualLen - 2
    );
    entry.name = new TextDecoder('utf-16le').decode(nameBytes);
  } else {
    entry.name = '';
  }

  entry.type        = view.getUint8(baseOffset + 66);
  // Colour at offset 67 (not used for parsing)
  // Tree links per [MS-CFB] 2.6.1: left 68, right 72, child 76.
  // (100/108 are creation/modified times, not SIDs.)
  entry.leftSid     = view.getInt32(baseOffset + 68, true);
  entry.rightSid    = view.getInt32(baseOffset + 72, true);
  entry.childSid    = view.getInt32(baseOffset + 76, true);
  entry.startSector = view.getInt32(baseOffset + 116, true);
  // Size is a uint32 for v3, uint64 for v4; we only need the low 32 bits
  entry.size        = view.getUint32(baseOffset + 120, true);

  return entry;
}

/**
 * Parse all directory entries by following the FAT chain from firstDirSector.
 */
function parseDirectories(cfb, header) {
  const { firstDirSector, sectorSize } = header;
  const dirBytes = readFatChain(cfb, firstDirSector, undefined);

  const entryCount = dirBytes.length / 128;
  const view = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const directories = [];

  for (let i = 0; i < entryCount; i++) {
    const entry = decodeDirEntry(view, i * 128, i);
    directories.push(entry);
  }

  if (directories.length === 0 || directories[0].type !== TYPE_ROOT) {
    throw new HwpError(ERR_CFB_CORRUPT,
      '디렉토리 항목 0이 루트 스토리지가 아닙니다',
      'Directory entry 0 is not the root storage (type must be 5)');
  }

  return directories;
}

// ── TASK-07: Stream read ──────────────────────────────────────────────────────

/**
 * Find a directory entry by name using the red-black tree embedded in the
 * directory.  Traversal starts from the child SID of `fromEntry`.
 *
 * Names in CFB are case-sensitive when searching by exact match (HWP stream
 * names are always ASCII, so this is safe).
 *
 * @param {DirEntry[]} directories
 * @param {DirEntry}   fromEntry    Storage entry whose child to search under
 * @param {string}     name
 * @returns {DirEntry | null}
 */
function findEntryByName(directories, fromEntry, name) {
  const startSid = fromEntry.childSid;
  if (startSid === NOSTREAM || startSid < 0) return null;

  const visited = new Set();
  // Use an explicit stack rather than recursion to avoid stack overflow on
  // deeply unbalanced trees.
  const stack = [startSid];

  while (stack.length > 0) {
    const sid = stack.pop();
    if (sid === NOSTREAM || sid < 0 || sid >= directories.length) continue;
    if (visited.has(sid)) continue;
    visited.add(sid);

    const entry = directories[sid];
    if (!entry || entry.type === TYPE_EMPTY) continue;

    if (entry.name === name) return entry;

    // Push both subtrees; order doesn't matter for exhaustive search
    if (entry.leftSid !== NOSTREAM && entry.leftSid >= 0) stack.push(entry.leftSid);
    if (entry.rightSid !== NOSTREAM && entry.rightSid >= 0) stack.push(entry.rightSid);
  }

  return null;
}

/**
 * Find a directory entry at an arbitrary storage path.
 * `path` is an array of name segments, e.g. ['BodyText', 'Section0'].
 * The search starts from the root entry.
 *
 * @param {CfbFile} cfb
 * @param {string[]} path
 * @returns {DirEntry | null}
 */
export function findEntry(cfb, path) {
  let current = cfb.directories[0]; // root
  for (const segment of path) {
    const child = findEntryByName(cfb.directories, current, segment);
    if (!child) return null;
    current = child;
  }
  return current;
}

/**
 * Read a named stream from the CFB.
 *
 * For a top-level stream (most HWP streams), `storagePath` is `[]`.
 * For 'BodyText/Section0', `storagePath` is `['BodyText']` and `name` is 'Section0'.
 *
 * @param {CfbFile} cfb
 * @param {string}  name
 * @param {string[]} [storagePath=[]]  Parent storage path segments
 * @returns {Uint8Array}
 */
export function readStream(cfb, name, storagePath = []) {
  // Find the parent storage
  let parentEntry = cfb.directories[0]; // root
  for (const segment of storagePath) {
    const child = findEntryByName(cfb.directories, parentEntry, segment);
    if (!child) {
      throw new HwpError(ERR_STREAM_NOT_FOUND,
        `스토리지를 찾을 수 없습니다: ${storagePath.join('/')}`,
        `Storage not found: ${storagePath.join('/')}`);
    }
    parentEntry = child;
  }

  const entry = findEntryByName(cfb.directories, parentEntry, name);
  if (!entry) {
    const fullPath = [...storagePath, name].join('/');
    throw new HwpError(ERR_STREAM_NOT_FOUND,
      `스트림을 찾을 수 없습니다: ${fullPath}`,
      `Stream not found: ${fullPath}`);
  }

  if (entry.size === 0) return new Uint8Array(0);

  // Streams smaller than miniStreamCutoff live in the mini-stream, but only
  // when the mini-stream container actually exists and has a mini-FAT.
  const hasMiniStream = cfb.miniStreamData !== null &&
                        cfb.miniStreamData.length > 0 &&
                        cfb.miniFat !== null &&
                        cfb.miniFat.length > 0;
  if (hasMiniStream && entry.size < cfb.miniStreamCutoff) {
    return readMiniFatChain(cfb, entry.startSector, entry.size);
  }

  return readFatChain(cfb, entry.startSector, entry.size);
}

// ── Top-level export: parseCfb ────────────────────────────────────────────────

/**
 * Parse an OLE2 Compound File Binary file.
 *
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {CfbFile}
 */
export function parseCfb(input) {
  const bytes = toUint8Array(input);

  // 1. Parse header
  const header = parseHeader(bytes);

  const cfb = new CfbFile();
  cfb.sectorSize        = header.sectorSize;
  cfb.miniSectorSize    = header.miniSectorSize;
  cfb.miniStreamCutoff  = header.miniStreamCutoff;
  cfb._bytes            = bytes;

  // 2. Build FAT
  cfb.fat = buildFat(bytes, header);

  // 3. Parse directory entries
  cfb.directories = parseDirectories(cfb, header);

  // 4. Load the mini-stream container (root entry's FAT chain)
  const root = cfb.directories[0];
  if (root.startSector !== ENDOFCHAIN && root.startSector !== FREESECT &&
      root.size > 0) {
    cfb.miniStreamData = readFatChain(cfb, root.startSector, root.size);
  } else {
    cfb.miniStreamData = new Uint8Array(0);
  }

  // 5. Build mini-FAT
  cfb.miniFat = buildMiniFat(cfb, header);

  return cfb;
}
