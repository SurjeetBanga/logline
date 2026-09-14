# Code review — 2026-09-14

The existing module boundaries, retention ring, per-server indexes, incremental query cache, streaming imports, and virtual table are a sound basis for simplicity and performance. Keep them. The highest-value changes are to bound expensive work at feature boundaries and close correctness gaps; a framework rewrite or new storage layer would add complexity without addressing the observed problems.

The review covered the core, capture, storage, transfer, VS Code/task adapters, protocol, webview controllers and assets, tests, build/package configuration, and documentation. The changes below add no dependencies.

## Changes made

| Area | Finding and change | Regression coverage |
| --- | --- | --- |
| Bounded exports | Copy results redacted every match before keeping 1,000 rows; AI export cloned every match. Both now reuse paging and fetch/redact full records only for the newest page. Export configuration is read once per selection. | Omitted records have raw getters that fail if accessed; selected IDs, redaction, and total counts are checked. |
| Retention | Byte estimates omitted flattened fields and dependency arrays. Include keys, values, and approximate property/reference overhead. This can retain fewer wide events at the same budget. | Field-only events trigger memory eviction and oversized rejection. |
| Search | Lowercasing regex syntax changed `\D` to `\d` and discarded case semantics. Preserve expressions and inputs; `/i` opts into case-insensitive regex. Add missing numeric metadata access for `id`/`timestampMs`. | Escapes, character classes, flags, ordinary text compatibility, and metadata queries. |
| Parsing | Objects in message/level/timestamp fields could throw during string/date conversion. Ignore unsupported metadata shapes while retaining raw JSON. Payload keys inherited from Object.prototype could disappear or be mistaken for actual fields. | Non-primitive metadata and explicit `constructor`, `toString`, and `__proto__` fields, including snapshot projection. |
| Redaction | Deep JSON could exhaust recursion and fall back to plain-text redaction, leaving quoted JSON credentials intact. Replace the raw payload entirely if structured redaction fails. | A 10,000-level JSON object retains no secret in the export. |
| Persistence | Filesystem errors were silently ignored. Report the first failure, count affected batch lines, reset cached disk size, release queue bytes, and continue later batches. | Failure, repeated-failure warning suppression, and recovery. |
| Saved searches | Level-only searches were discarded; identical text/server combinations overwrote different level selections. Include levels in identity and allow level-only filters. | Distinct level sets, empty selections, and order-independent deduplication. |
| Task files | Conversion could rewrite malformed files or overwrite on-disk changes made during its picker. Reject these cases. Replace fragile trailing-comment matching with token tracking when inserting commas. | Temporary-file tests preserve invalid/changed content; JSONC tests cover multiple trailing comments. |
| Task execution | Discovery used only the first workspace folder, resolution could change scope, and `args: []` reverted to shell mode. Preserve scope and explicit argv mode. | Discovery across two roots, scope resolution, no-folder handling, and empty arguments. |
| Columns | Plain startup lines locked the automatic schema at zero fields. Wait for a useful schema. Server-scoped field lists now include all matching case variants, consistent with row filtering. | Plain output followed by JSON; mixed-case server IDs. |
| Development/docs | `check` repeated every TypeScript compilation. It now runs compile and tests, which together check all three targets once; standalone `typecheck` remains available. Sync lockfile root version with the manifest. Correct stale documentation and add the benchmark below. | Full checks and package verification. |

## Follow-up implementation

The second pass completed these additional items without adding dependencies:

| Area | Change | Verification |
| --- | --- | --- |
| Full exports | Choose destination before scanning; keep a fixed array of event references and redact/write in batches. Stage local output before replacement, support cancellation, cap CSV schema at 200 payload fields, and cap whole-file providers at 16 MiB. | Serialization equality, bounded first-batch reads, snapshot stability after eviction, failure/cancellation preserving existing files, staging cleanup, provider limits, and actual adapter export. |
| Configuration | Clamp numeric ranges, floor integer counts, reject invalid types, normalize server shapes and environment values, and route auto-start through validated settings. | Manifest-aligned boundaries, invalid values, cache refresh, and malformed servers. |
| Paused interactions | Explicit filter/page/sort/column changes close inspection and refresh Browse results at a fixed boundary. Live updates still respect inspection. | Viewer interaction tests and the existing in-flight snapshot regressions. |
| Autocomplete | Preserve preceding query terms, escape literal values, echo input/server identity, reject stale responses, and scan only matching server indexes for values. | Completion parsing, escaped values, unrelated-server reads, stale responses, and complete replacement values. |
| Task identity | Scope new automatic task IDs by folder/type/exact name; preserve explicit IDs. Resolve dependencies against the latest run in the same scope and recognize wrapper labels. | Identity collisions, reruns, cross-folder isolation, and converted dependency labels. |
| Small correctness/performance fixes | Select duplicate server labels by entry, validate/cap loaded searches, share default redaction regexes, and remove unused request state. | Duplicate-label edit/delete and malformed persisted-search tests; full existing redaction suite. |

Autocomplete labels retain the typed prefix when quoting interrupts matching against the replacement value. This follows the [HTML standard's guidance to match both suggestion labels and values](https://html.spec.whatwg.org/multipage/input.html#attr-input-list). Native menu rendering still requires a connected browser for visual verification.

## Measurements

Run `npm run benchmark`. It constructs 50,000 small synthetic structured events, warms each operation, reports the median of five runs, and asserts that the old and bounded clipboard pipelines return identical events. These are local diagnostics, not performance guarantees or CI timing thresholds.

Recorded with Node v26.8.1 on macOS arm64:

| Operation | Time |
| --- | ---: |
| Parse and retain 50,000 events | 88.5 ms total |
| Previous clipboard selection: clone/redact all matches, then limit | 142.42 ms median |
| Bounded clipboard selection: page, then fetch/redact | 2.79 ms median |
| Indexed latest page | 0.02 ms median |
| Cached filtered page | 0.03 ms median |
| Retained analysis | 29.71 ms median |

The bounded clipboard pipeline was about 50× faster on this fixture. Both paths use the current redactor; this compares selection strategies rather than historical checkouts. This comparison excludes clipboard IPC, file I/O, final serialization, and browser rendering. The memory estimator reported 43.5 MiB; that is not measured process RSS. Large messages, complex exceptions, diverse schemas, cold filters, and the Node version embedded in VS Code can produce different results.

## Remaining recommendations, in priority order

1. **Bound arbitrary regex execution.** `src/core/query.ts` executes user regex synchronously against retained text on the extension host. A short pattern can still backtrack for a long time; the 256-character query limit does not bound runtime. Use a terminable worker for regex queries or adopt a restricted regex dialect, with explicit compatibility tests. A timer on the same thread cannot interrupt a running regex. Streaming exports also perform their initial filter scan synchronously; batching does not solve this query-engine issue.

2. **Define shell and cross-folder conversion compatibility.** Scoped IDs and dependency lookups now work for new task sessions. Shell conversion still discards `ShellQuotedString.quoting` and shell executable options; its quoting is not portable to every Windows shell. Cross-folder dependency wrappers also need explicit working-directory and variable-resolution semantics. Prefer argv where semantics permit and test each supported shell. Existing explicit/legacy task IDs are preserved, so users must choose unique IDs when their stored wrappers collide.

3. **Define import fidelity and cancellation.** JSON/JSONL export envelopes currently import as new JSON payloads, and a foreign CSV `raw` column takes precedence over other columns. Introduce explicit envelope/schema recognition before promising round-trip behavior. Add cancellable import progress and define what Clear means during an active import. Keep physical-record limits and streaming framing.

4. **Test operational and UI edges on supported platforms.** The DOM harness cannot verify real layout, pointer capture, native datalist behavior, or accessibility. Add a small browser/desktop smoke matrix for narrow panels, scrolling, resize, keyboard controls, and Windows process-tree termination. Process disposal currently waits indefinitely for child streams to close; test detached descendants and failed termination before choosing a shutdown deadline. Task conversion checks on-disk changes but still needs dirty-editor-buffer support. No browser connection was available in this session.

The five-second visible-view fallback refresh also ages relative-time searches. Preserve that behavior if replacing it with a cheaper idle strategy. Full exports hold their original event references until completion, so live retention can add memory during a long export even though serialization buffers are bounded. Whole-file providers cannot cancel a write already handed to their filesystem API.

## Validation

- Baseline: 168 tests passed before changes.
- Final `npm run check`: host/browser/test type checks and all 201 tests passed. The generated browser bundle was rebuilt from TypeScript.
- Packaging: `npm run package -- --out /tmp/logline-review-1.6.0.vsix` passed (54 files, about 120.5 KB). Archive checks confirmed host/browser runtime assets are included and sources, tests, scripts, dependencies, and this review are excluded.
- Desktop smoke: passed outside the filesystem sandbox using a temporary VS Code profile/workspace; verified activation, command registration, webview focus, task discovery, captured task completion, and stop. The sandboxed attempt failed to produce a test result after an Electron launch error.
- No manual visual layout review or Windows execution was performed. Tests and microbenchmarks do not establish worst-case memory or regex runtime bounds.
