# HWP Reader — Tasks

Ordered task list. Each task is small enough to implement and test in one sitting.
Check off tasks as they are completed. Dependencies are listed per task.

---

## Phase 1 — Project scaffold

- [x] **TASK-01** — Create `index.html` with `<meta viewport>`, `<script type="module" src="src/app.js">`, a drag-and-drop zone (`role="button"`, `tabindex="0"`), a file input (`accept=".hwp,.hwpx"`), an error banner placeholder (`role="alert"`), and three empty panel placeholders: `#doc-tree`, `#doc-view`, `#inspector`.
  - _Depends on: nothing_

- [x] **TASK-02** — Create `styles/app.css` with a two-column layout (tree panel 260 px / main view flex-grow), inspector panel as a collapsible bottom/side drawer, Korean web-safe font stack, and WCAG-AA contrast colours. Mobile breakpoint collapses to single column.
  - _Depends on: TASK-01_

- [x] **TASK-03** — Create `src/app.js` as an ES module stub that exports nothing but wires drag-and-drop events (`dragover`, `drop`) and file input `change` events to a `handleFile(file)` placeholder. Add the large-file guard (> 50 MB: show warning, await user confirmation via a `<dialog>` before proceeding). No parsing yet.
  - _Depends on: TASK-01_

---

## Phase 2 — CFB parser (`src/cfb.js`)

- [x] **TASK-04** — Implement `parseHeader(buffer)`: read the 8-byte magic, validate it, extract sector-size power (offset 30), mini-sector-size power (offset 32), FAT sector count (44), first directory sector (48), mini-stream cutoff (56), first mini-FAT sector (60), mini-FAT sector count (64), first DIFAT sector (68), DIFAT sector count (72), and 109-entry DIFAT array (76). Throw `HwpError('ERR_NOT_CFB', …)` on bad magic; `HwpError('ERR_CFB_VERSION', …)` on unknown major version. Export `HwpError` from this file.
  - _Depends on: nothing_

- [x] **TASK-05** — Implement FAT construction: iterate the DIFAT array, skip `0xFFFFFFFF` entries, read each FAT sector and copy its `int32` entries into a flat `Int32Array`. Chase DIFAT chain sectors (`0xFFFFFFFE` = ENDOFCHAIN at the last 4 bytes of a DIFAT sector). Guard against cycles with a `Set`. Throw `ERR_CFB_CORRUPT` on cycle or out-of-range sector ID.
  - _Depends on: TASK-04_

- [x] **TASK-06** — Implement directory-entry parsing: follow the FAT chain from `firstDirSector`; concatenate sector data; split into 128-byte entries; decode each `DirEntry` (name from UTF-16LE bytes 0–63 with length at offset 64, type at 66, start sector at 116, size at 120, child SID at 108, left SID at 100, right SID at 104). Assert entry 0 is root (type 5); throw `ERR_CFB_CORRUPT` otherwise.
  - _Depends on: TASK-05_

- [x] **TASK-07** — Implement mini-stream support: read the root entry's FAT chain to build `miniStreamData`; build `miniFat` by chaining the mini-FAT sectors. Implement `readStream(cfb, name)`: traverse the directory red-black tree from root's child SID using left/right SIDs (case-sensitive name match); if `entry.size < miniStreamCutoff`, read from `miniStreamData` via mini-FAT; else read from main FAT. Throw `ERR_STREAM_NOT_FOUND` for missing names.
  - _Depends on: TASK-06_

- [ ] **TASK-08** — Write `tests/cfb.test.js`: build a synthetic version-3 CFB buffer in-test (correct header, one FAT sector, directory sector, one data stream `Test` with known content, root entry with correct child chain). Assert: correct stream content, `ERR_NOT_CFB` on bad magic, `ERR_CFB_CORRUPT` on FAT cycle, `ERR_STREAM_NOT_FOUND` on unknown stream name. Run with `node --test`.
  - _Depends on: TASK-07_

---

## Phase 3 — Pure-JS inflate fallback (`src/inflate.js`)

- [x] **TASK-09** — Implement a minimal raw DEFLATE decompressor in `src/inflate.js`. Must handle: stored blocks (BTYPE 00), fixed Huffman (BTYPE 01), dynamic Huffman (BTYPE 10). Export `inflate(compressedBytes: Uint8Array): Uint8Array`. Throw a plain `Error` on corrupt input (caller wraps it as `ERR_DECOMPRESS_FAILED`). No dependencies outside the file.
  - _Depends on: nothing_

- [x] **TASK-10** — Write `tests/inflate.test.js`: use `node:zlib` `deflateRawSync` to compress a 200-byte test buffer and a 1-byte edge-case buffer; pass each to `inflate`; assert byte-for-byte equality with the original.
  - _Depends on: TASK-09_

---

## Phase 4 — HWP FileHeader + decompression (`src/hwp.js`)

- [x] **TASK-11** — Implement `parseFileHeader(fileHeaderBytes: Uint8Array)`: verify the 32-byte ASCII signature; read version bytes at offsets 32–35 (order: `[revision, build, minor, major]` LE, so `major = bytes[35]`); read flags uint32 at offset 36. Throw `ERR_NOT_HWP`, `ERR_HWP_VERSION` (major ≠ 5), `ERR_ENCRYPTED` (bit 1 or bit 4), `ERR_DISTRIBUTION` (bit 2). Return `{ version, flags }`.
  - _Depends on: TASK-04 (HwpError class)_

- [x] **TASK-12** — Implement `decompressStream(bytes: Uint8Array, streamName: string): Promise<Uint8Array>`: feature-detect `DecompressionStream`; if available, pipe bytes through `DecompressionStream('deflate-raw')` and collect chunks; else call `inflate(bytes)` from `src/inflate.js`. Catch any error and rethrow as `HwpError('ERR_DECOMPRESS_FAILED', …)` including `streamName`.
  - _Depends on: TASK-09, TASK-11_

---

## Phase 5 — Record decoder (`src/records.js`)

- [x] **TASK-13** — Implement `decodeRecords(bytes: Uint8Array)` as a generator (see design §4.1). Export `TAGS` (frozen object of all HWPTAG constants, design §4.2) and `TAG_NAMES` (reverse map). Throw `ERR_RECORD_OVERRUN` when payload end exceeds `bytes.length`.
  - _Depends on: TASK-04 (HwpError class)_

- [x] **TASK-14** — Write `tests/records.test.js`: construct `Uint8Array` buffers encoding known record sequences; assert correct tagId/level/size for standard header, extended size header, and two sequential records. Assert `ERR_RECORD_OVERRUN` on overrun. Assert `TAG_NAMES[0x34] === 'PARA_HEADER'` (or equivalent).
  - _Depends on: TASK-13_

---

## Phase 6 — Paragraph text decoder (`src/records.js` or `src/hwp.js`)

- [x] **TASK-15** — Implement `decodeParagraphText(payload: Uint8Array): { text: string, controls: InlineControl[] }` (design §4.3). Handle: plain chars ≥ 0x0020 accumulated into `text`; 0x000D and 0x000A → `'\n'`; 0x0009 → `'\t'`; control chars 0x0000–0x001F (excluding 0x0009, 0x000A, 0x000D) → skip 14 bytes and push to `controls[]`. Use `TextDecoder('utf-16le')` for the final string assembly on the plain-character runs to handle surrogate pairs correctly.
  - _Depends on: TASK-13_

- [ ] **TASK-16** — Write paragraph-text unit tests in `tests/hwp.test.js`: hand-build a payload with `안녕하세요`, paragraph break, `Hello`, and one inline control (0x0000 + 14 dummy bytes). Assert `text === "안녕하세요\nHello"` and `controls.length === 1`.
  - _Depends on: TASK-15_

---

## Phase 7 — Document model builder (`src/hwp.js`)

- [x] **TASK-17** — Implement `findBodyTextStreams(cfb)`: scan directory entries whose parent storage is named `BodyText`; collect names matching `/^Section\d+$/`; sort by numeric suffix; return the sorted names. Throw `ERR_NO_BODY` if the list is empty.
  - _Depends on: TASK-07_

- [x] **TASK-18** — Implement `parseSection(sectionBytes: Uint8Array, sectionIndex: number): Section`: iterate `decodeRecords`; on `HWPTAG_PARA_HEADER` push a new `Paragraph`; on `HWPTAG_PARA_TEXT` call `decodeParagraphText` and assign to the current paragraph; skip all other tags. Use a level-stack (array indexed by level) to maintain the current container. Return the completed `Section`.
  - _Depends on: TASK-13, TASK-15_

- [x] **TASK-19** — Extend `parseSection` for tables: on `HWPTAG_CTRL_HEADER`, read the 4-byte `ctrlId`; if it matches the table control ID (`0x74626C00` in LE bytes = `\0lbt`), set a `pendingTable` flag. On `HWPTAG_TABLE`, read `rowCount` (uint16 at offset 4) and `colCount` (uint16 at offset 6); create a `Table` and attach it to `currentParagraph.table`; push the table onto the level-stack. On `HWPTAG_CELL`, read `col` (uint16 at 0), `row` (uint16 at 2), `colSpan` (uint16 at 4), `rowSpan` (uint16 at 6); push a `Cell` onto the current table; nested `HWPTAG_PARA_*` records (level > table level) fill cell paragraphs.
  - _Depends on: TASK-18_

- [x] **TASK-20** — Implement `buildDocument(buffer: ArrayBuffer): Promise<HwpDocument>`: call `parseCfb(buffer)`; `readStream(cfb, 'FileHeader')` → `parseFileHeader`; optionally `readStream(cfb, 'PrvText')` → decode UTF-16LE; `readStream(cfb, 'DocInfo')` → decompress if needed → `decodeRecords` → extract `idMappings` from tag 0x11; for each section stream: `readStream` → decompress → `parseSection`. Return the full `HwpDocument`.
  - _Depends on: TASK-11, TASK-12, TASK-17, TASK-19_

---

## Phase 8 — Test fixtures and golden test

- [x] **TASK-21** — Create `tests/fixtures/sample.hwp`: write a Node.js script (`tests/fixtures/generate.js`, deleted after use) that builds a minimal valid HWP 5.0 binary (CFB v3, one FAT sector, FileHeader stream, DocInfo stream with HWPTAG_DOCUMENT_PROPERTIES, one BodyText/Section0 stream with two paragraphs `가나다` and `ABC`, uncompressed). Save the buffer as `sample.hwp`. Run the script once, then delete `generate.js`.
  - _Depends on: TASK-07, TASK-18_

- [x] **TASK-22** — Generate `tests/fixtures/sample.expected.json` by running `buildDocument` on `sample.hwp` and serialising the result. Commit both files. Add the golden test to `tests/hwp.test.js`: parse `sample.hwp` and assert the output matches `sample.expected.json`.
  - _Depends on: TASK-20, TASK-21_

---

## Phase 9 — Error-classification tests

- [x] **TASK-23** — Write `tests/errors.test.js`: assert each `HwpError` code is thrown for the correct crafted input:
  - 7-byte buffer → `ERR_NOT_CFB`
  - 512-byte buffer with wrong magic → `ERR_NOT_CFB`
  - Valid CFB with wrong `FileHeader` signature → `ERR_NOT_HWP`
  - Valid HWP with version major = 4 → `ERR_HWP_VERSION`
  - Valid HWP with encrypted flag → `ERR_ENCRYPTED`
  - Valid HWP with distribution flag → `ERR_DISTRIBUTION`
  - Valid HWP with corrupt DEFLATE stream (compressed flag set) → `ERR_DECOMPRESS_FAILED`
  - _Depends on: TASK-20_

---

## Phase 10 — Render layer (`src/render.js`)

- [x] **TASK-24** — Implement `renderTree(doc: HwpDocument, container: HTMLElement)`: build a `<ul>` tree with `<li>` per section containing nested `<li>` per paragraph (label = first 40 chars of `paragraph.text` or "[빈 단락 / empty]"). Tables get a `<li>` labelled "표 N×M / Table N×M". Attach `click` listeners that call `scrollToElement(sectionIndex, paraIndex)`.
  - _Depends on: TASK-20_

- [x] **TASK-25** — Implement `renderDocView(doc: HwpDocument, container: HTMLElement)`: build `<section class="hwp-section">` per section; `<p class="hwp-para">` per paragraph using `textContent` assignment; `<div class="hwp-table"><table>` for each table using `insertRow`/`insertCell` with `textContent`. Image references emit a `<span class="hwp-image-placeholder">` with the BIN ID.
  - _Depends on: TASK-20_

- [x] **TASK-26** — Implement the structure inspector (`renderInspector(cfb, doc, container)`): three `<details>` sections — CFB overview table, stream list table (click a row to decode that stream's records), and record list table with tag ID in hex, symbolic name from `TAG_NAMES`, level, size, and 16-byte hex dump. All lazy: stream records are decoded only when the user expands the record panel for that stream.
  - _Depends on: TASK-13, TASK-24_

- [x] **TASK-27** — Implement `exportJson(doc, filename)` and `exportHtml(doc, filename)` in `src/render.js`. JSON: replacer converts `Uint8Array` to hex string, omits `ArrayBuffer`. HTML: serialize `#doc-view` innerHTML, wrap in a minimal `<!DOCTYPE html>` document with an inline `<style>` block. Both use `URL.createObjectURL` + an `<a download>` click.
  - _Depends on: TASK-25_

---

## Phase 11 — App wiring and UI polish (`src/app.js`)

- [x] **TASK-28** — Wire `handleFile(file)` in `src/app.js` to the full pipeline: show spinner → `file.arrayBuffer()` → `buildDocument` → `renderTree` + `renderDocView` + `renderInspector` → hide spinner. On `HwpError`: display `.code` and `.message` in the `role="alert"` banner. On unknown error: display generic Korean/English message with the stack in a `<details>`.
  - _Depends on: TASK-20, TASK-24, TASK-25, TASK-26_

- [x] **TASK-29** — Add keyboard support to the drop zone: `keydown` on `Enter`/`Space` triggers the file picker. Add `aria-label` to all icon buttons. Verify all interactive elements have visible focus rings (CSS `outline`).
  - _Depends on: TASK-28_

- [x] **TASK-30** — Add "JSON 내보내기 / Export JSON" and "HTML 내보내기 / Export HTML" buttons to the toolbar; wire them to `exportJson` and `exportHtml` from `src/render.js`. Disable both buttons until a document is loaded.
  - _Depends on: TASK-27, TASK-28_

---

## Phase 12 — Final checks and documentation

- [ ] **TASK-31** — Write `README.md`: one-paragraph product description (Korean + English); usage instructions (open `index.html`, drag a `.hwp` file); supported features and known limitations (no images, no editing, no pixel-perfect layout); how to run the tests (`node --test`); format references (OLE2 spec URL, HWP 5.0 spec reference).
  - _Depends on: TASK-28_

- [ ] **TASK-32** — Run the full test suite (`node --test tests/*.test.js`) and confirm all tests pass. Remove any temporary files (`tests/fixtures/generate.js` if not already deleted). Confirm `index.html` opens from `file://` in Chrome and Firefox without console errors.
  - _Depends on: TASK-08, TASK-10, TASK-14, TASK-16, TASK-22, TASK-23_

---

## Dependency summary

```
TASK-01 ← TASK-02, TASK-03
TASK-04 ← TASK-05 ← TASK-06 ← TASK-07 ← TASK-08
                                        ← TASK-17 ← TASK-18 ← TASK-19 ← TASK-20
TASK-04 ← TASK-11 ← TASK-12 ← TASK-20
TASK-09 ← TASK-10
        ← TASK-12
TASK-13 ← TASK-14
        ← TASK-15 ← TASK-16
                  ← TASK-18
TASK-20 ← TASK-21 ← TASK-22
        ← TASK-23
        ← TASK-24 ← TASK-26 ← TASK-28 ← TASK-29
        ← TASK-25 ← TASK-27 ← TASK-30
                 ← TASK-28
TASK-28 ← TASK-31
TASK-08, TASK-10, TASK-14, TASK-16, TASK-22, TASK-23 ← TASK-32
```
