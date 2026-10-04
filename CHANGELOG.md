# Changelog

All notable changes to Logline are documented in this file.

## Unreleased

- Split **Docker Compose** (`api-1  | …`) and `kubectl logs --prefix` (`[pod/…/…] …`) output by its container prefix, so JSON and logfmt payloads keep their level and fields and each service becomes its own source. Stack traces are joined per container, Docker timestamps are used when the payload has none, and the container name is kept as a searchable `container` field. Works for commands, captured terminals, followed files, and imports. **Logline: Follow Docker Compose Project** tails a compose file in the workspace. Controlled by `logline.containerPrefixes`.
- Add **log breakpoints**. **Break when this logs again** on an expanded event puts a debugger breakpoint on the statement that logged it. **More actions → Break on matching logs** does the same for every statement that logged a match of the current filter, and pauses a debug session right after it logs another match that Logline cannot map to code. **Logline: Manage Log Breakpoints** and a status bar item list and remove them.
- Add **log doctor**: the Problems panel reports log statements that logged secrets (tokens, keys, credential fields) or personal data (email addresses, card numbers), errors logged in a catch block without the caught exception, statements that produce most of the log volume, and values formatted into message text. Evidence is masked. Quick fixes lower a level, pass the exception, add a `logline-ignore` comment, or hand the statement to Copilot, and **Logline: Show Log Health** writes a Markdown summary. Controlled by `logline.logDoctor`.
- Add a **Traces** list to the Logs toolbar with recent requests from spans and from logs with a trace id, their services, duration, and errors; choosing one opens its waterfall, which can return to the list. Rows that belong to a trace get a trace button, and a chip shows where the OpenTelemetry receiver listens.
- Add a [Docker Compose sample](samples/compose-demo.log) and a small [checkout demo app](samples/README.md) that sends logs and traces, and refresh the demo.
- Remove the roadmap documents; the features they proposed are implemented.
- Capture Debug Console output from **debug sessions** (F5) for every debugger; configurations that print to the integrated terminal are covered by terminal capture. Each launch configuration is a source and each session a run that can be stopped from the Runs tab. Code locations reported by the debugger link events to their log statement. Controlled by `logline.captureDebugSessions`.
- Add a local **OpenTelemetry receiver** (OTLP/HTTP, JSON and protobuf, gzip/deflate) on `127.0.0.1:4318`, started from **More actions** or **Logline: Start OpenTelemetry Receiver**. Log records become events from an **OTel ·** source per service, and trace roots and incoming requests appear as rows with their duration. While it runs, Logline servers and tasks, debug sessions, and new terminals get standard `OTEL_*` variables unless you already configured an exporter. Start and Stop apply to the current window; `logline.otlp.enabled` starts it automatically.
- Add **Show trace** for events with a trace id: a waterfall of spans across services with errors, the critical path, and the trace's logs, including plain JSON logs that carry the same trace id. The new `logline_get_trace` Copilot tool returns the same view for shared sources, redacted.
- Add **live log lenses**: logging calls in workspace source files show a CodeLens with hits, errors, and recency, plus a hover with recent messages, and can be marked in the gutter when they logged errors. Click the CodeLens to filter Logs. Expanded events offer **Open log statement**, and **Logline: Show Log Statements That Have Not Logged** lists statements in the active file that have not logged. Controlled by `logline.logLenses`. Messages can be concatenated, wrapped in format calls, or follow a context argument, and files that events report are indexed on demand beyond `logline.logLensMaxFiles`.
- Add **Logline: Follow Log File** to tail local files like `tail -F`: shows the end of existing content, then new lines, and keeps following through truncation, in-place rewrites, rotation, and files created later. Each file is its own source with an inline **Stop** action.
- Parse plain-text logfmt lines (`level=warn msg="slow query" durationMs=212`) into structured events with level, message, timestamp, and searchable fields.
- Join plain-text Java, Node, and Python stack traces into one event, so exception details, source links, and error grouping work for text logs. Controlled by `logline.joinStackTraces`.
- Speed up sorted views while logs stream, sorting in general, and repeated value autocomplete.
- Keep log lenses responsive: attributing a message to a log statement no longer backtracks (a crafted 512-character message took close to a minute), indexing minified single-line files is linear, and open editors larger than 512 KB are skipped like files on disk.
- The OpenTelemetry receiver no longer fails a request over a timestamp outside the range a date can hold, and a crashed decoder worker only fails its own requests. Debug launches keep an exporter configured in their `envFile` (or a Python workspace `.env`) instead of overriding it.
- Copilot trace results redact source labels and span event names, and sharing selected OpenTelemetry runs shares only those runs' spans. Debug output lines split across output events keep the location where they started.
- `logline.persistLogs` writes a `.gitignore` into `.logline/` so persisted, unredacted logs are not committed by accident.

## 1.9.1 — 2026-09-17

- Refresh the demo with a short walkthrough of live capture, source and run scoping, stopping an active run, filtering, and event inspection.

## 1.9.0 — 2026-09-17

- Register already-open terminals for future capture, clean up empty completed terminal metadata as retained events disappear, and clarify that commands already in progress cannot be backfilled.
- Replace the command-run selector with an accessible dropdown that provides one-click stopping for individual Logline-owned processes and VS Code tasks. Externally captured terminal commands remain visible but observe-only.
- Combine source and run filtering into one accessible dropdown with Sources and Runs tabs.
- Clarify the terminal capture toggle with explicit On, Off, Capturing…, and Needs attention labels.

## 1.8.0 — 2026-09-15

- Capture new commands from supported VS Code shell-integrated terminals after enabling **Capture**, with incremental ANSI normalization, progress-line handling, conservative plain-text severity detection, source/run filtering, and an **Unclassified** level.
- Add **Share logs with agent** with a first-time confirmation, sharing of retained sources and new runs, a visible **Sharing logs · Stop** control, optional specific-run selection in More actions, and exact-run sharing from an expanded event. Five read-only Copilot tools support source listing, bounded search, event inspection, analysis, and waiting for fresh logs. Results respect the sharing scope and are always redacted; sharing is in-memory and revocable.
- Add an editable **Ask Copilot** investigation handoff and keep Markdown export as a fallback when Copilot chat is unavailable.

## 1.7.1 — 2026-09-15

- Refresh the README with a quick start, current feature map, search examples, configuration guidance, and a demo GIF.
- Add a detailed usage reference for import/export behavior, tasks, formats, and retention.

## 1.7.0 — 2026-09-14

- Add a visual Logline Guide with a responsive Quick reference tab, accessible tabs, keyboard navigation, and curated What’s New release cards.
- Add compact visual previews for capture, search, inspection, analysis, sharing, and retention while keeping the existing feature cards and links.
- Make applied filters editable as removable chips and add keyboard-friendly cell Include/Exclude actions that preserve OR branches and active scope.
- Keep table focus, Live/Browse state, inspection, columns, and analysis context stable while snapshots and layout updates arrive.
- Keep guide links keyboard-friendly, focus release destinations, acknowledge updates only after What’s New is shown, and preserve offline operation.
- Align guide copy with the actual command palette and saved-search controls, including the full task-conversion command and delete action.

## 1.6.0 — 2026-09-14

- Keep the server selector width stable as session status labels change; keep toolbar and search actions on one row and allow narrow panels to scroll horizontally.
- Stream full exports with cancellable progress and staged local writes; cap CSV at 200 payload columns and whole-file provider exports at 16 MiB.
- Normalize configuration ranges and types before capture, require integer count/timer settings, and validate saved server entries before auto-start.
- Apply explicit filters, paging, sorting, and column selection while inspecting an event by returning to Browse; continue ignoring live row updates while inspection stays open.
- Preserve the query prefix in autocomplete, escape suggested values, ignore stale input/server responses, and use server indexes for value suggestions.
- Generate scoped task identities and resolve dependencies against the latest run in the same workspace folder, including converted labels.
- Target the selected server when names are duplicated, validate persisted saved searches, and reuse default text-redaction patterns.

- Limit Copy results and AI exports before cloning/redaction by reusing indexed paging; read export settings once per selection.
- Include flattened fields and dependency strings in estimated retention memory. Wide events may now be evicted sooner under the same budget.
- Preserve regex case, uppercase escapes, and flags; support numeric `id` and `timestampMs` queries.
- Handle non-primitive log metadata without interrupting ingestion and preserve payload fields named like JavaScript prototype properties.
- Replace deeply nested JSON with the redaction marker if structured redaction cannot complete, preventing a fallback to unredacted JSON text.
- Count and report failed persistence batches while allowing later writes to continue.
- Save level-only searches and distinguish otherwise identical searches with different level filters.
- Discover tasks across workspace folders, preserve their scope, and retain literal argument mode for an explicit empty argument array.
- Refuse task conversion into malformed or concurrently changed files; preserve multiple trailing JSONC comments during insertion.
- Allow structured columns after plain startup output and include fields from all case variants of a selected server ID.
- Correct import/export, saved-search, memory, and process-control documentation; add a reproducible benchmark and prioritized code review.

## 1.5.0 — 2026-09-09

- Fix Live following after layout changes and resume, avoid losing updates while a snapshot is in flight, and switch sorting to Browse until Live is explicitly resumed.
- Preserve expanded details and their scroll position across virtual-table updates; restore focus without scrolling and keep preview rows at a consistent height.
- Offer custom retained payload fields in Columns, scope automatic choices to the selected server, and recognize ECS, Pino HTTP, and individual OpenTelemetry log-record fields.

- Drain excluded stdout/stderr pipes so single-stream capture cannot block the server.
- Reuse string collators and cache sorted pages while their data and filters remain unchanged.
- Compute timestamp bounds without spreading the retained set into function arguments, fixing Analyze and patterns with large retention settings.
- Release field-name indexes and cached event references on eviction; bound the disk-write queue to 8 MiB and report skipped writes when the disk falls behind.
- Stream local JSON, JSONL, CSV and plain-text imports, yield between batches, preserve raw JSON without a parse/serialize/parse cycle, and truncate oversized records at the configured line-length limit.
- Count extracted fields directly and apply the 120-field limit to nested aliases and MDC fields together.

## 1.4.0 — 2026-09-08

**Performance**

- Re-running a filter no longer rescans the whole retained set. Because events only ever arrive at one end of the ring and are evicted from the other, a repeated query now tests just the events that arrived since the last refresh — a filtered view of 100k events costs ~0.2 ms per refresh instead of ~23 ms, so live tailing with a search active no longer stalls the extension host twice a second.
- Match free-text terms with a case-insensitive regex per field instead of lower-casing a joined copy of level, message, and raw for every event, cutting a cold search over 100k events from ~23 ms to ~7 ms.
- Send only the field columns a row actually displays to the webview, halving the per-refresh payload (665 KiB → 353 KiB on wide structured logs).
- Stop cloning every matching event (and its field map) for facets and analysis, which only ever read them.
- Skip parsing structured events that carry no exception-shaped key when grouping errors, and skip the normalization passes that cannot match a given message. Analysis of 100k events drops from ~167 ms to ~123 ms and facets from ~16 ms to ~3.5 ms.
- Answer field-name autocomplete from the indexes maintained during ingest rather than scanning retained events on each keystroke (~6.6 ms → ~0.02 ms), and keep suggestions scoped to the selected server.

**Import**

- Import CSV files alongside JSON, JSONL, and plain text. A Logline CSV export round-trips exactly through its `raw` column, and a CSV from anywhere else becomes an event built from its own headers.

**Quality**

- Add regression coverage for the incremental match cache (counts and pages stay identical to a cold scan across ingestion, eviction, filter switches, and paging), relative-time queries bypassing that cache, per-server field suggestions, the exception pre-test, and CSV import parsing.

## 1.3.0 — 2026-09-08

**Task integration**

- Capture VS Code shell, process, `node-terminal`, and `launch.json` pre-launch task lifecycle events, dependency metadata, process ids, and exit reasons.
- Convert existing executable tasks into Logline `CustomExecution` tasks, including supported `dependsOn` chains and VS Code variable resolution.
- Add task-level `shell`, `jsonOnly`, and stable task metadata options.

**Search and analysis**

- Add saved searches, field/value autocomplete, and value facets.
- Sort retained events by any captured field.
- Rearrange and resize table columns with persisted drag-and-drop layout state.
- Sort directly from table headers; remove the separate sort controls.
- Show drag grips and remove controls for payload columns, with a Fields menu to restore hidden fields.
- Give search its own row with separate saved-search, value-filter, column, and analysis controls.
- Initialize sorting and resizing for plain logs, apply widths to the actual table columns, and keep widths attached to fields when reordered. Separate sort buttons from drag grips and resize handles; sort Source by its displayed stream.
- Add normalized error grouping and rate/error/latency/status-code charts.
- Cluster all retained events (any level) into the top 10 log patterns by volume with a trend, flag statistically anomalous rate/error/latency buckets, and group errors by exception type and originating stack frame instead of raw message text.
- Redact camelCase secret assignments in free-text messages and keep context from crossing events with unknown session boundaries.

**Interface**

- Restyle the search row's filter and tool buttons (levels, saved searches, filter-by-value, columns, analyze) as quiet, borderless controls that pick up a background only on hover or when open, so they read as one light strip instead of a wall of boxes next to the primary Run/Live actions; group them with subtle dividers instead.
- Hide table-header drag grips, sort arrows, and column-remove controls until the header is hovered or focused, cutting the per-column icon clutter.
- Fix a popover (e.g. Columns) growing past the bottom of a short, docked panel and forcing the whole page to scroll horizontally — panels now flip above their trigger and cap their own height when there isn't room below.
- Fix saved-search and filter-by-value list items rendering in the button-foreground color instead of the theme's normal text color.
- Let non-message columns shrink (down to the same floor manual resizing enforces) when the table doesn't fit, instead of only the Message column ever reacting to added or removed columns while the rest forced a horizontal scrollbar.

**Quality**

- Add test coverage for the task-to-Logline JSONC writer (`appendTasksToJsonc`), saved-search dedup/eviction, the new task/query fields, per-session and time-range log retrieval, field/value autocomplete, and the facets and autocomplete rendering in the webview.

## 1.2.0 — 2026-09-07

**Debugging**

- Show structured exception stacks with readable line breaks, nested causes, and workspace source links, while keeping the original event available.
- Add a surrounding-context view with up to 25 events before and after an event across levels and captured streams in the same server session, preserving the search view.
- Keep context from crossing imported-file boundaries and account for expanded details when virtualizing rows.
- Parse array-shaped stack trace fields (used by some structured loggers), not just newline-joined strings.

**Sessions and sharing**

- Track session lifecycle and active counts per server in the Logs selector.
- Export the current server, search, and level filters as redacted JSON Lines, JSON, or CSV.
- Combine standard and AI exports under one Export button with a format picker.
- Import JSON/JSONL logs for offline searching and create bounded redacted Markdown context for AI tools.
- Add configurable export redaction fields and replacement text.
- Fix CSV export silently losing a log field's value when its name collided with a reserved column (e.g. a custom `sessionId` field); field columns are now unambiguously prefixed.

## 1.1.0 — 2026-09-06

**Performance**

- Selecting a server no longer falls back to a full scan of retained events — a per-server index keeps it as fast as the unfiltered view even at 100k+ events.
- The Logs panel now updates when data actually changes, pushed from the extension and coalesced, instead of polling on a fixed interval.
- The table only renders the rows scrolled into view (virtualized), so a refresh no longer rebuilds all 1,000 DOM rows on a page.
- Query regexes compile once per search instead of once per event; timestamp formatting is cached; row clicks use one delegated listener instead of one per row.
- Plain-text log lines skip the `JSON.parse` attempt entirely instead of relying on a failed parse.
- Persisting logs to disk no longer blocks the extension host — writes happen off the main thread and are serialized so nothing is dropped.
- Lowered default retention (`maxEvents` 100,000 → 50,000) and refresh coalescing window (`refreshIntervalMs` 250ms → 500ms) to reduce memory and CPU headroom by default; both remain configurable.

**Compatibility**

- Reads Log4j2 JsonLayout's `timeMillis` as the event timestamp, and flattens MDC values nested under `contextMap` into searchable fields.
- New per-server `jsonOnly` option discards non-JSON lines, for commands (like `gradle bootRun`) that interleave build-tool output with the application's structured logs.
- Stopping a server on Windows now terminates its whole process tree (`taskkill /T`), rather than only the immediate process — Gradle/Java child processes and the ports they hold no longer linger.
- Task arguments (`args` in a `.vscode/tasks.json` entry) are passed to the process as literal argv, not joined into a shell string, so an argument containing spaces or quotes no longer breaks.
- `.vscode/tasks.json` is now read as JSONC — comments and trailing commas no longer make Logline's task discovery silently fail.
- Fixed a Logline task never signaling completion to VS Code's task system, so it showed "Executing task" indefinitely even after the process had exited.

**UI**

- The level filter is now a multi-select (any combination of levels, not just "at least X"), with a summary label like "Error only" or "3 levels".
- A search-syntax reference (ⓘ next to the search box) documents field filters, aliases, wildcards, numeric ranges, regex, and time-range queries.
- Fixed the toolbar and table layout squishing and wrapping oddly in a narrow panel.

**Internal**

- Migrated the extension host and its supporting modules to TypeScript (`src/`, compiled to `out/`). The webview's `viewer.js` remains plain JS.

## 1.0.0 — 2026-09-06

First release.

- Live tail for long-running server processes, in a bottom-panel **Logs** tab beside Terminal.
- Streams stdout and stderr from saved servers or from VS Code tasks of type `logline`. Several servers can run at once, and the dropdown filters the view by server.
- Parses JSON log lines into columns, auto-detecting common fields such as `service`, `method`, `path`, `status` and `durationMs`, while preserving plain-text output like framework startup banners.
- Datadog-style search: field filters, quoted phrases, negation and OR, wildcards, numeric comparisons and ranges, field presence, regex, and relative or absolute time ranges. Field names match as typed and fall back to common aliases.
- Level filters, expandable per-event detail with **Copy event**, and timestamps in local time or UTC.
- Bounded retention by event count and estimated memory, with live counters in the footer. `maxEvents` and `maxMemoryMb` apply immediately, without reloading the window.
- Optional persistence to `.logline/latest.log`, rolling over to `latest.log.1` at the configured size.
- Running server commands requires a trusted workspace; the extension is disabled in restricted mode and in virtual workspaces.
