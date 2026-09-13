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

`extension.ts` constructs `LogsController`, registers commands/tasks/the view, and delegates shutdown. `LogsController` wires services together; it does not implement feature algorithms. `LogsProvider` only loads the HTML and connects the view to messages and notifications.

`ProcessRunner` owns child processes and stop escalation timers. `TaskLifecycle` tracks VS Code task executions. Both use `SessionRegistry` for session metadata and `Ingestion` for event IDs and retained events. Imports use the same ingestion sequence, with a new session boundary per file. Live output preserves its physical text on disk; imported events are not persisted again.

Shutdown stops tasks and processes, waits for child streams to close (including their final partial lines), then flushes accepted disk writes. Notifications stop at the beginning of shutdown. `LogsController.dispose()` is idempotent.

`LogStore` keeps the retention ring, per-server indexes, field reference counts, and query caches together because they must invalidate atomically when events change. Stream framing and independent ordering helpers live outside it. Existing bounded-read and eviction tests protect the optimized paths.

## Viewer and protocol

`ViewerState` owns preferences and interaction transitions such as resume, inspect, and sort. `SnapshotBridge` allows one snapshot request at a time and coalesces updates received while it is pending. Feature controllers take state and explicit callbacks; they do not import each other in cycles. Table DOM caches and layout measurements remain private to the table controller.

`EventScope` releases listeners, observers, and queued rendering when a viewer is disposed. Context inspection owns its snapshot and ignores late responses for closed dialogs or previously selected events.

Add a message to `ViewRequest`/`HostMessage`, validate it in `parseViewRequest`, and dispatch it in `message-router.ts`. Build compact row responses in `snapshot.ts`; full event details are fetched separately. Keep exact server selection separate from the query language's substring matching.

## Builds and tests

- `npm run compile` type-checks and builds host code into `out/`, then bundles `src/webview/main.ts` into `media/viewer.js`. The generated browser file is checked in; edit its TypeScript sources and rebuild it.
- `npm run watch` watches host compilation, browser type checking, and browser bundling.
- `npm run check` checks both runtimes and tests, builds, and runs the test suite.
- `npm test` compiles tests into `out-tests/` and runs only `*.test.js`. Run `npm run compile` first when browser sources have changed.
- `npm run smoke` launches an isolated VS Code development host with temporary settings and a captured task. It requires an installed desktop VS Code CLI; `VSCODE_CLI` can select its path.
- `npm run package` builds a VSIX without source files, build scripts, test code, or test output.

Use direct module tests for core/capture/storage code. Only tests of VS Code adapters need `withVscode`. Viewer tests instantiate the exported controller inside an isolated DOM harness and exercise public APIs, plus the generated browser entry. The harness does not simulate browser layout; use a development host for visual checks of scrolling, resizing, and dialogs.
