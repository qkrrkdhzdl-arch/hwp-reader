/**
 * tests/errors.test.js — TASK-23
 *
 * Asserts that every ERR_* code is thrown for the correct crafted input.
 *
 * Covered codes:
 *   ERR_NOT_CFB          — truncated buffer, wrong magic
 *   ERR_NOT_HWP          — valid CFB, wrong FileHeader signature
 *   ERR_HWP_VERSION      — valid CFB, FileHeader major version = 4
 *   ERR_ENCRYPTED        — valid CFB, FileHeader encrypted flag
 *   ERR_DISTRIBUTION     — valid CFB, FileHeader distribution flag
 *   ERR_DECOMPRESS_FAILED — valid CFB, compressed flag set, corrupt Section0 bytes
 *
 * Note: ERR_CFB_VERSION, ERR_CFB_CORRUPT, ERR_STREAM_NOT_FOUND,
 * ERR_RECORD_OVERRUN, ERR_NO_BODY are tested in cfb.test.js / records.test.js.
 *
 * Run with: node --test tests/errors.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocument } from '../src/hwp.js';
import { HwpError, ERR_NOT_CFB, ERR_NOT_HWP, ERR_HWP_VERSION,
         ERR_ENCRYPTED, ERR_DISTRIBUTION, ERR_DECOMPRESS_FAILED } from '../src/cfb.js';

// ── Low-level helpers (duplicated from cfb.test.js for self-containment) ──────

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
  for (let i = 0; i < str.length; i++) writeUint16LE(out, i * 2, str.charCodeAt(i));
  return out;
}

const ENDOFCHAIN = 0xFFFFFFFE;
const FREESECT   = 0xFFFFFFFF;
const FATSECT    = 0xFFFFFFFD;
const NOSTREAM   = 0xFFFFFFFF;
const SECTOR     = 512;

/** Write a 128-byte directory entry at `offset` in `buf`. */
function writeDirEntry(buf, offset, {
  name        = '',
  type        = 0,
  leftSid     = NOSTREAM,
  rightSid    = NOSTREAM,
  childSid    = NOSTREAM,
  startSector = ENDOFCHAIN,
  size        = 0,
  color       = 1,
}) {
  buf.fill(0, offset, offset + 128);
  if (name.length > 0) {
    const nb = encodeUtf16LE(name);
    buf.set(nb, offset);
    writeUint16LE(buf, offset + 64, nb.length + 2); // +2 for NUL
  }
  buf[offset + 66] = type;
  buf[offset + 67] = color;
  writeInt32LE(buf, offset + 68, leftSid);
  writeInt32LE(buf, offset + 72, rightSid);
  writeInt32LE(buf, offset + 76, childSid);
  writeInt32LE(buf, offset + 116, startSector);
  writeUint32LE(buf, offset + 120, size);
}

function padTo(bytes, align) {
  const rem = bytes.length % align;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (align - rem));
  out.set(bytes);
  return out;
}

/**
 * Build a minimal CFB v3 file containing just one top-level stream.
 *
 * Directory layout (SIDs):
 *   0: Root Entry  (child → 1)
 *   1: <streamName> stream  (data in sector 2)
 *
 * Sector layout:
 *   0: FAT
 *   1: Directory  (one 512-byte sector = 4 entries)
 *   2: stream data
 */
function buildMinimalCfb(streamName, streamData) {
  const dataPadded = padTo(streamData, SECTOR);
  // 512 (header) + 3 × 512 (sectors 0,1,2) = 2048 bytes
  const buf = new Uint8Array(512 + 3 * SECTOR);

  // Header
  buf.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
  writeUint16LE(buf, 24, 0x003E);
  writeUint16LE(buf, 26, 0x0003);  // major version = 3
  writeUint16LE(buf, 28, 0xFFFE);
  writeUint16LE(buf, 30, 9);       // sector size = 512
  writeUint16LE(buf, 32, 6);       // mini sector size = 64
  writeUint32LE(buf, 44, 1);       // 1 FAT sector
  writeUint32LE(buf, 48, 1);       // first dir sector = 1
  writeUint32LE(buf, 56, 4096);    // mini stream cutoff
  writeUint32LE(buf, 60, FREESECT);
  writeUint32LE(buf, 64, 0);
  writeUint32LE(buf, 68, FREESECT);
  writeUint32LE(buf, 72, 0);
  writeUint32LE(buf, 76, 0);       // DIFAT[0] = sector 0 (FAT)
  for (let i = 1; i < 109; i++) writeUint32LE(buf, 76 + i * 4, FREESECT);

  // Sector 0: FAT
  const fatOff = 512;
  writeInt32LE(buf, fatOff +  0, FATSECT);     // sector 0 = FAT
  writeInt32LE(buf, fatOff +  4, ENDOFCHAIN);  // sector 1 = dir chain end
  writeInt32LE(buf, fatOff +  8, ENDOFCHAIN);  // sector 2 = data chain end
  for (let i = 3; i < 128; i++) writeInt32LE(buf, fatOff + i * 4, FREESECT);

  // Sector 1: Directory
  const dirOff = 512 + SECTOR;
  writeDirEntry(buf, dirOff,       { name: 'Root Entry', type: 5, childSid: 1 });
  writeDirEntry(buf, dirOff + 128, { name: streamName,  type: 2, startSector: 2, size: streamData.length });

  // Sector 2: stream data
  buf.set(dataPadded.subarray(0, Math.min(dataPadded.length, SECTOR)), 512 + 2 * SECTOR);

  return buf;
}

/**
 * Build a 256-byte FileHeader stream with controllable version and flags.
 */
function buildFileHeader({
  signature = 'HWP Document File',
  major = 5, minor = 0, build = 0, revision = 0,
  flags = 0,
} = {}) {
  const buf = new Uint8Array(256);
  for (let i = 0; i < 32; i++) {
    buf[i] = i < signature.length ? signature.charCodeAt(i) & 0xFF : 0x00;
  }
  buf[32] = revision;
  buf[33] = build;
  buf[34] = minor;
  buf[35] = major;
  writeUint32LE(buf, 36, flags);
  return buf;
}

/**
 * Build a CFB that has a FileHeader stream and a minimal BodyText/Section0.
 *
 * Directory layout (SIDs):
 *   0: Root Entry         (child → 1)
 *   1: FileHeader  stream (left → 2)
 *   2: BodyText    storage (child → 3)
 *   3: Section0    stream
 *
 * Sector layout:
 *   0: FAT
 *   1: Directory (two 512-byte sectors → 8 entry slots; we use 4)
 *   2: (dir overflow, still dir sector 2)
 *   3: FileHeader data
 *   4: Section0 data
 */
function buildHwpCfb(fileHeaderBytes, section0Bytes) {
  const fhPadded = padTo(fileHeaderBytes, SECTOR);
  const s0Padded = padTo(section0Bytes,  SECTOR);

  // We need 4 dir entries × 128 bytes = 512 bytes → 1 dir sector is enough
  // but we have 4 entries, which fits exactly in one 512-byte sector.
  const buf = new Uint8Array(512 + 5 * SECTOR);  // header + sectors 0–4

  // Header
  buf.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
  writeUint16LE(buf, 24, 0x003E);
  writeUint16LE(buf, 26, 0x0003);
  writeUint16LE(buf, 28, 0xFFFE);
  writeUint16LE(buf, 30, 9);
  writeUint16LE(buf, 32, 6);
  writeUint32LE(buf, 44, 1);       // 1 FAT sector
  writeUint32LE(buf, 48, 1);       // first dir sector = 1
  writeUint32LE(buf, 56, 4096);
  writeUint32LE(buf, 60, FREESECT);
  writeUint32LE(buf, 64, 0);
  writeUint32LE(buf, 68, FREESECT);
  writeUint32LE(buf, 72, 0);
  writeUint32LE(buf, 76, 0);       // DIFAT[0] = 0
  for (let i = 1; i < 109; i++) writeUint32LE(buf, 76 + i * 4, FREESECT);

  // Sector 0: FAT
  //   fat[0] = FATSECT   (sector 0 = FAT)
  //   fat[1] = ENDOFCHAIN (sector 1 = dir, single sector)
  //   fat[2] = ENDOFCHAIN (sector 2 unused — dir needs only 1 sector for 4 entries)
  //   fat[3] = ENDOFCHAIN (FileHeader data)
  //   fat[4] = ENDOFCHAIN (Section0 data)
  const fatOff = 512;
  writeInt32LE(buf, fatOff +  0, FATSECT);
  writeInt32LE(buf, fatOff +  4, ENDOFCHAIN);  // dir sector 1
  writeInt32LE(buf, fatOff +  8, FREESECT);    // unused
  writeInt32LE(buf, fatOff + 12, ENDOFCHAIN);  // FileHeader sector 3
  writeInt32LE(buf, fatOff + 16, ENDOFCHAIN);  // Section0 sector 4
  for (let i = 5; i < 128; i++) writeInt32LE(buf, fatOff + i * 4, FREESECT);

  // Sector 1: Directory (4 × 128 = 512 bytes = exactly one sector)
  const dirOff = 512 + SECTOR;
  writeDirEntry(buf, dirOff,       { name: 'Root Entry', type: 5, childSid: 1 });
  writeDirEntry(buf, dirOff + 128, { name: 'FileHeader', type: 2, leftSid: 2,
                                     startSector: 3, size: fileHeaderBytes.length });
  writeDirEntry(buf, dirOff + 256, { name: 'BodyText',   type: 1, childSid: 3 });
  writeDirEntry(buf, dirOff + 384, { name: 'Section0',   type: 2,
                                     startSector: 4, size: section0Bytes.length });

  // Sector 3: FileHeader data
  buf.set(fhPadded.subarray(0, Math.min(fhPadded.length, SECTOR)), 512 + 3 * SECTOR);

  // Sector 4: Section0 data
  buf.set(s0Padded.subarray(0, Math.min(s0Padded.length, SECTOR)), 512 + 4 * SECTOR);

  return buf;
}

// A minimal valid section stream: one PARA_HEADER + one PARA_TEXT("X")
function buildMinimalSection() {
  // PARA_HEADER: tagId=0x42, level=0, size=0 → header word = 0x42 | (0 << 10) | (0 << 20) = 0x00000042
  const rec = new Uint8Array(4 + 2);
  writeUint32LE(rec, 0, 0x42);           // PARA_HEADER, level=0, size=0
  writeUint32LE(rec, 4, 0x43 | (1 << 10) | (2 << 20)); // PARA_TEXT level=1, size=2
  // But we can't fit PARA_TEXT in the same 6 bytes... let me do it properly:
  // Actually let me just build two records separately and concat.
  const headerRec = new Uint8Array(4);
  writeUint32LE(headerRec, 0, (0x42 & 0x3FF) | ((0 & 0x3FF) << 10) | ((0 & 0xFFF) << 20));

  const textPayload = new Uint8Array([0x58, 0x00]); // "X" in UTF-16LE
  const textRec = new Uint8Array(4 + textPayload.length);
  writeUint32LE(textRec, 0, (0x43 & 0x3FF) | ((1 & 0x3FF) << 10) | ((textPayload.length & 0xFFF) << 20));
  textRec.set(textPayload, 4);

  const out = new Uint8Array(headerRec.length + textRec.length);
  out.set(headerRec, 0);
  out.set(textRec, headerRec.length);
  return out;
}

// A corrupt DEFLATE stream: not valid DEFLATE data
const CORRUPT_DEFLATE = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0xFF, 0xFF]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ERR_NOT_CFB', () => {
  it('7-byte buffer is too short to be a CFB', async () => {
    const buf = new Uint8Array(7);
    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_NOT_CFB
    );
  });

  it('512-byte buffer with wrong magic bytes', async () => {
    const buf = new Uint8Array(512);
    buf[0] = 0x00; // wrong magic
    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_NOT_CFB
    );
  });
});

describe('ERR_NOT_HWP', () => {
  it('valid CFB with a FileHeader stream that has the wrong HWP signature', async () => {
    // Build a FileHeader with wrong signature bytes
    const badFileHeader = new Uint8Array(256);
    // Write "NOT AN HWP FILE!!" instead of "HWP Document File"
    const badSig = 'NOT AN HWP FILE!!';
    for (let i = 0; i < badSig.length; i++) badFileHeader[i] = badSig.charCodeAt(i);
    badFileHeader[35] = 5; // correct major version — but sig check runs first

    const section0 = buildMinimalSection();
    const buf = buildHwpCfb(badFileHeader, section0);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_NOT_HWP
    );
  });
});

describe('ERR_HWP_VERSION', () => {
  it('valid CFB with FileHeader reporting major version 4', async () => {
    const fileHeader = buildFileHeader({ major: 4 });
    const section0   = buildMinimalSection();
    const buf        = buildHwpCfb(fileHeader, section0);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_HWP_VERSION
    );
  });

  it('valid CFB with FileHeader reporting major version 6', async () => {
    const fileHeader = buildFileHeader({ major: 6 });
    const section0   = buildMinimalSection();
    const buf        = buildHwpCfb(fileHeader, section0);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_HWP_VERSION
    );
  });
});

describe('ERR_ENCRYPTED', () => {
  it('valid CFB with encrypted flag (bit 1) set in FileHeader', async () => {
    const fileHeader = buildFileHeader({ flags: 0x02 }); // bit 1 = encrypted
    const section0   = buildMinimalSection();
    const buf        = buildHwpCfb(fileHeader, section0);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_ENCRYPTED
    );
  });

  it('valid CFB with DRM flag (bit 4) set in FileHeader', async () => {
    const fileHeader = buildFileHeader({ flags: 0x10 }); // bit 4 = DRM
    const section0   = buildMinimalSection();
    const buf        = buildHwpCfb(fileHeader, section0);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_ENCRYPTED
    );
  });
});

describe('ERR_DISTRIBUTION', () => {
  it('valid CFB with distribution flag (bit 2) set in FileHeader', async () => {
    const fileHeader = buildFileHeader({ flags: 0x04 }); // bit 2 = distribution
    const section0   = buildMinimalSection();
    const buf        = buildHwpCfb(fileHeader, section0);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_DISTRIBUTION
    );
  });
});

describe('ERR_DECOMPRESS_FAILED', () => {
  it('valid HWP with compressed flag set but corrupt Section0 stream', async () => {
    // compressed flag = bit 0 set; encrypted/distribution clear
    const fileHeader = buildFileHeader({ flags: 0x01 });
    // The section0 bytes look like corrupt DEFLATE (not valid)
    const buf        = buildHwpCfb(fileHeader, CORRUPT_DEFLATE);

    await assert.rejects(
      () => buildDocument(buf),
      (err) => err instanceof HwpError && err.code === ERR_DECOMPRESS_FAILED
    );
  });
});
