/**
 * tests/records.test.js — Unit tests for src/records.js
 *
 * Constructs Uint8Array payloads in-memory and asserts correct decoding.
 * Run with: node --test tests/records.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRecords, TAGS, TAG_NAMES } from '../src/records.js';
import { HwpError as HwpErrorFromCfb, ERR_RECORD_OVERRUN as ERR_RO } from '../src/cfb.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeUint32LE(buf, offset, value) {
  buf[offset]     =  value        & 0xFF;
  buf[offset + 1] = (value >>>  8) & 0xFF;
  buf[offset + 2] = (value >>> 16) & 0xFF;
  buf[offset + 3] = (value >>> 24) & 0xFF;
}

/**
 * Build a 4-byte record header word.
 *   bits  0– 9: tagId
 *   bits 10–19: level
 *   bits 20–31: size (0xFFF = extended)
 */
function makeHeader(tagId, level, size) {
  return (tagId & 0x3FF) | ((level & 0x3FF) << 10) | ((size & 0xFFF) << 20);
}

/**
 * Build a minimal record stream containing one record with the given
 * tagId / level / payload.
 */
function oneRecord(tagId, level, payloadBytes) {
  const size = payloadBytes.length;
  const useExtended = size >= 0xFFF;
  const headerSize = useExtended ? 8 : 4;
  const buf = new Uint8Array(headerSize + size);

  if (useExtended) {
    writeUint32LE(buf, 0, makeHeader(tagId, level, 0xFFF));
    writeUint32LE(buf, 4, size);
  } else {
    writeUint32LE(buf, 0, makeHeader(tagId, level, size));
  }
  buf.set(payloadBytes, headerSize);
  return buf;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('decodeRecords — standard header', () => {
  it('decodes a single record with tagId, level, and size', () => {
    const payload = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22, 0x33, 0x44]);
    const bytes = oneRecord(0x42, 0, payload);

    const records = [...decodeRecords(bytes)];
    assert.equal(records.length, 1);
    assert.equal(records[0].tagId, 0x42);
    assert.equal(records[0].level, 0);
    assert.equal(records[0].size, 10);
    assert.deepEqual(records[0].payload, payload);
  });

  it('preserves the level field', () => {
    const bytes = oneRecord(0x10, 3, new Uint8Array(4));
    const [rec] = [...decodeRecords(bytes)];
    assert.equal(rec.tagId, 0x10);
    assert.equal(rec.level, 3);
  });
});

describe('decodeRecords — extended size header', () => {
  it('decodes a record whose size field is 0xFFF followed by a uint32', () => {
    // Payload of 2000 bytes (> 0xFFF = 4095 would need extended, but
    // 0xFFF is the sentinel; any size ≥ 0xFFF triggers extended mode.
    // Here we use exactly 0xFFF bytes to verify the boundary.)
    const payloadSize = 0xFFF; // 4095 bytes
    const payload = new Uint8Array(payloadSize).fill(0x5A);

    // Build manually: header word with size=0xFFF, then uint32 actual size, then payload
    const buf = new Uint8Array(4 + 4 + payloadSize);
    writeUint32LE(buf, 0, makeHeader(0x20, 1, 0xFFF));
    writeUint32LE(buf, 4, payloadSize);
    buf.set(payload, 8);

    const records = [...decodeRecords(buf)];
    assert.equal(records.length, 1);
    assert.equal(records[0].tagId, 0x20);
    assert.equal(records[0].level, 1);
    assert.equal(records[0].size, payloadSize);
    assert.deepEqual(records[0].payload, payload);
  });

  it('decodes a large payload (2000 bytes) with extended header', () => {
    const payloadSize = 2000;
    const payload = new Uint8Array(payloadSize);
    for (let i = 0; i < payloadSize; i++) payload[i] = i & 0xFF;

    const buf = new Uint8Array(4 + 4 + payloadSize);
    writeUint32LE(buf, 0, makeHeader(0x42, 0, 0xFFF));
    writeUint32LE(buf, 4, payloadSize);
    buf.set(payload, 8);

    const records = [...decodeRecords(buf)];
    assert.equal(records.length, 1);
    assert.equal(records[0].size, payloadSize);
    assert.deepEqual(records[0].payload, payload);
  });
});

describe('decodeRecords — sequential records', () => {
  it('decodes two back-to-back records in order', () => {
    // Record 1: tagId=0x34, level=0, 4-byte payload
    // Record 2: tagId=0x42, level=1, 2-byte payload
    const p1 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const p2 = new Uint8Array([0xAB, 0xCD]);

    const buf = new Uint8Array(4 + p1.length + 4 + p2.length);
    writeUint32LE(buf, 0, makeHeader(0x42, 0, p1.length));
    buf.set(p1, 4);
    writeUint32LE(buf, 4 + p1.length, makeHeader(0x43, 1, p2.length));
    buf.set(p2, 4 + p1.length + 4);

    const records = [...decodeRecords(buf)];
    assert.equal(records.length, 2);

    assert.equal(records[0].tagId, 0x42);
    assert.equal(records[0].level, 0);
    assert.deepEqual(records[0].payload, p1);

    assert.equal(records[1].tagId, 0x43);
    assert.equal(records[1].level, 1);
    assert.deepEqual(records[1].payload, p2);
  });

  it('yields zero records for an empty buffer', () => {
    const records = [...decodeRecords(new Uint8Array(0))];
    assert.equal(records.length, 0);
  });
});

describe('decodeRecords — ERR_RECORD_OVERRUN', () => {
  it('throws ERR_RECORD_OVERRUN when declared size exceeds buffer length', () => {
    // Header says payload = 100 bytes, but only 4 bytes follow
    const buf = new Uint8Array(4 + 4); // header + 4 bytes (not 100)
    writeUint32LE(buf, 0, makeHeader(0x42, 0, 100));
    buf.set([0xDE, 0xAD, 0xBE, 0xEF], 4);

    assert.throws(
      () => [...decodeRecords(buf)],
      (err) => err instanceof HwpErrorFromCfb && err.code === ERR_RO
    );
  });

  it('throws ERR_RECORD_OVERRUN when extended size header is truncated', () => {
    // Header word with size=0xFFF but no following uint32
    const buf = new Uint8Array(4); // just the header word, no extended size
    writeUint32LE(buf, 0, makeHeader(0x42, 0, 0xFFF));

    assert.throws(
      () => [...decodeRecords(buf)],
      (err) => err instanceof HwpErrorFromCfb && err.code === ERR_RO
    );
  });
});

describe('TAGS and TAG_NAMES', () => {
  it('TAGS.PARA_HEADER === 0x42', () => {
    assert.equal(TAGS.PARA_HEADER, 0x42);
  });

  it('TAGS.PARA_TEXT === 0x43', () => {
    assert.equal(TAGS.PARA_TEXT, 0x43);
  });

  it('TAGS.DOCUMENT_PROPERTIES === 0x10', () => {
    assert.equal(TAGS.DOCUMENT_PROPERTIES, 0x10);
  });

  it('TAG_NAMES[0x42] === "PARA_HEADER"', () => {
    assert.equal(TAG_NAMES[0x42], 'PARA_HEADER');
  });

  it('TAG_NAMES[0x10] === "DOCUMENT_PROPERTIES"', () => {
    assert.equal(TAG_NAMES[0x10], 'DOCUMENT_PROPERTIES');
  });

  it('TAGS is frozen', () => {
    assert.ok(Object.isFrozen(TAGS));
  });

  it('TAG_NAMES is frozen', () => {
    assert.ok(Object.isFrozen(TAG_NAMES));
  });

  it('every TAGS value has a corresponding TAG_NAMES entry', () => {
    for (const [name, id] of Object.entries(TAGS)) {
      assert.ok(TAG_NAMES[id] !== undefined, `TAG_NAMES missing entry for ${name} (0x${id.toString(16)})`);
    }
  });
});
