# Project brief — HWP Reader (Kiroween 2026, Resurrection track)

Read this fully before writing anything. Then produce the spec files requested in the current task.

## One-line product

A **static, offline, no-install web app that opens Korean HWP 5.0 binary documents in the browser** —
parsing the OLE/CFB container and the HWP record streams itself — and presents them as structured,
readable content plus exportable JSON/HTML.

## Why it matters (the "resurrection" angle)

- Korean public institutions, schools, and companies still **require `.hwpb`/`.hwp` (HWP 5.0)** for
  applications, notices, and forms. The format dates to 1996: an OLE2 Compound File Binary container
  with proprietary record streams.
- Browsers cannot read it. Users must install a proprietary viewer, or convert to PDF and lose the
  structure. `.hwp` files pile up as unreadable "dead" attachments — especially on mobile.
- This project revives that dead format with web standards only: **no server, no upload, no install**.
  The file never leaves the user's device.

## Hard requirements

1. **Client-side only.** No network calls for parsing. No telemetry. The app must work from `file://`
   or static hosting.
2. **Real parsing, not a stub.** Implement:
   - CFB (Compound File Binary) reader: header/signature check, sector size, FAT/DIFAT, mini-FAT and
     mini stream, directory entries, stream lookup by name (UTF-16LE names).
   - HWP 5.0 `FileHeader` (256 bytes at stream `FileHeader`): signature `HWP Document File`, version,
     flags (compressed / encrypted / distribution-document).
   - Streams: `DocInfo`, `BodyText/Section0..N`, plus `PrvText` (preview text) when present.
   - HWP record stream decoding: 4-byte record header (tagId 10 bits, level 10 bits, size 12 bits;
     extended size when size == 0xFFF), then payload. HWPTAG_BEGIN = 0x10.
   - Text extraction for `HWPTAG_PARA_TEXT` (67) as UTF-16LE, interpreting control characters
     (0x0D paragraph break, 0x0A line break, 0x09 tab, inline/extended controls 0x00-0x1F with
     their 8/16-byte payloads).
   - Document structure: sections → paragraphs → runs of text, and **tables** (HWPTAG_TABLE 0x4A and
     cell/paragraph records) at least to the level of cell text extraction, plus memo/각주 text if
     cheap to reach.
   - Decompression: HWP compresses streams with **raw DEFLATE** (no zlib header) when the compressed
     flag is set — use `DecompressionStream('deflate-raw')` with a pure-JS inflate fallback.
3. **Honest failure.** Encrypted documents (flag set), distribution documents (`배포용`, DRM), and
   unsupported/corrupt files must produce a clear, specific message — never a silent empty page and
   never a fake success. Distinguish: not-a-CFB, not-HWP (signature mismatch), encrypted,
   distribution, unknown version, corrupt record.
4. **Zero build step.** Plain ES modules + HTML + CSS that run directly in a browser. No bundler, no
   npm install needed to run.
5. **Tests.** `node --test` (node:test) unit tests that run in CI without a browser:
   - CFB layer against a synthetic CFB built in-test,
   - record header parse (tag/level/size incl. extended size),
   - text extraction from a hand-built section stream (UTF-16LE + control chars),
   - inflate-raw path,
   - error classification cases.
   Plus `tests/fixtures/` with at least one real, small, **non-personal** `.hwp` sample (generate a
   synthetic one if needed) and a golden JSON expectation.
6. **Bilingual UI (Korean primary, English secondary)**, drag-and-drop, file picker, document tree,
   text view, table view, JSON/HTML export, and a "structure inspector" panel showing sectors/streams/
   records (this is what makes the demo impressive).
7. **Accessibility & mobile**: works on a phone browser; large-file guard with clear progress.

## Deliberate non-goals

- Editing or saving HWP files.
- Rendering pixel-perfect layout / fonts (we present content and structure, honestly labelled).
- Images inside documents (may be listed but not decoded) — say so in the UI.

## Repository layout (target)

```
.kiro/specs/hwp-reader/{requirements,design,tasks}.md
.kiro/steering/{product,tech,structure}.md
.kiro/hooks/*.json
index.html
src/cfb.js  src/hwp.js  src/records.js  src/render.js  src/app.js  src/inflate.js
styles/app.css
tests/*.test.js
tests/fixtures/...
README.md
```

## Style

- Ship-quality, readable code with comments that explain the *format*, not the syntax.
- Korean-facing product text in Korean; code comments in English.
- Commit in small steps with messages that describe the format work.
