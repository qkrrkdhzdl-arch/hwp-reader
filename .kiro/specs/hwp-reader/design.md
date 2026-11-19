# HWP Reader — Architecture & Design

---

## 1. Module map

```
index.html
├── src/app.js          Entry point: wires UI events, orchestrates the pipeline
├── src/cfb.js          OLE2 Compound File Binary parser
├── src/inflate.js      Pure-JS raw DEFLATE decompressor (fallback)
├── src/hwp.js          HWP FileHeader + stream dispatcher + document model builder
├── src/records.js      HWP record stream decoder + HWPTAG constants
└── src/render.js       DOM renderer: tree panel, text view, inspector, export
styles/app.css
tests/
├── cfb.test.js
├── records.test.js
├── inflate.test.js
├── hwp.test.js
├── errors.test.js
└── fixtures/
    ├── sample.hwp          Minimal real (or synthetic) HWP 5.0 document
    └── sample.expected.json  Golden JSON output
```

All files are plain ES modules. No CommonJS. `src/inflate.js` is the only file without browser-specific APIs so it runs in Node directly; `src/cfb.js`, `src/records.js`, and `src/hwp.js` accept `ArrayBuffer` / `Uint8Array` and have no DOM dependency. `src/render.js` and `src/app.js` are browser-only.

---

## 2. CFB layer (`src/cfb.js`)

### 2.1 Data model

```js
class CfbFile {
  sectorSize: number          // 512 or 4096
  miniSectorSize: number      // 64
  miniStreamCutoff: number    // default 4096
  fat: Int32Array             // full FAT; fat[sectorId] = next sectorId (or ENDOFCHAIN/FREESECT)
  miniFat: Int32Array         // mini-FAT; indexed by mini-sector ID
  directories: DirEntry[]     // all directory entries, entry 0 = root
  miniStreamData: Uint8Array  // content of the root entry's stream = mini stream container
}

class DirEntry {
  sid: number          // 0-based index into directories[]
  name: string         // decoded from UTF-16LE
  type: number         // 0=empty 1=storage 2=stream 5=root
  startSector: number
  size: number
  childSid: number
  leftSid: number
  rightSid: number
}
```

### 2.2 Parsing sequence

1. **Header** — read 512 bytes; validate magic `D0 CF 11 E0 A1 B1 1A E1`; extract sector size power (offset 30, uint16), mini-sector size power (offset 32), FAT sector count (offset 44), first directory sector (offset 48), mini-stream cutoff (offset 56), first mini-FAT sector (offset 60), mini-FAT sector count (offset 64), first DIFAT sector (offset 68), DIFAT sector count (offset 72), and the 109-entry DIFAT array starting at offset 76.

2. **FAT construction** — allocate `Int32Array` with `totalSectors` entries. Iterate the DIFAT array (skip `FREESECT = 0xFFFFFFFF`); for each FAT sector ID, copy its 128 (or 1024 for version 4) `int32` entries into `fat[]` at the correct offset. Chase DIFAT chain sectors (at offset `sectorSize - 4` of each DIFAT sector) until `ENDOFCHAIN`.

3. **Directory** — follow the FAT chain from `firstDirSector`; concatenate sector data; split into 128-byte entries; decode each `DirEntry`. Type-5 root entry must be at index 0.

4. **Mini stream** — root entry's `startSector` chain gives the mini-stream container. Load it into `miniStreamData`. Build `miniFat` by chaining `firstMiniFatSector`.

5. **Stream read** — `readStream(name)`: walk the directory red-black tree (left/right/child SIDs) from the root's child to find the entry by name (case-sensitive, UTF-16LE). If `entry.size < miniStreamCutoff`, read from `miniStreamData` via mini-FAT; else read from main sectors via FAT. Concatenate sector slices (last sector may be partial; use `entry.size` as the exact length).

### 2.3 Sector arithmetic

```
sectorOffset(id) = 512 + id * sectorSize        // header is always 512 bytes
miniSectorOffset(id) = id * miniSectorSize       // offset within miniStreamData
```

### 2.4 Cycle guard

Track visited sector IDs in a `Set` during any chain traversal. A re-visited ID throws `ERR_CFB_CORRUPT`.

---

## 3. FileHeader & flags (`src/hwp.js` — `parseFileHeader`)

The `FileHeader` stream is exactly 256 bytes, never compressed.

```
Offset  Size  Field
0       32    Signature: "HWP Document File\0\0\0\0\0\0\0\0\0\0\0\0\0\0" (ASCII)
32      4     Version: [revision, build, minor, major] little-endian (major at byte 35)
36      4     Flags (little-endian uint32)
40      216   Reserved
```

Flag bits (LSB = bit 0):

| Bit | Name | Action on set |
|---|---|---|
| 0 | `compressed` | decompress BodyText/Section* and DocInfo streams |
| 1 | `encrypted` | throw `ERR_ENCRYPTED` immediately |
| 2 | `distribution` | throw `ERR_DISTRIBUTION` immediately |
| 3 | `script` | noted in model, no action |
| 4 | `drm` | throw `ERR_ENCRYPTED` (DRM = encrypted variant) |
| 9 | `hasMemo` | parse memo streams if present |

---

## 4. Record decoder (`src/records.js`)

### 4.1 Header format

Each record occupies at minimum 4 bytes:

```
bits  0– 9: tagId   (10 bits)
bits 10–19: level   (10 bits)
bits 20–31: size    (12 bits; 0xFFF = extended)
```

If `size === 0xFFF`, read the next `uint32` as the actual payload byte count.

```js
function* decodeRecords(bytes /* Uint8Array */) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos < bytes.length) {
    const hdr = view.getUint32(pos, true);
    pos += 4;
    const tagId = hdr & 0x3FF;
    const level = (hdr >>> 10) & 0x3FF;
    let size  = (hdr >>> 20) & 0xFFF;
    if (size === 0xFFF) {
      size = view.getUint32(pos, true);
      pos += 4;
    }
    if (pos + size > bytes.length) throw new HwpError('ERR_RECORD_OVERRUN', ...);
    yield { tagId, level, size, payload: bytes.subarray(pos, pos + size) };
    pos += size;
  }
}
```

### 4.2 HWPTAG constants

Defined as a frozen object: `TAGS = Object.freeze({ DOCUMENT_PROPERTIES: 0x10, ... })`. A reverse map `TAG_NAMES` (number → string) is derived from `TAGS` for the inspector display.

### 4.3 Paragraph text decoder

`decodeParagraphText(payload: Uint8Array): { text: string, controls: InlineControl[] }`

Iterate the payload two bytes at a time (UTF-16LE `uint16`):

```
cp = view.getUint16(pos, true); pos += 2
if cp >= 0x0020:
    text += String.fromCharCode(cp)
elif cp === 0x000D:
    text += '\n'   // paragraph break
elif cp === 0x000A:
    text += '\n'   // line break
elif cp === 0x0009:
    text += '\t'   // tab
else:              // inline or extended control (cp <= 0x001F, excluding the above)
    // The character occupies 16 bytes total in the char array:
    // 2 bytes for cp already consumed + 14 bytes of payload/padding
    ctrlPayload = payload.subarray(pos, pos + 14); pos += 14
    controls.push({ type: cp, payload: ctrlPayload })
```

---

## 5. Document model (`src/hwp.js` — `buildDocument`)

### 5.1 Structure

```ts
interface HwpDocument {
  version: { major: number, minor: number, build: number, revision: number }
  flags: { compressed: boolean, encrypted: boolean, distribution: boolean,
           script: boolean, drm: boolean, hasMemo: boolean }
  previewText: string | null
  docInfo: { idMappings: number[] | null }
  sections: Section[]
}

interface Section {
  index: number
  paragraphs: Paragraph[]
}

interface Paragraph {
  index: number
  text: string
  hasTable: boolean
  hasInlineObject: boolean
  table?: Table
  inlineControls: InlineControl[]
}

interface Table {
  rowCount: number
  colCount: number
  cells: Cell[]
}

interface Cell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  paragraphs: Paragraph[]
}
```

### 5.2 Section parsing algorithm

For each `BodyText/Section{N}` stream (sorted by N):

1. Decompress if `flags.compressed`.
2. Call `decodeRecords(bytes)` as a generator.
3. Maintain a stack `[section, currentParagraph, currentTable, currentCell]` driven by `level`.
4. On `HWPTAG_PARA_HEADER` (0x34): push a new `Paragraph` to the current container.
5. On `HWPTAG_PARA_TEXT` (0x42): call `decodeParagraphText`; assign result to `currentParagraph`.
6. On `HWPTAG_CTRL_HEADER` (0x45): read the 4-byte `ctrlId` field; dispatch:
   - `ctrlId === 'tbl\x00'` (0x74626C00 LE = bytes `00 6C 62 74`): next `HWPTAG_TABLE` record starts a table.
7. On `HWPTAG_TABLE` (0x4A): read `rowCount` (uint16 at offset 4), `colCount` (uint16 at offset 6); create `Table`; attach to `currentParagraph`.
8. On `HWPTAG_CELL` (0x4D): read `col` (uint16 at 0), `row` (uint16 at 2), `colSpan` (uint16 at 4), `rowSpan` (uint16 at 6); push a `Cell` onto the table; nested `HWPTAG_PARA_*` records (identified by `level > current`) fill cell paragraphs.

### 5.3 Level-based nesting

HWP records embed structure via the `level` field. A record with `level == L` is a child of the most recent record with `level == L-1`. Maintain a stack indexed by level to know the current container at each depth.

---

## 6. Render layer (`src/render.js`)

### 6.1 Tree panel

Built via `document.createElement` calls, not innerHTML, to avoid XSS. Each section gets a `<details>` element; each paragraph a `<summary>` / `<div>` with `data-para-index`. Click handlers call `scrollToElement(index)` in the main view.

### 6.2 Text view

```
<article id="doc-view">
  <section class="hwp-section" data-section="0">
    <p class="hwp-para" data-para="0">…text…</p>
    <div class="hwp-table">
      <table>…</table>
    </div>
  </section>
</article>
```

Paragraph text is set via `textContent` (never `innerHTML`) to prevent injection. Tables are built from the `Cell[]` model using `insertRow` / `insertCell`.

### 6.3 Structure inspector

Three sub-panels, each lazily populated on first open:

1. **CFB overview** — table: sector size, total sectors, FAT sector IDs (comma-separated), directory start sector.
2. **Stream list** — sortable `<table>`: name, size (bytes), start sector (hex), storage path, mini-stream flag.
3. **Record inspector** — activated when the user clicks a stream row. Streams are decoded on demand (decompressed first). Each record is a row: tag ID (hex), symbolic name, level, size, hex dump of first 16 payload bytes.

### 6.4 JSON export

`exportJson(doc, filename)`: serialises via a `JSON.stringify` replacer that converts `Uint8Array` to a hex string (`Array.from(u8).map(b => b.toString(16).padStart(2,'0')).join('')`) and strips `ArrayBuffer` entries. Downloads via `URL.createObjectURL(new Blob([json], {type:'application/json'}))`.

### 6.5 HTML export

`exportHtml(doc, filename)`: builds a minimal `<!DOCTYPE html>` document string containing the rendered text view HTML (cloned from the DOM, with inline styles for tables) and an embedded CSS reset. Downloads the same way as JSON export.

---

## 7. Error taxonomy

All errors are instances of `HwpError extends Error`:

```js
class HwpError extends Error {
  constructor(code, messageKo, messageEn) {
    super(`${messageKo} / ${messageEn}`);
    this.code = code;
    this.name = 'HwpError';
  }
}
```

Error codes and their detection points:

| Code | Module | Detection point |
|---|---|---|
| `ERR_NOT_CFB` | cfb.js | First 8 bytes |
| `ERR_CFB_VERSION` | cfb.js | Header offset 26 |
| `ERR_CFB_CORRUPT` | cfb.js | FAT chain traversal, directory read |
| `ERR_STREAM_NOT_FOUND` | cfb.js | `readStream()` |
| `ERR_NOT_HWP` | hwp.js | FileHeader bytes 0–31 |
| `ERR_HWP_VERSION` | hwp.js | FileHeader bytes 35 |
| `ERR_ENCRYPTED` | hwp.js | FileHeader flag bit 1 or 4 |
| `ERR_DISTRIBUTION` | hwp.js | FileHeader flag bit 2 |
| `ERR_DECOMPRESS_FAILED` | hwp.js | DecompressionStream / inflate |
| `ERR_RECORD_OVERRUN` | records.js | `decodeRecords()` |
| `ERR_NO_BODY` | hwp.js | Directory scan |

`app.js` wraps the entire pipeline in a `try/catch`; a caught `HwpError` is displayed in a `role="alert"` banner. Unknown errors (non-`HwpError`) display a generic "예상치 못한 오류 / Unexpected error" message plus the stack trace in a `<details>` element for debugging.

---

## 8. Browser APIs used

| API | Purpose | Fallback |
|---|---|---|
| `File.arrayBuffer()` | Read dropped/picked file | `FileReader.readAsArrayBuffer` |
| `DataView` | Parse little-endian binary fields | None needed |
| `TextDecoder('utf-16le')` | Decode directory entry names, PrvText | Manual UTF-16LE loop |
| `DecompressionStream('deflate-raw')` | Decompress HWP streams | `src/inflate.js` |
| `URL.createObjectURL` + `Blob` | Trigger file downloads | None |
| ES module `import` | Module system | None |

No WebAssembly, no SharedArrayBuffer, no Service Worker — keeps the app usable from `file://`.

---

## 9. Testing strategy

Tests run with `node --test` (Node 18+). No browser required.

### 9.1 CFB layer (`tests/cfb.test.js`)

Build a minimal valid CFB in-memory:
- 512-byte header with correct magic, version 3, one FAT sector.
- One FAT sector containing a chain: sector 1 → ENDOFCHAIN (the directory sector).
- One directory sector with two entries: root (type 5) and a stream named `Test` (type 2, 10 bytes, sector 2).
- One data sector with 10 bytes.

Assertions:
- `parseCfb(buffer).directories[1].name === 'Test'`
- `readStream(cfb, 'Test')` returns a 10-byte `Uint8Array`.
- Wrong magic → `ERR_NOT_CFB`.
- FAT cycle → `ERR_CFB_CORRUPT`.

### 9.2 Record header (`tests/records.test.js`)

Construct `Uint8Array` payloads directly and assert:
- Standard header: tagId 0x34, level 0, size 10.
- Extended header: size field = 0xFFF, followed by uint32 = 2000.
- Record overrun: declared size extends past buffer end → `ERR_RECORD_OVERRUN`.
- Multiple sequential records all decoded in order.

### 9.3 Text extraction (`tests/hwp.test.js`)

Build a hand-crafted `HWPTAG_PARA_TEXT` payload (UTF-16LE bytes):
- Characters `안녕하세요` (5 Unicode chars, 10 bytes).
- Followed by 0x000D (paragraph break, 2 bytes).
- Followed by `Hello` (5 chars, 10 bytes).
- Followed by 0x0000 (inline control, 2 bytes) + 14 bytes of dummy payload.

Assertions:
- Extracted text = `"안녕하세요\nHello"`.
- One `InlineControl` with `type === 0`.

### 9.4 Inflate (`tests/inflate.test.js`)

Use Node's `zlib.deflateRawSync` to compress a known byte array; pass it to the pure-JS `inflate`; verify output matches original.

### 9.5 Error classification (`tests/errors.test.js`)

Feed crafted invalid inputs and assert the correct error code:
- Empty buffer → `ERR_NOT_CFB`.
- Valid CFB, wrong HWP signature → `ERR_NOT_HWP`.
- Valid HWP, encrypted flag → `ERR_ENCRYPTED`.
- Valid HWP, distribution flag → `ERR_DISTRIBUTION`.
- Valid HWP, version 4 major → `ERR_HWP_VERSION`.

### 9.6 Fixture golden test (`tests/hwp.test.js`)

Load `tests/fixtures/sample.hwp`; parse it; compare `JSON.stringify(doc, replacer)` against `tests/fixtures/sample.expected.json`. Fail if the two differ.

---

## 10. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `HWPTAG_PARA_TEXT` offset 67 vs 66 discrepancy | High | Silent empty paragraphs | Test against real files; log tag IDs seen and missed; keep both 0x42 and 0x43 in the decoder and emit a console warning if neither matches. |
| Table `ctrlId` byte order uncertainty | Medium | Tables silently skipped | Dump raw `ctrlId` bytes in the inspector; test against a fixture containing a table. |
| `DecompressionStream('deflate-raw')` absent in older iOS Safari | Medium | App unusable on older iOS | Feature-detect at startup; always bundle `src/inflate.js`; switch on `typeof DecompressionStream`. |
| Very large files (> 50 MB) blocking the main thread | Medium | Browser freeze | Show progress; consider chunked parsing with `setTimeout` yields; enforce the 50 MB guard per REQ-1.3. |
| CFB version 4 (4096-byte sectors) rare in HWP files | Low | Parsing failure on unusual files | Implementation covers it; a version-4 test case is included in `cfb.test.js`. |
| Level-based nesting misread for unusual record sequences | Medium | Corrupt document model | Log and skip records with levels that skip more than one step; expose warnings in the inspector. |
| UTF-16LE surrogate pairs in Korean text | Low | Mojibake for rare characters | Use `TextDecoder('utf-16le')` on the full payload rather than `String.fromCharCode` on individual 16-bit units, to handle surrogate pairs correctly. |
