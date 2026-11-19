/**
 * tests/inflate.test.js — Unit tests for src/inflate.js
 *
 * Uses Node's built-in zlib.deflateRawSync to produce known-good compressed
 * payloads, then verifies that our pure-JS inflate produces byte-for-byte
 * identical output.
 *
 * Run with: node --test tests/inflate.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { inflate } from '../src/inflate.js';

describe('inflate — stored blocks', () => {
  it('round-trips a 1-byte buffer', () => {
    const original = new Uint8Array([0x42]);
    const compressed = deflateRawSync(original);
    const result = inflate(compressed);
    assert.deepEqual(result, original);
  });

  it('round-trips a 200-byte buffer of sequential values', () => {
    const original = new Uint8Array(200);
    for (let i = 0; i < 200; i++) original[i] = i % 256;
    const compressed = deflateRawSync(original);
    const result = inflate(compressed);
    assert.deepEqual(result, original);
  });
});

describe('inflate — compressed blocks', () => {
  it('round-trips a highly compressible 200-byte buffer (all zeros)', () => {
    const original = new Uint8Array(200); // all zeros — maximally compressible
    // Force deflate to use compression (not stored) by using level > 0
    const compressed = deflateRawSync(original, { level: 6 });
    const result = inflate(compressed);
    assert.deepEqual(result, original);
  });

  it('round-trips a 200-byte buffer of repeating pattern', () => {
    const original = new Uint8Array(200);
    for (let i = 0; i < 200; i++) original[i] = (i % 7) * 37;
    const compressed = deflateRawSync(original, { level: 9 });
    const result = inflate(compressed);
    assert.deepEqual(result, original);
  });

  it('round-trips a 1024-byte buffer of random-ish bytes', () => {
    const original = new Uint8Array(1024);
    // Deterministic pseudo-random fill
    let v = 0xDEADBEEF;
    for (let i = 0; i < 1024; i++) {
      v = ((v ^ (v << 13)) >>> 0);
      v = ((v ^ (v >>> 17)) >>> 0);
      v = ((v ^ (v << 5))  >>> 0);
      original[i] = v & 0xFF;
    }
    const compressed = deflateRawSync(original, { level: 6 });
    const result = inflate(compressed);
    assert.deepEqual(result, original);
  });

  it('round-trips a 10 000-byte buffer with back-references', () => {
    // Create data that will produce many back-references
    const original = new Uint8Array(10000);
    for (let i = 0; i < 10000; i++) original[i] = (i * 7 + i * i) & 0xFF;
    const compressed = deflateRawSync(original, { level: 6 });
    const result = inflate(compressed);
    assert.deepEqual(result, original);
  });
});

describe('inflate — edge cases', () => {
  it('round-trips an empty buffer', () => {
    const original = new Uint8Array(0);
    const compressed = deflateRawSync(original);
    const result = inflate(compressed);
    assert.equal(result.length, 0);
  });

  it('throws on corrupt input', () => {
    const garbage = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
    assert.throws(() => inflate(garbage));
  });
});
