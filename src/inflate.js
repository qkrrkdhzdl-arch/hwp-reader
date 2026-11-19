/**
 * src/inflate.js — Pure-JS raw DEFLATE decompressor (RFC 1951).
 *
 * Handles all three block types:
 *   BTYPE 00  stored (uncompressed)
 *   BTYPE 01  fixed Huffman codes
 *   BTYPE 10  dynamic Huffman codes
 *
 * No imports, no DOM dependencies, no external packages.
 * Runs in Node and in the browser without any build step.
 *
 * Usage:
 *   import { inflate } from './inflate.js';
 *   const out = inflate(compressedBytes); // Uint8Array → Uint8Array
 */

// ── Huffman table builder ─────────────────────────────────────────────────────

/**
 * Build a canonical Huffman decode table from an array of code lengths.
 *
 * Returns an object { table, maxBits } where `table` is a flat lookup array:
 * table[code] = { symbol, bits } for every valid code.  Codes that do not
 * exist in the alphabet have no entry.
 *
 * @param {number[]} lengths  Code lengths for symbols 0…n-1 (0 = unused)
 * @returns {{ lookup: Int32Array, maxBits: number }}
 */
function buildHuffmanTable(lengths) {
  const maxBits = Math.max(...lengths);
  if (maxBits === 0) return { lookup: new Int32Array(0), maxBits: 0 };

  // Count number of codes for each bit length
  const blCount = new Int32Array(maxBits + 1);
  for (const len of lengths) if (len > 0) blCount[len]++;

  // Find the smallest code for each bit length
  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  blCount[0] = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  // Build lookup table indexed by the full bit-reversed code padded to maxBits
  const size = 1 << maxBits;
  // Encode: high 16 bits = symbol, low 16 bits = actual code length
  const lookup = new Int32Array(size).fill(-1);

  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    const c = nextCode[len]++;
    // Reverse the code bits for LSB-first bit reading
    let rev = 0;
    for (let i = 0; i < len; i++) rev |= ((c >>> i) & 1) << (len - 1 - i);
    // Fill all table entries that share this prefix
    const step = 1 << len;
    for (let i = rev; i < size; i += step) {
      lookup[i] = (sym << 16) | len;
    }
  }

  return { lookup, maxBits };
}

// ── Bit-reader ────────────────────────────────────────────────────────────────

/**
 * LSB-first bit reader over a Uint8Array.
 */
class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;       // byte position
    this.bits = 0;      // bit buffer (up to 32 bits)
    this.nBits = 0;     // number of valid bits in buffer
  }

  /** Fill the bit buffer from the byte stream. */
  _fill() {
    while (this.nBits <= 24 && this.pos < this.bytes.length) {
      this.bits |= this.bytes[this.pos++] << this.nBits;
      this.nBits += 8;
    }
  }

  /**
   * Read `n` bits (LSB first) without consuming them.
   */
  peek(n) {
    if (this.nBits < n) this._fill();
    return this.bits & ((1 << n) - 1);
  }

  /**
   * Consume `n` bits (already peeked or directly).
   */
  consume(n) {
    this.bits >>>= n;
    this.nBits -= n;
  }

  /**
   * Read and consume `n` bits.
   */
  read(n) {
    if (n === 0) return 0;
    if (this.nBits < n) this._fill();
    const val = this.bits & ((1 << n) - 1);
    this.bits >>>= n;
    this.nBits -= n;
    return val;
  }

  /**
   * Align to the next byte boundary (discard remaining bits in current byte).
   */
  /** Number of input bytes fully consumed (drops partially buffered bits). */
  consumedBytes() {
    return this.pos - (this.nBits >> 3);
  }

  alignByte() {
    const leftover = this.nBits & 7;
    if (leftover > 0) {
      this.bits >>>= leftover;
      this.nBits -= leftover;
    }
  }

  /**
   * Read `n` bytes as a little-endian integer (byte-aligned).
   * Flushes the bit buffer first.
   */
  readBytes(n) {
    // Push buffered full bytes back to `pos`
    this.pos -= (this.nBits >> 3);
    this.bits = 0;
    this.nBits = 0;
    let val = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.bytes.length) throw new Error('Unexpected end of DEFLATE stream');
      val |= this.bytes[this.pos++] << (i * 8);
    }
    return val;
  }

  /** Read a raw slice of `n` bytes at the current byte position. */
  readByteSlice(n) {
    this.pos -= (this.nBits >> 3);
    this.bits = 0;
    this.nBits = 0;
    if (this.pos + n > this.bytes.length) throw new Error('Unexpected end of DEFLATE stream');
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /**
   * Decode one symbol from a Huffman table.
   * @param {{ lookup: Int32Array, maxBits: number }} table
   */
  decodeSymbol(table) {
    const { lookup, maxBits } = table;
    if (this.nBits < maxBits) this._fill();
    const bits = this.bits & ((1 << maxBits) - 1);
    const entry = lookup[bits];
    if (entry < 0) throw new Error('Invalid Huffman code in DEFLATE stream');
    const sym = entry >>> 16;
    const len = entry & 0xFFFF;
    this.bits >>>= len;
    this.nBits -= len;
    return sym;
  }
}

// ── Fixed Huffman tables (RFC 1951 §3.2.6) ───────────────────────────────────

function buildFixedLitLenTable() {
  const lengths = new Array(288);
  for (let i =   0; i <= 143; i++) lengths[i] = 8;
  for (let i = 144; i <= 255; i++) lengths[i] = 9;
  for (let i = 256; i <= 279; i++) lengths[i] = 7;
  for (let i = 280; i <= 287; i++) lengths[i] = 8;
  return buildHuffmanTable(lengths);
}

function buildFixedDistTable() {
  const lengths = new Array(32).fill(5);
  return buildHuffmanTable(lengths);
}

const FIXED_LITLEN = buildFixedLitLenTable();
const FIXED_DIST   = buildFixedDistTable();

// ── Length/distance decode tables (RFC 1951 §3.2.5) ─────────────────────────

// Extra bits for length codes 257–285
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0,  // 257–264
  1, 1, 1, 1,               // 265–268
  2, 2, 2, 2,               // 269–272
  3, 3, 3, 3,               // 273–276
  4, 4, 4, 4,               // 277–280
  5, 5, 5, 5,               // 281–284
  0,                        // 285
];
// Base lengths for codes 257–285
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10,
  11, 13, 15, 17,
  19, 23, 27, 31,
  35, 43, 51, 59,
  67, 83, 99, 115,
  131, 163, 195, 227,
  258,
];
// Extra bits for distance codes 0–29
const DIST_EXTRA = [
  0, 0, 0, 0,
  1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
// Base distances for codes 0–29
const DIST_BASE = [
  1, 2, 3, 4,
  5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577,
];

// ── Dynamic Huffman block ─────────────────────────────────────────────────────

// Code length alphabet order
const CLCL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function readDynamicTables(br) {
  const hlit  = br.read(5) + 257; // number of literal/length codes
  const hdist = br.read(5) + 1;   // number of distance codes
  const hclen = br.read(4) + 4;   // number of code-length codes

  // Read code-length code lengths
  const clLengths = new Array(19).fill(0);
  for (let i = 0; i < hclen; i++) {
    clLengths[CLCL_ORDER[i]] = br.read(3);
  }
  const clTable = buildHuffmanTable(clLengths);

  // Decode literal/length + distance code lengths
  const allLengths = [];
  while (allLengths.length < hlit + hdist) {
    const sym = br.decodeSymbol(clTable);
    if (sym < 16) {
      allLengths.push(sym);
    } else if (sym === 16) {
      // Copy previous length 3–6 times
      if (allLengths.length === 0) throw new Error('Code length repeat with no previous value');
      const repeat = br.read(2) + 3;
      const prev = allLengths[allLengths.length - 1];
      for (let i = 0; i < repeat; i++) allLengths.push(prev);
    } else if (sym === 17) {
      // Repeat zero 3–10 times
      const repeat = br.read(3) + 3;
      for (let i = 0; i < repeat; i++) allLengths.push(0);
    } else { // sym === 18
      // Repeat zero 11–138 times
      const repeat = br.read(7) + 11;
      for (let i = 0; i < repeat; i++) allLengths.push(0);
    }
  }

  const litLenTable = buildHuffmanTable(allLengths.slice(0, hlit));
  const distTable   = buildHuffmanTable(allLengths.slice(hlit, hlit + hdist));
  return { litLenTable, distTable };
}

// ── Compressed block decoder ──────────────────────────────────────────────────

function decodeCompressedBlock(br, litLenTable, distTable, out) {
  while (true) {
    const sym = br.decodeSymbol(litLenTable);
    if (sym < 256) {
      // Literal byte
      out.push(sym);
    } else if (sym === 256) {
      // End of block
      break;
    } else {
      // Length/distance back-reference
      const lenIdx = sym - 257;
      if (lenIdx >= LENGTH_BASE.length) throw new Error(`Invalid length symbol: ${sym}`);
      const length = LENGTH_BASE[lenIdx] + br.read(LENGTH_EXTRA[lenIdx]);

      const distSym = br.decodeSymbol(distTable);
      if (distSym >= DIST_BASE.length) throw new Error(`Invalid distance symbol: ${distSym}`);
      const dist = DIST_BASE[distSym] + br.read(DIST_EXTRA[distSym]);

      // Copy `length` bytes from `dist` bytes back in `out`
      let copyPos = out.length - dist;
      if (copyPos < 0) throw new Error('Back-reference distance exceeds output length');
      for (let i = 0; i < length; i++) {
        out.push(out[copyPos++]);
      }
    }
  }
}

// ── Main inflate entry point ──────────────────────────────────────────────────

/**
 * Decompress raw DEFLATE data (RFC 1951, no zlib/gzip wrapper).
 *
 * @param {Uint8Array} compressedBytes
 * @returns {Uint8Array}
 * @throws {Error} on corrupt input (caller wraps as ERR_DECOMPRESS_FAILED)
 */
export function inflate(compressedBytes) {
  return inflateWithConsumed(compressedBytes).out;
}

/**
 * Like {@link inflate}, but also reports how many input bytes were consumed.
 *
 * HWP writers may concatenate several independent DEFLATE members in one
 * stream, so the caller needs to know where the first member ended in order to
 * continue from the right offset.
 *
 * @param {Uint8Array} compressedBytes
 * @returns {{ out: Uint8Array, consumed: number }}
 */
export function inflateWithConsumed(compressedBytes) {
  const br = new BitReader(compressedBytes);
  // Use a plain array for output; convert to Uint8Array at the end.
  // For large streams this is slower than a growable buffer, but simpler
  // and correct for the file sizes HWP documents produce.
  const out = [];

  let isFinal = false;
  while (!isFinal) {
    isFinal = br.read(1) === 1;
    const btype = br.read(2);

    if (btype === 0) {
      // ── Stored block ────────────────────────────────────────────────────────
      br.alignByte();
      const len  = br.readBytes(2);
      const nlen = br.readBytes(2);
      if ((len & 0xFFFF) !== (~nlen & 0xFFFF)) {
        throw new Error('Stored block length check failed');
      }
      const slice = br.readByteSlice(len);
      for (const b of slice) out.push(b);

    } else if (btype === 1) {
      // ── Fixed Huffman ───────────────────────────────────────────────────────
      decodeCompressedBlock(br, FIXED_LITLEN, FIXED_DIST, out);

    } else if (btype === 2) {
      // ── Dynamic Huffman ─────────────────────────────────────────────────────
      const { litLenTable, distTable } = readDynamicTables(br);
      decodeCompressedBlock(br, litLenTable, distTable, out);

    } else {
      throw new Error('Invalid DEFLATE block type 3');
    }
  }

  return { out: new Uint8Array(out), consumed: br.consumedBytes() };
}
