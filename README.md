# HWP Viewer

[한국어 설명 (README.ko.md)](./README.ko.md)

**Korean HWP 5.0 documents, opened in the browser. Nothing installed, nothing uploaded.**

A static web app that parses Korean HWP 5.0 binary documents directly in the browser: the OLE2/CFB container and the HWP record streams are decoded in JavaScript, on the user's device. There is no server and no upload.

Live: **https://qkrrkdhzdl-arch.github.io/hwp-reader/**

> Kiroween 2026, *Resurrection* track. Built with Kiro (specs, steering and hooks live in `.kiro/`).

---

## Why

Korean public institutions, schools and companies still ask for applications and notices as `.hwp` (HWP 5.0, a 1996 format). Browsers cannot read it: the format keeps its own record streams inside an OLE2 compound-file container, so the file arrives as something that simply does not open. Users install a proprietary viewer or convert to PDF and lose the tables and paragraph structure. On a phone, an attached `.hwp` is a dead end.

This project brings the format back with web standards only. The file never leaves the device.

## Usage

1. Open `index.html` in a browser. The GitHub Pages URL and a local `file://` copy both work.
2. Drop a `.hwp` file on the page, or press "Choose file".
3. The document tree, the text view (paragraphs and tables) and the structure inspector (CFB sectors, streams, records) appear.
4. "Export JSON" and "Export HTML" save the parsed structure.

The interface is in Korean and English: it opens in the browser's language, and the KR/EN switch in the header changes it.

## What it actually parses

| Stage | What is handled |
| --- | --- |
| CFB (OLE2) | Header and sector sizes, FAT/DIFAT, mini-FAT and the mini stream, directory entries (UTF-16LE names, tree links), stream reads |
| FileHeader | 32-byte `HWP Document File` signature, version (5.x), flags (compressed, encrypted, distribution, DRM, script) |
| Compression | HWP stores streams as raw DEFLATE, sometimes several members concatenated in one stream, so members are inflated one by one and joined (pure-JS inflate, reporting bytes consumed) |
| Records | 4-byte header (tagId 10 bits / level 10 bits / size 12 bits, with extended size), the real HWPTAG values (0x10–0x60) |
| Body | `PARA_HEADER` → `PARA_TEXT` (UTF-16LE), control characters (0x0D paragraph, 0x0A line break, 0x09 tab, 0x1F fixed-width space, 12-byte payloads of block controls) |
| Tables | `CTRL_HEADER` ("tbl ") → `TABLE` (rows/columns) → `LIST_HEADER` (cells, row-major) → cell paragraphs |
| Preview | The `PrvText` stream, the preview text Hangul itself writes |

**Honest failure.** The app does not pretend to succeed. Each of these cases shows a clear code and a message: `ERR_NOT_CFB`, `ERR_NOT_HWP`, `ERR_HWP_VERSION`, `ERR_ENCRYPTED` (password-protected), `ERR_DISTRIBUTION` (distribution/DRM), `ERR_DECOMPRESS_FAILED`, `ERR_RECORD_OVERRUN`, `ERR_NO_BODY`, `ERR_STREAM_NOT_FOUND`, `ERR_CFB_CORRUPT`.

## Not supported, on purpose

- Editing or saving. It is a reader.
- Pixel-level typesetting. Fonts, margins and page breaks are not reproduced; content and structure are.
- Decoding images inside a document. They are shown as references.
- HWPX (OWPML) and HWP 3.0 or earlier. These are different formats, and the app says so.

## Layout

```
index.html            page shell (drop zone, toolbar, error banner, inspector)
styles/app.css        layout and theme
src/cfb.js            CFB (OLE2) container parser, HwpError / ERR_* codes
src/inflate.js        pure-JS raw DEFLATE (stored/fixed/dynamic), reports bytes consumed
src/records.js        record decoder, HWPTAG constants, PARA_TEXT interpretation
src/hwp.js            FileHeader, stream decompression, section and table parser, buildDocument
src/render.js         document tree, text view, structure inspector, exports
src/i18n.js           Korean and English copy, language detection, KR/EN switch
src/app.js            wiring, error display, large-file guard
tests/                node:test unit tests and fixtures (generated HWP)
.kiro/                Kiro specs, steering and hooks
```

## Tests

```bash
node --test tests/*.test.js     # Node 20+, no external dependencies
```

- 65 tests: CFB round trip and cyclic FAT, inflate, FileHeader, record framing, paragraph text, tables, error classification, the golden document.
- `tests/fixtures/build-hwp.mjs` generates a minimal HWP 5.0 file itself, which doubles as a reading of the format. Its output, `sample.hwp`, is the input for the golden test.

**Checked against real documents.** Of 66 HWP 5.0 files actually distributed in Korea (notices, application forms, résumés, consent forms), 64 parsed; the average character agreement with each file's own `PrvText` preview was 0.925. The two failures were HTML or ZIP files carrying a `.hwp` extension, and the app reported them correctly as not HWP 5.0.

## Built with Kiro

`.kiro/specs/hwp-reader/` holds requirements, design and tasks. `.kiro/steering/` holds product, tech and structure rules. `.kiro/hooks/` runs the tests on save and reminds about the task list.

## License

MIT. See [LICENSE](LICENSE).
