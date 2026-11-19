# HWP Reader — Requirements

Specification for a static, client-side web application that parses HWP 5.0 binary documents
in the browser using only Web Standards APIs.

---

## Actors

- **User** — anyone who opens the app in a modern browser (desktop or mobile).
- **App** — the client-side JavaScript running in the browser.

---

## 1. File ingestion

### REQ-1.1 — Drag-and-drop
**When** the user drags a `.hwp` file onto the drop zone,  
**the app shall** read the file as an `ArrayBuffer` via the File API without sending any bytes to a server.

*Acceptance criteria*  
- AC-1.1.1: Drop fires `dragover` prevention and `drop` capture; no browser navigation occurs.  
- AC-1.1.2: `file.arrayBuffer()` is used; no `XMLHttpRequest` or `fetch` is issued for the file.  
- AC-1.1.3: A loading indicator appears within 100 ms of the drop.

### REQ-1.2 — File picker
**When** the user clicks the "파일 열기 / Open file" button,  
**the app shall** open a file picker restricted to `.hwp` and `.hwpx` MIME types and ingest the selected file identically to drag-and-drop.

*Acceptance criteria*  
- AC-1.2.1: `<input type="file" accept=".hwp,.hwpx">` or File System Access API is used.  
- AC-1.2.2: Cancelling the picker leaves the current document displayed unchanged.

### REQ-1.3 — Large-file guard
**When** the selected file exceeds 50 MB,  
**the app shall** display a warning in Korean and English before parsing and allow the user to proceed or cancel.

*Acceptance criteria*  
- AC-1.3.1: Warning text names the actual file size in MB.  
- AC-1.3.2: Parsing does not begin until the user confirms.

---

## 2. CFB (OLE2 Compound File Binary) parsing

### REQ-2.1 — Signature validation
**When** the app reads the first 8 bytes of the buffer,  
**the app shall** verify they equal `D0 CF 11 E0 A1 B1 1A E1`.

*Acceptance criteria*  
- AC-2.1.1: A buffer shorter than 512 bytes produces error `ERR_NOT_CFB`.  
- AC-2.1.2: A wrong signature produces error `ERR_NOT_CFB` with the actual bytes in the message.

### REQ-2.2 — CFB header fields
**The app shall** parse the CFB header at byte 0 and extract:

| Field | Offset | Size |
|---|---|---|
| Minor version | 24 | 2 |
| Major version | 26 | 2 (3 = 512-byte sectors, 4 = 4096-byte sectors) |
| Sector size | computed as `1 << sectorSizePower` from offset 30 | — |
| Mini-sector size | computed as `1 << miniSectorSizePower` from offset 32 | — |
| Number of FAT sectors | 44 | 4 |
| First directory sector | 48 | 4 |
| Mini stream cutoff | 56 | 4 (default 4096) |
| First mini-FAT sector | 60 | 4 |
| Number of mini-FAT sectors | 64 | 4 |
| First DIFAT sector | 68 | 4 |
| Number of DIFAT sectors | 72 | 4 |
| DIFAT array | 76 | 109 × 4 |

*Acceptance criteria*  
- AC-2.2.1: Major version 3 → sector size 512; version 4 → sector size 4096.  
- AC-2.2.2: An unrecognised major version produces error `ERR_CFB_VERSION`.

### REQ-2.3 — FAT chain reconstruction
**The app shall** build the full FAT by reading the sectors listed in the DIFAT array (and chained DIFAT sectors for files with more than 109 FAT sectors), then follow sector chains to arbitrary length.

*Acceptance criteria*  
- AC-2.3.1: Sector ID `0xFFFFFFFE` (end-of-chain) terminates chain traversal.  
- AC-2.3.2: A cycle in the FAT (sector points to itself or to an earlier sector in the chain) produces error `ERR_CFB_CORRUPT`.  
- AC-2.3.3: A sector ID beyond the file's sector count produces error `ERR_CFB_CORRUPT`.

### REQ-2.4 — Directory entries
**The app shall** read all directory entries from the directory stream (each entry 128 bytes) and expose:
- entry name as a JS string (UTF-16LE, length from bytes 64–65, excluding the null terminator);
- entry type (0 = empty, 1 = storage, 2 = stream, 5 = root);
- start sector and stream size;
- child / left-sibling / right-sibling SIDs for tree traversal.

*Acceptance criteria*  
- AC-2.4.1: Entry 0 is always the root entry (type 5).  
- AC-2.4.2: Names are decoded correctly from UTF-16LE, e.g. `FileHeader`, `DocInfo`, `BodyText`, `PrvText`.

### REQ-2.5 — Stream extraction
**The app shall** extract any stream by name, using the mini stream when `stream size < miniStreamCutoff`.

*Acceptance criteria*  
- AC-2.5.1: Streams whose size ≥ 4096 are read from the main FAT chain.  
- AC-2.5.2: Streams whose size < 4096 are read from the mini stream via the mini-FAT chain.  
- AC-2.5.3: Reading a non-existent stream name produces error `ERR_STREAM_NOT_FOUND` with the name.

---

## 3. HWP FileHeader parsing

### REQ-3.1 — Signature
**When** the app reads the `FileHeader` stream (exactly 256 bytes),  
**the app shall** verify the first 32 bytes equal `HWP Document File\0\0\0\0\0\0\0\0\0\0\0\0\0\0` (ASCII).

*Acceptance criteria*  
- AC-3.1.1: A mismatch produces error `ERR_NOT_HWP`.

### REQ-3.2 — Version
**The app shall** read the 4-byte version field at offset 32 (packed as `major.minor.build.revision`, each 1 byte).

*Acceptance criteria*  
- AC-3.2.1: Version is exposed as `{ major, minor, build, revision }`.  
- AC-3.2.2: A major version other than 5 produces error `ERR_HWP_VERSION` naming the actual version.

### REQ-3.3 — Flags
**The app shall** read the 4-byte flags field at offset 36 and extract:

| Bit | Meaning |
|---|---|
| 0 | Compressed (streams are raw DEFLATE) |
| 1 | Encrypted |
| 2 | Distribution document (배포용) |
| 3 | Has script |
| 4 | DRM protected |
| 9 | Has memo |

*Acceptance criteria*  
- AC-3.3.1: If bit 1 (encrypted) is set, error `ERR_ENCRYPTED` is raised before any stream decode attempt.  
- AC-3.3.2: If bit 2 (distribution) is set, error `ERR_DISTRIBUTION` is raised.  
- AC-3.3.3: Compressed flag is passed to the stream decompressor; uncompressed streams are used as-is.

---

## 4. Stream decompression

### REQ-4.1 — Raw DEFLATE via browser API
**When** the compressed flag is set,  
**the app shall** decompress each HWP stream using `DecompressionStream('deflate-raw')`.

*Acceptance criteria*  
- AC-4.1.1: The result is a `Uint8Array` of the decompressed bytes.  
- AC-4.1.2: A corrupt DEFLATE stream produces error `ERR_DECOMPRESS_FAILED` with the stream name.

### REQ-4.2 — Pure-JS inflate fallback
**When** `DecompressionStream` is unavailable (e.g. in the Node.js test runner),  
**the app shall** fall back to a bundled pure-JS raw inflate implementation (`src/inflate.js`).

*Acceptance criteria*  
- AC-4.2.1: Fallback produces byte-for-byte identical output to the browser API for the same input.  
- AC-4.2.2: The fallback is selected automatically without configuration.

---

## 5. HWP record stream decoding

### REQ-5.1 — 4-byte record header
**The app shall** decode each record header as a 32-bit little-endian word:
- bits 0–9: `tagId`  
- bits 10–19: `level`  
- bits 20–31: `size` (12 bits; value `0xFFF` means extended)

**When** `size == 0xFFF`, **the app shall** read a following 4-byte little-endian `uint32` as the actual size.

*Acceptance criteria*  
- AC-5.1.1: `tagId` range 0–1023 is preserved exactly.  
- AC-5.1.2: `level` range 0–1023 is preserved exactly.  
- AC-5.1.3: Extended size is used when `size == 0xFFF`; the 4-byte extension is not counted in the payload offset.  
- AC-5.1.4: A record whose payload would extend beyond the stream end produces error `ERR_RECORD_OVERRUN`.

### REQ-5.2 — HWPTAG constants
**The app shall** define symbolic names for all tags it uses:

| Constant | Value | Decimal |
|---|---|---|
| `HWPTAG_BEGIN` | `0x10` | 16 |
| `HWPTAG_DOCUMENT_PROPERTIES` | `0x10` | 16 |
| `HWPTAG_ID_MAPPINGS` | `0x11` | 17 |
| `HWPTAG_BIN_DATA` | `0x12` | 18 |
| `HWPTAG_FACE_NAME` | `0x13` | 19 |
| `HWPTAG_BORDER_FILL` | `0x14` | 20 |
| `HWPTAG_CHAR_SHAPE` | `0x15` | 21 |
| `HWPTAG_TAB_DEF` | `0x16` | 22 |
| `HWPTAG_NUMBERING` | `0x17` | 23 |
| `HWPTAG_BULLET` | `0x18` | 24 |
| `HWPTAG_PARA_SHAPE` | `0x19` | 25 |
| `HWPTAG_STYLE` | `0x1A` | 26 |
| `HWPTAG_DOC_DATA` | `0x1B` | 27 |
| `HWPTAG_PARA_HEADER` | `0x34` | 52 |
| `HWPTAG_PARA_TEXT` | `0x42` | 66 (note: brief states 67, actual value is 0x42 = 66) |
| `HWPTAG_PARA_CHAR_SHAPE` | `0x43` | 67 |
| `HWPTAG_PARA_LINE_SEG` | `0x44` | 68 |
| `HWPTAG_CTRL_HEADER` | `0x45` | 69 |
| `HWPTAG_LIST_HEADER` | `0x46` | 70 |
| `HWPTAG_PAGE_DEF` | `0x47` | 71 |
| `HWPTAG_FOOTNOTE_SHAPE` | `0x48` | 72 |
| `HWPTAG_PAGE_BORDER_FILL` | `0x49` | 73 |
| `HWPTAG_TABLE` | `0x4A` | 74 |
| `HWPTAG_CELL` | `0x4D` | 77 |
| `HWPTAG_PARA_RANGE_TAG` | `0x59` | 89 |

*Acceptance criteria*  
- AC-5.2.1: Unrecognised tags are preserved in the structure model with their raw `tagId` and payload bytes.

### REQ-5.3 — HWPTAG_PARA_TEXT decoding (tag 0x42)
**The app shall** decode each `HWPTAG_PARA_TEXT` payload as UTF-16LE characters and handle inline controls:

| Code point (uint16) | Meaning | Payload bytes to skip |
|---|---|---|
| 0x0000 | Inline control start | 14 more bytes (8-byte payload follows after the 2-byte codepoint, then 6 bytes padding — total inline object = 16 bytes in the char array) |
| 0x0009 | Tab | 0 |
| 0x000A | Line break | 0 |
| 0x000D | Paragraph break | 0 |
| 0x0010–0x001F | Extended control | 14 more bytes each |
| 0x0001–0x0008, 0x000B, 0x000C, 0x000E, 0x000F | Reserved control | 14 more bytes each |

Plain text characters are code points ≥ 0x0020.

*Acceptance criteria*  
- AC-5.3.1: Plain UTF-16LE characters are concatenated into the paragraph text string.  
- AC-5.3.2: Paragraph breaks (0x000D) start a new paragraph node.  
- AC-5.3.3: Tab (0x0009) is represented as `\t` in the extracted text.  
- AC-5.3.4: Line breaks (0x000A) are represented as `\n`.  
- AC-5.3.5: Inline controls advance the byte cursor by 16 bytes total (2 for the char + 14 payload/padding) without emitting text.

---

## 6. Document structure model

### REQ-6.1 — Section list
**The app shall** locate all `BodyText/Section0`, `BodyText/Section1`, … streams by scanning the `BodyText` storage directory entry and sorting by numeric suffix.

*Acceptance criteria*  
- AC-6.1.1: Sections are ordered 0, 1, 2… regardless of directory entry order.  
- AC-6.1.2: A document with no `BodyText` storage produces error `ERR_NO_BODY`.

### REQ-6.2 — Section and paragraph nodes
**The app shall** build a tree:

```
Document
  Section[]
    Paragraph[]
      text: string
      inlineControls: InlineControl[]
      table?: Table
```

*Acceptance criteria*  
- AC-6.2.1: Every `HWPTAG_PARA_HEADER` (0x34) starts a new paragraph node in the current section.  
- AC-6.2.2: `HWPTAG_PARA_TEXT` payload is attached to the most recently opened paragraph.  
- AC-6.2.3: Each paragraph exposes `{ index, text, hasTable, hasInlineObject }` at minimum.

### REQ-6.3 — Table extraction (HWPTAG_TABLE, 0x4A)
**The app shall** decode table records:
- `HWPTAG_TABLE` (0x4A): read `rowCount` (uint16 at offset 4) and `colCount` (uint16 at offset 6).
- Subsequent `HWPTAG_CELL` (0x4D) records each carry `row`, `col`, `rowSpan`, `colSpan` and contain nested paragraphs via child `HWPTAG_PARA_*` records.

*Acceptance criteria*  
- AC-6.3.1: Table cell text is extracted the same way as body paragraph text.  
- AC-6.3.2: Merged cells (rowSpan/colSpan > 1) are recorded in the model with their span values.  
- AC-6.3.3: A table is attached to the paragraph node where it appears.

### REQ-6.4 — Preview text
**When** the `PrvText` stream is present,  
**the app shall** decode it as UTF-16LE and expose it as `document.previewText`.

*Acceptance criteria*  
- AC-6.4.1: Preview text is used as a fast-path summary before full body decode.  
- AC-6.4.2: Absence of `PrvText` does not produce an error.

### REQ-6.5 — DocInfo stream
**The app shall** parse the `DocInfo` stream record list and expose at minimum `idMappings` (tag 0x11) counts as `document.docInfo.idMappings`.

*Acceptance criteria*  
- AC-6.5.1: The record list is decoded using the standard 4-byte record header.  
- AC-6.5.2: Unrecognised tags in `DocInfo` are skipped without error.

---

## 7. Error taxonomy

**The app shall** define and throw typed errors with the following codes; each error carries a human-readable message in Korean and English:

| Code | Trigger |
|---|---|
| `ERR_NOT_CFB` | File signature is not OLE2 |
| `ERR_CFB_VERSION` | CFB major version ≠ 3 or 4 |
| `ERR_CFB_CORRUPT` | FAT cycle, out-of-range sector, truncated directory |
| `ERR_STREAM_NOT_FOUND` | Named stream absent from directory |
| `ERR_NOT_HWP` | FileHeader signature mismatch |
| `ERR_HWP_VERSION` | HWP major version ≠ 5 |
| `ERR_ENCRYPTED` | Encrypted flag set |
| `ERR_DISTRIBUTION` | Distribution-document flag set |
| `ERR_DECOMPRESS_FAILED` | DEFLATE stream corrupt |
| `ERR_RECORD_OVERRUN` | Record payload extends beyond stream |
| `ERR_NO_BODY` | No BodyText storage in directory |

*Acceptance criteria*  
- AC-7.1: Every thrown error is an instance of `HwpError` with `.code` and `.message` properties.  
- AC-7.2: Encrypted and distribution-document errors are shown to the user immediately without attempting further decode.  
- AC-7.3: All other errors display the error code and message prominently; the UI does not show a blank or partial document.

---

## 8. Render layer

### REQ-8.1 — Document tree panel
**The app shall** render a sidebar tree showing:
- Sections (numbered)
- Paragraphs per section (truncated label from first 40 chars of text)
- Tables (labelled with row × col)

*Acceptance criteria*  
- AC-8.1.1: Clicking a section or paragraph scrolls the main view to that element.  
- AC-8.1.2: Tree renders within 500 ms for a 500-paragraph document.

### REQ-8.2 — Text view
**The app shall** render extracted paragraph text in reading order with visual separation between sections.

*Acceptance criteria*  
- AC-8.2.1: Paragraph text is HTML-escaped before insertion.  
- AC-8.2.2: Tables are rendered as `<table>` elements with `<tr>/<td>` structure.  
- AC-8.2.3: Images are listed as "[이미지 / image: BIN####]" placeholders, not decoded.

### REQ-8.3 — Structure inspector panel
**The app shall** expose a collapsible "구조 검사기 / Structure Inspector" panel showing:
- CFB sector map: sector count, sector size, FAT sector IDs, directory sector ID.
- Stream list: name, size in bytes, start sector, mini-stream flag.
- Record list for the selected stream: tag ID (hex + symbolic name), level, size, first 16 payload bytes (hex).

*Acceptance criteria*  
- AC-8.3.1: The inspector updates when the user clicks a stream name.  
- AC-8.3.2: All values are shown in hexadecimal where the format specifies hex (sector IDs, tag IDs, raw bytes) and in decimal where the format specifies decimal (counts, sizes in bytes).

### REQ-8.4 — JSON export
**When** the user clicks "JSON 내보내기 / Export JSON",  
**the app shall** serialize the document model (sections, paragraphs, tables, text, metadata) as pretty-printed JSON and trigger a browser download.

*Acceptance criteria*  
- AC-8.4.1: The downloaded filename is `<original-filename>.json`.  
- AC-8.4.2: The JSON is valid and passes `JSON.parse` without error.  
- AC-8.4.3: `Uint8Array` and `ArrayBuffer` fields are omitted or converted to hex strings to keep the output readable.

### REQ-8.5 — HTML export
**When** the user clicks "HTML 내보내기 / Export HTML",  
**the app shall** produce a self-contained HTML file with the rendered document content and trigger a browser download.

*Acceptance criteria*  
- AC-8.5.1: The exported HTML is valid and renders in a browser without external dependencies.  
- AC-8.5.2: The downloaded filename is `<original-filename>.html`.

---

## 9. Bilingual UI

### REQ-9.1 — Korean primary, English secondary
**All** UI strings shall appear as "한국어 / English" or Korean alone for primary actions; English translations appear as subtitles or tooltips.

*Acceptance criteria*  
- AC-9.1.1: The page `<title>` is "HWP 뷰어".  
- AC-9.1.2: Error messages include both Korean and English text.  
- AC-9.1.3: No hard-coded English-only strings appear in visible UI elements.

---

## 10. Non-functional requirements

### REQ-10.1 — Zero build step
**The app shall** run directly from `index.html` via `file://` or static hosting using native ES modules.

*Acceptance criteria*  
- AC-10.1.1: No `node_modules`, bundler config, or build script is required to open the app.  
- AC-10.1.2: `<script type="module">` is used throughout.

### REQ-10.2 — Privacy
**The app shall** make no network requests while parsing or rendering a document.

*Acceptance criteria*  
- AC-10.2.1: Browser DevTools Network panel shows zero requests after the initial page load.

### REQ-10.3 — Mobile support
**The app shall** be usable on a mobile browser (iOS Safari 16+, Android Chrome 110+).

*Acceptance criteria*  
- AC-10.3.1: Viewport meta tag is present.  
- AC-10.3.2: Touch targets are at minimum 44 × 44 CSS pixels.  
- AC-10.3.3: `DecompressionStream('deflate-raw')` availability is checked at runtime.

### REQ-10.4 — Accessibility
**The app shall** meet WCAG 2.1 Level AA for interactive elements.

*Acceptance criteria*  
- AC-10.4.1: Drag-and-drop zone has `role="button"` and keyboard activation via `Enter`/`Space`.  
- AC-10.4.2: Error messages are announced by `role="alert"`.  
- AC-10.4.3: Colour contrast ratio ≥ 4.5:1 for all text.
