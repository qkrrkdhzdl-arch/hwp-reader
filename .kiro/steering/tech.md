# Technical Standards

## Zero build step
There is no bundler, transpiler, or build script. The app runs directly from `index.html` via `file://` or plain static hosting. `node_modules` must not exist. CI runs `node --test tests/` and that is the entire toolchain.

If a proposed change requires a build step, reconsider the approach.

## ES modules only, no dependencies
Every file uses `export`/`import` syntax. No CommonJS (`require`, `module.exports`). No external packages — not even dev dependencies. Any utility that is needed must be written inside the project.

Imports must use relative paths (`./cfb.js`, not `cfb`). There is no import map.

## Browser-first, Node-testable pure parsers
The parsing modules (`src/cfb.js`, `src/records.js`, `src/hwp.js`, `src/inflate.js`) must have zero DOM dependencies and zero browser-only APIs. They accept `Uint8Array` or `ArrayBuffer` inputs and return plain data structures. This lets the test suite run under `node --test` without a browser.

`src/render.js` and `src/app.js` are explicitly browser-only and are exempt from the Node-testability requirement.

## Every parser module must be side-effect free and accept Uint8Array
A module is side-effect free if importing it changes no global state and executes no I/O. All parser entry points must accept `Uint8Array` as their primary input type. Modules that need an `ArrayBuffer` must accept both and convert internally.

## Error taxonomy: ERR_* codes
All parsing errors are instances of `HwpError` (defined in `src/cfb.js`), constructed as:

```js
new HwpError(code, messageKo, messageEn)
```

The `code` property is one of the defined `ERR_*` string constants listed in the design document. Do not throw plain `Error` objects from parser modules; the caller cannot distinguish error categories without the code.

The full list of codes: `ERR_NOT_CFB`, `ERR_CFB_VERSION`, `ERR_CFB_CORRUPT`, `ERR_STREAM_NOT_FOUND`, `ERR_NOT_HWP`, `ERR_HWP_VERSION`, `ERR_ENCRYPTED`, `ERR_DISTRIBUTION`, `ERR_DECOMPRESS_FAILED`, `ERR_RECORD_OVERRUN`, `ERR_NO_BODY`.

## No innerHTML for document text
Paragraph text, cell text, and any user-supplied content is inserted into the DOM using `textContent` assignment, never `innerHTML`. The only permitted use of `innerHTML` is for static chrome (empty container scaffolding) where the content is a fixed string from the source file, not from a parsed document.

Table structures are built via `insertRow()`/`insertCell()`, not via HTML string templates.

## DataView for binary parsing
Binary fields are read with `DataView` using explicit little-endian flags (`true`). Do not use bitwise operators on values wider than 31 bits (JS sign-extension hazard); read as `Uint32` and use unsigned arithmetic.

## Async only where necessary
`buildDocument` is `async` because decompression uses the Streams API. All other parser functions are synchronous. Do not introduce `async` into `src/cfb.js`, `src/records.js`, or `src/inflate.js`.
