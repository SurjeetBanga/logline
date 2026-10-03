# Code structure

Logline has two runtimes: the VS Code extension host and the browser webview. They exchange typed messages; browser code never imports host implementations at runtime.

| Directory | Responsibility |
| --- | --- |
| `src/core` | Event parsing, queries, retention, ordering, analysis, exceptions, formatting, redaction, and configuration value helpers. No VS Code or DOM dependency. |
| `src/capture` | Process ownership, session records, line framing, shared event IDs and ingestion, and capture status. Host effects enter through narrow interfaces or callbacks. |
| `src/storage` | Bounded disk persistence and saved searches. Settings, workspace location, notifications, and state storage are supplied by the caller. |
| `src/transfer` | Streaming import parsers and export serialization. File dialogs belong to the VS Code adapter. |
| `src/protocol` | Requests, responses, and runtime validation of requests arriving from the webview. |
| `src/vscode` | Editor commands, configuration subscriptions, task conversion/lifecycle, source navigation, file dialogs, message dispatch, snapshot projection, and webview hosting. |
| `src/webview` | Browser state, request coordination, search, analysis, context inspection, row rendering, column sizing, and virtual scrolling. |
| `src/test` | VS Code test adapters and the extension-host smoke entry. Excluded from the extension package. |

## Construction and ownership

`extension.ts` constructs `LogsController`, registers commands/tasks/the view, and delegates shutdown. `LogsController` wires services together; it does not implement feature algorithms. `LogsProvider` only loads the HTML and connects the view to messages and notifications. `GuidePanel` owns one reusable editor webview for the offline guide; its release acknowledgement is stored in `globalState` and is independent of captured logs.

`ProcessRunner` owns child processes and stop escalation timers. `TaskLifecycle` tracks VS Code task executions. Both use `SessionRegistry` for session metadata and `Ingestion` for event IDs and retained events. Imports use the same ingestion sequence, with a new session boundary per file. Live output preserves its physical text on disk; imported events are not persisted again.

Shutdown stops tasks and processes, waits for child streams to close (including their final partial lines), then flushes accepted disk writes. Notifications stop at the beginning of shutdown. `LogsController.dispose()` is idempotent.

`LogStore` keeps the retention ring, per-server indexes, field reference counts, and query caches together because they must invalidate atomically when events change. Stream framing and independent ordering helpers live outside it. Existing bounded-read and eviction tests protect the optimized paths.

`TerminalCapture` observes shell-integrated terminal executions without owning their processes. Each execution has an independent capture lifecycle, so disabling capture or excluding a terminal stops accepting its output without terminating the command. `TerminalNormalizer` removes terminal presentation sequences incrementally, handles redraws, and emits bounded lines before they enter the shared ingestion path. `AgentLogAccess` is the in-memory sharing boundary for Copilot tools, with an all-runs mode that discovers new sources and runs and a selected-runs mode that excludes later runs; it owns grants, cursors, redaction, cancellation, and bounded reads, while the five registered language-model tools remain read-only.

`DebugCapture` observes debug sessions through a `DebugAdapterTracker` registered for every debug type (`vscode/debug-capture.ts`). It frames Debug Adapter Protocol output events per category into lines, joins stack traces, keeps an adapter-reported code location on each event (`LogEvent.location`), and creates a run only on the first output. VS Code owns the session, so stopping a run asks VS Code to stop debugging.

`OtlpReceiver` is a loopback-only OTLP/HTTP server. `core/otlp-proto.ts` decodes protobuf requests into the OTLP/JSON shape, so `core/otlp.ts` normalizes both encodings into bounded log records and spans. `OtlpDecoder` runs that decoding on a worker thread (`capture/otlp-worker.ts`) for bodies over 1 MiB, and the receiver ingests results in chunks of 500 between event-loop turns. The Start/Stop commands override `otlp.enabled` for the window only. Log records (and, per `otlp.showSpans`, spans) become JSON lines on the shared ingestion path, with one source per service. Spans live in `SpanStore`, bounded by count and cleared with the log store; `core/traces.ts` builds the waterfall and critical path. `core/otel-environment.ts` decides which `OTEL_*` variables to add to a process, terminal, or launch configuration without replacing user settings. `OtelIntegration` (`vscode/otel-integration.ts`) owns the receiver's lifecycle from settings and applies those variables to `ProcessRunner`, the terminal environment collection (not persisted, since the port can change), and launch configurations; the controller only delegates to it.

`LogSiteIndex` (`core/log-sites.ts`) holds logging calls extracted from source text (literal messages, concatenations, format wrappers, and messages after a context argument) and attributes an event to one by its reported location or by matching the statement's literal text. Candidates are found through each template's longest word, and results are cached per message. `LogSiteTracker` counts hits from new event ids. `LogLens` is the editor adapter: it indexes files, provides CodeLens, hovers and gutter decorations, and recounts retained events when logs are cleared, the index settles after a change, or events were evicted (at most every 10 seconds). Reported locations that match no indexed file are collected by the index and indexed on demand by `LogLens`. Completed debug and OpenTelemetry runs are dropped from the registry once none of their events are retained.

Retention accounting includes flattened field keys/values and approximate property overhead. It intentionally estimates retained event storage, not process RSS. Eviction must release both indexes and cached references. Field dictionaries may contain names such as `constructor` or `__proto__`; read only own payload properties and preserve these names as data.

Full file exports keep a fixed array of matching event references, then redact/serialize records incrementally into batches of up to 128 parts or about 256 KiB, plus the size of one record. Those references can keep evicted events alive until the export completes. Local writes stage beside the destination and rename only on success; whole-file providers have a 16 MiB output cap. CSV schema discovery stops at 200 payload fields. Clipboard and AI exports reuse the newest page and fetch full records only for those rows; keep redaction after the limit. Persistence catches failures per batch, releases queue accounting, invalidates the cached disk size, and reports affected lines without rejecting later batches.

`Configuration` normalizes settings before returning them, caches normalized values, and clears its cache on refresh. Numeric ranges and integer counts are checked at this boundary. Auto-start uses the same validated configuration. Server management preserves unrelated malformed entries while editing/deleting the selected array entry.

Task identities combine folder URI, task type, and exact name through a stable hash. Explicit IDs remain authoritative. Session records retain folder scope and task labels for dependency resolution; the latest matching run in the same scope determines readiness. This metadata is separate from the event payload.

## Viewer and protocol

`ViewerState` owns preferences and interaction transitions such as resume, inspect, and sort. `SnapshotBridge` allows one snapshot request at a time and coalesces updates received while it is pending. Feature controllers take state and explicit callbacks; they do not import each other in cycles. Table DOM caches and layout measurements remain private to the table controller.

`EventScope` releases listeners, observers, and queued rendering when a viewer is disposed. Context inspection owns its snapshot and ignores late responses for closed dialogs or previously selected events.

Explicit result changes close main-row inspection and enter Browse with a fixed boundary. Notification-driven snapshots continue to respect pause, including responses sent before inspection opened. Autocomplete echoes the input and server identity, rejects stale responses, and produces whole-query replacements with escaped values. Server-specific value suggestions iterate that server's deque instead of scanning the global ring.

Automatic columns lock after the first nonempty detected schema, so plain startup output cannot prevent later JSON columns from appearing. Notifications coalesce ingestion bursts; the visible webview also requests a fallback refresh every five seconds. Hidden views skip snapshot requests. Relative-time queries bypass the incremental match cache because their results can change without ingestion.

Add a message to `ViewRequest`/`HostMessage`, validate it in `parseViewRequest`, and dispatch it in `message-router.ts`. Build compact row responses in `snapshot.ts`; full event details are fetched separately. Keep exact source/run selection separate from the query language's substring matching.

## Builds and tests

- `npm run compile` type-checks and builds host code into `out/`, then bundles `src/webview/main.ts` into `media/viewer.js`. The generated browser file is checked in; edit its TypeScript sources and rebuild it. Guide assets in `media/guide.*` are authored static files and are packaged as-is.
- `npm run watch` watches host compilation, browser type checking, and browser bundling.
- `npm run check` checks both runtimes and tests, builds, and runs the test suite.
- `npm test` compiles tests into `out-tests/` and runs only `*.test.js`. Run `npm run compile` first when browser sources have changed.
- `npm run smoke` launches an isolated VS Code development host with temporary settings and a captured task. It requires an installed desktop VS Code CLI; `VSCODE_CLI` can select its path.
- `npm run benchmark` builds and measures parsing/retention, paging, analysis, and the old versus bounded clipboard selection pipeline on 50,000 synthetic events. It checks identical selected output and reports medians, without machine-dependent timing assertions.
- `npm run package` builds a VSIX without source files, build scripts, test code, or test output.

Use direct module tests for core/capture/storage code. Only tests of VS Code adapters need `withVscode`. Viewer tests instantiate the exported controller inside an isolated DOM harness and exercise public APIs, plus the generated browser entry. The harness does not simulate browser layout; use a development host for visual checks of scrolling, resizing, and dialogs.

Task adapter tests use temporary workspace folders to verify conversion preserves malformed or concurrently edited task files, discovers multiple roots, and retains task scope.
