/**
 * tests/cfb.test.js — Unit tests for src/cfb.js
 *
 * Builds all CFB fixtures in-memory (no file I/O) so the suite runs under
 * `node --test` without a browser.
 *
 * Synthetic CFB layout (version 3, 512-byte sectors):
 *
 *   File header  (512 bytes)
 *   Sector 0     FAT sector  — FAT entries for sectors 0-3
 *   Sector 1     Directory sector  — root entry (sid 0) + Test stream (sid 1)
 *   Sector 2     Data sector  — 10 bytes of stream content
 *
 * FAT:
 *   fat[0] = FATSECT   (-3)  sector 0 is a FAT sector
 *   fat[1] = ENDOFCHAIN (-2)  directory chain ends here
 *   fat[2] = ENDOFCHAIN (-2)  Test stream ends here
 *   fat[3] = FREESECT  (-1)  unused
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCfb, readStream, HwpError,
         ERR_NOT_CFB, ERR_CFB_CORRUPT, ERR_STREAM_NOT_FOUND } from '../src/cfb.js';

// ── CFB constants mirrored here for fixture construction ──────────────────────
const ENDOFCHAIN = 0xFFFFFFFE;
const FREESECT   = 0xFFFFFFFF;
const FATSECT    = 0xFFFFFFFD;

const SECTOR_SIZE = 512;

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeUint16LE(buf, offset, value) {
  buf[offset]     = value & 0xFF;
  buf[offset + 1] = (value >>> 8) & 0xFF;
}

function writeUint32LE(buf, offset, value) {
  buf[offset]     = value & 0xFF;
  buf[offset + 1] = (value >>> 8) & 0xFF;
  buf[offset + 2] = (value >>> 16) & 0xFF;
  buf[offset + 3] = (value >>> 24) & 0xFF;
}

function writeInt32LE(buf, offset, value) {
  // Same encoding; named separately for readability at call sites
  writeUint32LE(buf, offset, value >>> 0);
}

/** Encode a string as UTF-16LE bytes (no BOM, no NUL). */
function encodeUtf16LE(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    writeUint16LE(out, i * 2, str.charCodeAt(i));
  }
  return out;
}

/** Write a 128-byte directory entry at `offset` in `buf`. */
function writeDirEntry(buf, offset, {
  name = '',
  type = 0,
  leftSid  = 0xFFFFFFFF,
  rightSid = 0xFFFFFFFF,
  childSid = 0xFFFFFFFF,
  startSector = 0xFFFFFFFE,
  size = 0,
  color = 1,   // 1 = black (default for valid trees)
}) {
  const nameBytes = encodeUtf16LE(name);
  const nameByteLen = name.length > 0 ? nameBytes.length + 2 : 0; // +2 for NUL
  buf.set(nameBytes, offset);
  writeUint16LE(buf, offset + 64, nameByteLen);
  buf[offset + 66] = type;
  buf[offset + 67] = color;
  // [MS-CFB] 2.6.1: left 68, right 72, child 76 (100+ are timestamps)
  writeInt32LE(buf, offset + 68, leftSid);
  writeInt32LE(buf, offset + 72, rightSid);
  writeInt32LE(buf, offset + 76, childSid);
  writeInt32LE(buf, offset + 116, startSector);
  writeUint32LE(buf, offset + 120, size);
}

/**
 * Build the standard synthetic CFB used by most tests.
 *
 * Layout:
 *   Header (512 bytes)
 *   Sector 0: FAT sector
 *   Sector 1: Directory sector (root + Test stream entry)
 *   Sector 2: Data sector (10 bytes of content)
 */
function buildSyntheticCfb({
  magic         = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1],
  streamContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  streamName    = 'Test',
  extraFatPatch = null,  // function(fatBuf, view) to corrupt the FAT
} = {}) {
  // File = 512 (header) + 3 × 512 (sectors 0, 1, 2) = 2048 bytes
  const buf = new Uint8Array(512 + 3 * SECTOR_SIZE);

  // ── Header ─────────────────────────────────────────────────────────────────
  buf.set(magic, 0);                     // magic
  writeUint16LE(buf, 24, 0x003E);        // minor version
  writeUint16LE(buf, 26, 0x0003);        // major version = 3
  writeUint16LE(buf, 28, 0xFFFE);        // byte order (LE)
  writeUint16LE(buf, 30, 9);             // sector size = 2^9 = 512
  writeUint16LE(buf, 32, 6);             // mini sector size = 2^6 = 64

  writeUint32LE(buf, 44, 1);             // FAT sector count = 1
  writeUint32LE(buf, 48, 1);             // first directory sector = 1
  writeUint32LE(buf, 56, 4096);          // mini stream cutoff
  writeUint32LE(buf, 60, FREESECT);      // no mini-FAT sectors
  writeUint32LE(buf, 64, 0);             // mini-FAT sector count = 0
  writeUint32LE(buf, 68, FREESECT);      // no DIFAT chain
  writeUint32LE(buf, 72, 0);             // DIFAT chain sector count = 0

  // DIFAT array: first FAT sector is sector 0
  writeUint32LE(buf, 76, 0);             // difat[0] = sector 0 (FAT sector)
  for (let i = 1; i < 109; i++) {
    writeUint32LE(buf, 76 + i * 4, FREESECT);
  }

  // ── Sector 0: FAT ──────────────────────────────────────────────────────────
  const fatOff = 512;                    // sector 0 starts at byte 512
  writeInt32LE(buf, fatOff +  0, FATSECT);    // fat[0] = FATSECT   (this FAT sector)
  writeInt32LE(buf, fatOff +  4, ENDOFCHAIN); // fat[1] = ENDOFCHAIN (directory)
  writeInt32LE(buf, fatOff +  8, ENDOFCHAIN); // fat[2] = ENDOFCHAIN (data)
  for (let i = 3; i < 128; i++) {
    writeInt32LE(buf, fatOff + i * 4, FREESECT);
  }

  if (extraFatPatch) {
    const view = new DataView(buf.buffer, fatOff, SECTOR_SIZE);
    extraFatPatch(buf, view, fatOff);
  }

  // ── Sector 1: Directory ────────────────────────────────────────────────────
  const dirOff = 512 + SECTOR_SIZE;     // sector 1 starts at byte 1024

  // Entry 0: root storage (type 5)
  writeDirEntry(buf, dirOff, {
    name: 'Root Entry',
    type: 5,
    childSid: 1,          // child is the Test stream (sid 1)
    startSector: ENDOFCHAIN,
    size: 0,
  });

  // Entry 1: stream named 'Test' (type 2), data in sector 2
  writeDirEntry(buf, dirOff + 128, {
    name: streamName,
    type: 2,
    startSector: 2,
    size: streamContent.length,
  });

  // ── Sector 2: Data ─────────────────────────────────────────────────────────
  const dataOff = 512 + 2 * SECTOR_SIZE;
  buf.set(streamContent, dataOff);

  return buf.buffer;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CFB parser — basic round-trip', () => {
  it('parses the synthetic CFB and finds the directory entries', () => {
    const buf = buildSyntheticCfb();
    const cfb = parseCfb(buf);
    // The directory sector is 512 bytes = 4 × 128-byte slots; entries 2 and 3
    // are type=0 (empty) placeholders.  Only entries 0 and 1 carry data.
    assert.equal(cfb.directories[0].name, 'Root Entry');
    assert.equal(cfb.directories[1].name, 'Test');
    // At least 2 entries present
    assert.ok(cfb.directories.length >= 2);
  });

  it('reads the Test stream and returns its exact bytes', () => {
    const content = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const buf = buildSyntheticCfb({ streamContent: content });
    const cfb = parseCfb(buf);
    const data = readStream(cfb, 'Test');
    assert.equal(data.length, content.length);
    for (let i = 0; i < content.length; i++) {
      assert.equal(data[i], content[i], `byte ${i} mismatch`);
    }
  });

  it('round-trips a 10-byte stream with values 1–10', () => {
    const buf = buildSyntheticCfb();
    const cfb = parseCfb(buf);
    const data = readStream(cfb, 'Test');
    assert.deepEqual(Array.from(data), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('CFB parser — error cases', () => {
  it('throws ERR_NOT_CFB on a buffer shorter than 512 bytes', () => {
    const buf = new Uint8Array(16).buffer;
    assert.throws(
      () => parseCfb(buf),
      (err) => err instanceof HwpError && err.code === ERR_NOT_CFB
    );
  });

  it('throws ERR_NOT_CFB when the magic bytes are wrong', () => {
    const buf = buildSyntheticCfb({
      magic: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
    });
    assert.throws(
      () => parseCfb(buf),
      (err) => err instanceof HwpError && err.code === ERR_NOT_CFB
    );
  });

  it('throws ERR_NOT_CFB on a 512-byte all-zero buffer', () => {
    const buf = new ArrayBuffer(512);
    assert.throws(
      () => parseCfb(buf),
      (err) => err instanceof HwpError && err.code === ERR_NOT_CFB
    );
  });

  it('throws ERR_STREAM_NOT_FOUND when asking for a non-existent stream', () => {
    const buf = buildSyntheticCfb();
    const cfb = parseCfb(buf);
    assert.throws(
      () => readStream(cfb, 'NoSuchStream'),
      (err) => err instanceof HwpError && err.code === ERR_STREAM_NOT_FOUND
    );
  });

  it('throws ERR_CFB_CORRUPT when the FAT chain contains a cycle', () => {
    // Patch fat[2] → 2 (self-loop) instead of ENDOFCHAIN
    const buf = buildSyntheticCfb({
      extraFatPatch: (_buf, _view, fatOff) => {
        // fat[2] = 2 creates a cycle: sector 2 → sector 2
        writeInt32LE(new Uint8Array(_buf.buffer ?? _buf), fatOff + 2 * 4, 2);
      },
    });
    const cfb = parseCfb(buf);
    assert.throws(
      () => readStream(cfb, 'Test'),
      (err) => err instanceof HwpError && err.code === ERR_CFB_CORRUPT
    );
  });
});

describe('CFB parser — CFB version 4 (4096-byte sectors)', () => {
  it('throws ERR_CFB_VERSION for an unrecognised major version', () => {
    // Build a minimal header with major version = 5 (not 3 or 4)
    const buf = new Uint8Array(512);
    buf.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
    writeUint16LE(buf, 24, 0x003E);
    writeUint16LE(buf, 26, 0x0005); // bad major version
    writeUint16LE(buf, 28, 0xFFFE);
    assert.throws(
      () => parseCfb(buf.buffer),
      (err) => err instanceof HwpError && err.code === 'ERR_CFB_VERSION'
    );
  });
});

describe('CFB parser — stream with sub-storage path', () => {
  it('reads a stream inside a named sub-storage', () => {
    // Extend the synthetic CFB to have:
    //   Root → BodyText (storage, sid 2) → Section0 (stream, sid 3, sector 3)
    const content = new Uint8Array([0xAA, 0xBB, 0xCC]);

    // File = 512 (header) + 5 × 512 sectors = 3072 bytes
    const buf = new Uint8Array(512 + 5 * SECTOR_SIZE);

    // Header
    buf.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
    writeUint16LE(buf, 24, 0x003E);
    writeUint16LE(buf, 26, 0x0003);
    writeUint16LE(buf, 28, 0xFFFE);
    writeUint16LE(buf, 30, 9);    // sector size = 512
    writeUint16LE(buf, 32, 6);    // mini sector size = 64
    writeUint32LE(buf, 44, 1);    // 1 FAT sector
    writeUint32LE(buf, 48, 1);    // first dir sector = 1
    writeUint32LE(buf, 56, 4096); // mini stream cutoff
    writeUint32LE(buf, 60, FREESECT);
    writeUint32LE(buf, 64, 0);
    writeUint32LE(buf, 68, FREESECT);
    writeUint32LE(buf, 72, 0);
    writeUint32LE(buf, 76, 0);    // DIFAT[0] = sector 0 (FAT)
    for (let i = 1; i < 109; i++) writeUint32LE(buf, 76 + i * 4, FREESECT);

    // Sector 0: FAT
    const fatOff = 512;
    writeInt32LE(buf, fatOff +  0, FATSECT);     // sector 0 = FAT sector
    writeInt32LE(buf, fatOff +  4, ENDOFCHAIN);  // sector 1 = dir (single sector)
    writeInt32LE(buf, fatOff +  8, ENDOFCHAIN);  // sector 2 = dir overflow (unused, dir fits in 1)
    writeInt32LE(buf, fatOff + 12, ENDOFCHAIN);  // sector 3 = Section0 data
    for (let i = 4; i < 128; i++) writeInt32LE(buf, fatOff + i * 4, FREESECT);

    // Sector 1: Directory (4 entries × 128 bytes = 512 bytes = exactly one sector)
    const dirOff = 512 + SECTOR_SIZE;

    // Entry 0: root (type 5), child = sid 1 (BodyText storage)
    writeDirEntry(buf, dirOff,       { name: 'Root Entry', type: 5, childSid: 1, startSector: ENDOFCHAIN, size: 0 });
    // Entry 1: BodyText (storage, type 1), child = sid 2 (Section0)
    writeDirEntry(buf, dirOff + 128, { name: 'BodyText',   type: 1, childSid: 2, startSector: ENDOFCHAIN, size: 0 });
    // Entry 2: Section0 (stream, type 2), data in sector 3
    writeDirEntry(buf, dirOff + 256, { name: 'Section0',   type: 2, startSector: 3, size: content.length });
    // Entry 3: empty
    writeDirEntry(buf, dirOff + 384, { name: '', type: 0 });

    // Sector 3: Section0 data
    buf.set(content, 512 + 3 * SECTOR_SIZE);

    const cfb = parseCfb(buf.buffer);
    const data = readStream(cfb, 'Section0', ['BodyText']);
    assert.deepEqual(Array.from(data), Array.from(content));
  });
});
