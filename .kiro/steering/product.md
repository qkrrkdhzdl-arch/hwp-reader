# Product Principles

## Mission
Revive a dead format with web standards. HWP 5.0 documents are locked inside a binary format that most of the world cannot read. This project makes them readable in any modern browser — no install, no server, no account.

## The file never leaves the device
Parsing happens entirely inside the browser using the File API. No bytes are sent to a server at any point. `fetch` and `XMLHttpRequest` must never be called on user-supplied file data. This is not a performance choice; it is a trust promise to the user.

Corollary: the app must work from `file://` without a local server. Any regression that requires a server origin to function is a product defect.

## Honest failure over fake success
When parsing encounters an encrypted document, an unsupported version, a corrupt stream, or a format feature the app does not implement, it must surface a clear, bilingual error and stop. Showing a blank document, silently swallowing an exception, or rendering partial output without labelling it partial are all worse than showing an error.

Error messages must name the problem in both Korean and English and reference the `ERR_*` code so users can report issues precisely.

## Korean-first UI with English fallback
All user-visible strings are written Korean-first. English appears alongside as a subtitle, tooltip, or parenthetical — never as a replacement. The page title is "HWP 뷰어". Primary action labels follow the pattern "한국어 / English". Error messages follow the same pattern.

Do not add English-only strings to visible UI elements. Developer-facing messages (console warnings, test output) may be English-only.

## Who this is for
Anyone who has received a `.hwp` file and cannot open it — a government attachment, a school assignment, an archived letter. They are not developers. The app must work by dragging a file onto the page; nothing else should be required.
