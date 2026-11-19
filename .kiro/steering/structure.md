# Repository Structure

## Layout

```
hwp-reader/
├── index.html                  App entry point; no build output ever sits here
├── styles/
│   └── app.css                 All styling; no CSS-in-JS, no inline style attributes
├── src/
│   ├── app.js                  Browser-only. Wires UI events, orchestrates the pipeline.
│   ├── cfb.js                  OLE2 Compound File Binary parser. Exports HwpError.
│   ├── inflate.js              Pure-JS raw DEFLATE decompressor. No imports.
│   ├── hwp.js                  FileHeader parser, decompressor, document model builder.
│   ├── records.js              Record stream decoder, HWPTAG constants, paragraph text decoder.
│   └── render.js               DOM renderer: tree panel, text view, inspector, export.
├── tests/
│   ├── cfb.test.js
│   ├── records.test.js
│   ├── inflate.test.js
│   ├── hwp.test.js
│   └── errors.test.js
│   └── fixtures/
│       ├── sample.hwp          Minimal synthetic HWP 5.0 document (committed binary)
│       └── sample.expected.json  Golden JSON output for the fixture
├── .kiro/
│   ├── specs/hwp-reader/       requirements.md, design.md, tasks.md
│   ├── steering/               product.md, tech.md, structure.md (these files)
│   └── hooks/                  Hook JSON files
└── README.md
```

Temporary scripts (e.g. fixture generators) are deleted before committing. No `node_modules`, `dist`, or `build` directories ever appear.

## Module responsibilities

Each source file owns exactly one concern. Cross-cutting concerns (HwpError) live in the lowest-level module that needs them (`src/cfb.js`) and are re-exported from there; other modules import `HwpError` from `./cfb.js`, not from a separate errors file.

| File | May import from | Must not import from |
|---|---|---|
| `src/inflate.js` | nothing | anything |
| `src/cfb.js` | nothing | src/inflate.js, src/hwp.js, src/records.js, src/render.js, src/app.js |
| `src/records.js` | src/cfb.js (HwpError only) | src/inflate.js, src/hwp.js, src/render.js, src/app.js |
| `src/hwp.js` | src/cfb.js, src/records.js, src/inflate.js | src/render.js, src/app.js |
| `src/render.js` | src/cfb.js, src/records.js, src/hwp.js | src/app.js |
| `src/app.js` | src/* | nothing forbidden |

Circular imports are forbidden.

## Naming conventions

**Files:** lowercase, no hyphens in `src/` (single-word names). Test files mirror the module they test: `cfb.test.js` tests `cfb.js`.

**Exports:** named exports only; no default exports. This keeps imports explicit and grep-friendly.

**Error codes:** `ERR_` prefix, `SCREAMING_SNAKE_CASE`, defined as string constants.

**HWPTAG constants:** `HWPTAG_` prefix, `SCREAMING_SNAKE_CASE`, collected in a frozen object `TAGS` with a derived reverse map `TAG_NAMES`.

**Classes:** PascalCase (`CfbFile`, `DirEntry`, `HwpError`).

**Functions:** camelCase verbs (`parseFileHeader`, `decodeRecords`, `buildDocument`, `renderTree`).

**CSS classes:** `hwp-` prefix for document-content elements (`hwp-section`, `hwp-para`, `hwp-table`). Layout chrome uses plain BEM-style names (`doc-view`, `doc-tree`, `inspector`).

## Tests and fixtures

Tests live in `tests/` and are named `<module>.test.js`. They run with `node --test tests/` and must pass with no browser. Each test file is self-contained: it builds any binary fixtures it needs in memory rather than reading files, with the exception of the golden test in `hwp.test.js` which loads `tests/fixtures/sample.hwp`.

Fixtures in `tests/fixtures/` are committed binary/JSON files. They are never regenerated automatically during a normal test run. To regenerate `sample.expected.json`, run `buildDocument` on `sample.hwp` manually and commit the result.

Do not add snapshot libraries or test frameworks. Use `node:assert` and `node:test` only.

## Commit conventions

Format: `<type>(<scope>): <imperative summary>`

Types: `feat`, `fix`, `test`, `docs`, `style`, `refactor`, `chore`

Scopes map to source files or spec phases: `cfb`, `records`, `inflate`, `hwp`, `render`, `app`, `tests`, `fixtures`, `steering`, `hooks`

Examples:
- `feat(cfb): implement FAT chain reconstruction`
- `test(records): add extended-size header case`
- `fix(hwp): handle missing PrvText stream gracefully`
- `docs(steering): add structure document`

Keep commits atomic: one task from `tasks.md` per commit where practical. Update the checkbox in `tasks.md` in the same commit that completes the task.
