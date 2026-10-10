# Usage reference

[← Back to README](../README.md)

Detailed behavior and settings for Logline. For an interactive quick reference, open **Help** in the Logs toolbar.

## Capture and live tail

Open **Help** in the Logs toolbar for the offline **Logline Guide**. It is a visual quick reference for capture, search, inspection, analysis, sharing, and retention. The **What’s new** tab shows curated highlights for releases you have not viewed; the full version history is available from that tab. The Command Palette also exposes **Logline: Open Guide** and **Logline: What’s New**. The Help button gets a small **New** badge after an update, and the guide never opens by itself.

Run **Logline: Run Command**, or open **Manage servers** in the Logs panel to add, edit, and delete saved commands. Multiple servers can run concurrently; the combined source/run dropdown has **Sources** and **Runs** tabs. The Sources tab filters by server ID, task, terminal, or imported source. The Runs tab separates individual command executions and provides inline **Stop** actions beside active Logline-owned processes or VS Code tasks. **Stop server** stops the selected source; **Stop all** stops every Logline-owned process and task. Externally captured terminal commands are listed as **Capture only** and cannot be stopped by Logline. Running a command requires a trusted workspace.

A saved server can also start automatically when the extension activates by setting `autoStart: true` on it (also requires a trusted workspace). Set `jsonOnly: true` on a server whose command interleaves build-tool output with its own JSON logs (for example `gradle bootRun`) to discard everything that isn't valid JSON.

Turn **Terminal capture: Off** to **Terminal capture: On** in the toolbar (or run **Logline: Enable Terminal Capture**) to observe new commands in supported VS Code terminals. Capture starts at the next shell-integrated command; terminal scrollback from commands that were already running is not recoverable. Terminal output is stored as one `terminal` stream because the shell integration API does not expose stdout and stderr separately. Structured JSON levels remain authoritative; unstructured lines use an explicit leading level marker when present and otherwise appear as **Unclassified**. Capture is local and does not transmit logs by itself. Turn **Terminal capture: On** back to **Terminal capture: Off** at any time without stopping a terminal command.

Run **Logline: Follow Log File** to tail one or more local files, like `tail -F`. Logline shows the last 64 KiB of existing content, starting at a whole line, then every line appended afterwards. Following continues when the file is truncated, rewritten, or rotated (the path names a new file), and a file that does not exist yet is picked up once it is created. Each file appears as its own source; use the inline **Stop** action in the Runs tab, **Stop server**, or **Stop all** to stop following. Plain-text file lines get the same leading-severity detection as terminal output. Followed files are already on disk, so they are not copied to `latest.log`.

Output from **Docker Compose** and **Kubernetes** keeps its structure. Compose prefixes every line with its container (`api-1  | {"level":"error",…}`), and `kubectl logs --prefix` with the pod and container (`[pod/api-7d9f/api] …`). Logline splits off the prefix, so the payload is parsed like any other line: JSON and logfmt keep their level and fields. Each service becomes its own source (named after the service, such as **api**), stack traces are joined per container even when services interleave, and the full container name is kept in a `container` field (and `pod` for Kubernetes) for searching. A Docker timestamp printed by `--timestamps` becomes the event time when the payload has none. This works for commands you run with Logline, captured terminals, followed files, and imported `.log`/`.txt` files. **Logline: Follow Docker Compose Project** picks a `compose.yaml` or `docker-compose.yml` in the workspace and runs `docker compose logs --follow --timestamps` for it, which attaches to running services without starting them. Lines without a prefix (such as `Attaching to api-1, db-1`) stay in the source that printed them, and a container source shares that source's runs in the Runs tab. Text that only looks similar, such as `a | b`, is left alone: Compose prefixes need a replica number. Set `logline.containerPrefixes` to `off` to keep prefixes in the message.

Program output from **debug sessions** (Run and Debug, F5) is captured automatically for every debugger, such as Node.js, Python, Java, Go, .NET, and C++. Logline reads the Debug Adapter Protocol output events that feed the Debug Console, so nothing in your launch configuration changes. Each launch configuration is a source named **Debug · <name>**, and each debug session is a run; child sessions (such as js-debug's per-process sessions) belong to their top-level configuration. Program `stdout` and `stderr` keep their streams, and debugger messages appear as the `console` stream. Use the inline **Stop** action in the Runs tab, or **Stop server** with the source selected, to end the debug session; **Stop all** leaves debug sessions running because VS Code owns them. When a debugger reports where a line was logged (js-debug does for `console.log`), the expanded event offers **Open code**. Debug capture records what the Debug Console shows. A launch configuration with `"console": "integratedTerminal"` (the default for Python and Java) sends program output to a terminal instead, so only debugger messages reach the Debug Console; turn on **Terminal capture** to record that output, or set `"console": "internalConsole"`. While terminal capture is on, such debug sessions are skipped so lines are not recorded twice. Turn debug capture off with `logline.captureDebugSessions`.

Use **Logline: Manage Terminal Capture** to ignore or re-enable a terminal for the lifetime of that terminal instance. Full-screen alternate-screen applications are skipped; run the command again in a regular shell to capture it.

Choose **Share with agent** in the toolbar to make all retained Logline sources and new runs in this VS Code window available to agents (Copilot, and Claude Code, Codex, or other MCP clients you connected), regardless of the current source, run, or search filters. The first use shows a confirmation explaining the scope and that common credentials are redacted but logs may still contain sensitive information. Accepting **Share logs** remembers that confirmation on this VS Code profile; later uses enable sharing immediately. Cancelling or choosing **Choose specific runs…** does not remember acceptance. You can enable sharing before any logs have arrived.

The toolbar shows **Sharing · Stop** and a scope description. Click it to revoke access. Sharing itself is held in memory and ends when logs are cleared or the window or workspace changes; it is never restored automatically. Use **More actions → Choose specific runs to share…**, or **Logline: Choose Specific Runs to Share with Agent**, to select individual runs instead. Those runs include continuing output, but later commands are excluded. Expanding an event also offers **Share with agent**, which grants only that event’s source and exact run. Cancelling the picker preserves the current sharing scope.

Agent tools respect the active sharing scope and are always redacted, even when export redaction is disabled. They can list shared sources and runs, search with bounded pagination, inspect one event with nearby context, analyze rates/errors/latency/status patterns, read one distributed trace (`logline_get_trace`; spans only from shared OpenTelemetry services), and wait briefly for fresh events after a reproduction. Log content is untrusted application data; sharing does not allow an agent to run or stop commands. Continue in any Copilot agent chat in this window and ask it to inspect the shared logs. With the Logline tools enabled in chat, Copilot can discover the shared runs without a chat picker or handoff prompt. Sharing makes logs available on request; it does not send all logs into chat or send a chat message. The optional **Logline: Ask Copilot to Investigate Logs** command still opens an editable prompt.

### Claude Code, Codex, and other MCP clients

Claude Code, Codex, and other MCP clients use the same tools through Logline's MCP server. Run **Logline: Connect Claude Code or Codex** (also under **More actions**) once and choose the agent:

- **Claude Code** runs `claude mcp add … --scope user logline -- …`, so Logline is available in every project, in the terminal and in the Claude Code extension.
- **Codex** runs `codex mcp add logline …`. The Codex CLI, IDE extension, and app share this setting.
- **Other MCP client** copies a stdio server entry (`command`, `args`, `env`) to add to that client's configuration.

You can run the command in a terminal or copy it. Restart the agent afterwards so it loads Logline. The server runs with VS Code's own runtime, so Node.js does not need to be installed, and it lives at `~/.logline/mcp.js`, which Logline updates with the extension.

Agents read only what you share with **Share with agent**, always redacted, and **Sharing · Stop** cuts them off immediately. While sharing, the status line shows which agents read the logs recently, for example *read by Claude Code*. Each VS Code window listens on `127.0.0.1` only and writes its port and a random token to `~/.logline/agents/`, readable only by your user; the MCP server forwards each tool call to the window whose workspace folder contains the agent's working directory. An agent started outside every window's workspace folders is refused, so an agent in one project cannot read logs shared from another; set `LOGLINE_WORKSPACE` to the folder of the window to use. Redaction hides values under sensitive keys and credentials recognizable on their own, such as GitHub, AWS, Slack and Stripe keys, JSON Web Tokens, bearer tokens, private keys, and passwords in URLs. Set `logline.externalAgents` to `false` to stop accepting MCP clients.

**Live** follows the newest events automatically, with the newest at the top. Scrolling down to read leaves Live, so new rows do not push what you are reading; the mode label says when newer logs have arrived, and scrolling back to the top (or choosing **Live**) resumes it. Set `logline.newestFirst` to `false` for terminal order, with the newest at the bottom. Turn Live off to browse retained history with Older/Newer. Sorting switches to Browse; returning to Live (or Resume after inspecting an event) clears the sort and expanded event and jumps to the newest rows in capture order. The panel renders up to **1,000 rows per page**.

While an event is expanded, incoming logs leave the inspected rows alone. Changing filters, paging, sorting, or selecting columns closes inspection and refreshes the results in Browse mode. Choose Live to follow new events again.

Saved server commands and ad-hoc commands run through the platform's default shell; tasks can select literal argument mode. Stop sends SIGTERM to the process group on macOS/Linux, escalating to SIGKILL after two seconds. Windows uses `taskkill /T /F` to stop the process tree immediately. Changes to `source` and `maxLineLength` apply to newly started processes; restart an existing process to change its capture settings.

## Import and export

The combined source/run picker has separate **Sources** and **Runs** tabs. Sources include terminal, server, task, and imported sources; Runs narrows the current source to one command and provides inline Stop actions for active stoppable runs. Completed terminal runs remain selectable while their events are retained, while empty completed terminal metadata is removed automatically. Use **Export** to save the current source, run, search, and level filters as JSON Lines, JSON, CSV, or **AI context (Markdown)**, with redaction enabled by default. The AI context option and **Copy results** include the latest 1,000 matching events in capture order. **Import** loads JSON, JSONL, CSV, and plain-text log files into a separate `Imported · filename` source for offline searching. A CSV exported by Logline replays its `raw` payloads; imported events receive new IDs, an import stream, and a new session. Other CSV rows use their header names as fields, or replay a nonempty `raw` cell when present.

JSON and JSONL exports contain Logline event envelopes, including normalized metadata and `raw`. Import currently treats these envelopes as new JSON payloads; use CSV to replay the original raw records. Plain-text records without their own timestamps receive the import time.

Full JSON, JSONL, and CSV exports take a fixed snapshot after you choose a destination, then redact and write records in batches. Cancel through the progress notification. Local files are replaced only after the export completes; cancellation or failure preserves an existing destination. CSV includes the first 200 distinct payload fields encountered in capture order, sorted as columns, plus the standard metadata and full `raw` payload. Filesystem providers that require a whole-file write are limited to 16 MiB; use a local file or a narrower filter for larger exports. Small context and Markdown exports use the regular save flow.

Local imports stream records in batches so capture and panel interactions can continue. Use `.json` for JSON documents (including arrays and multiline objects), `.jsonl`/`.ndjson` for one JSON event per line, and `.log`/`.txt` for mixed line-based output. Imported records share the `maxLineLength` limit with live capture; oversized records are marked truncated and the next record is still imported. CSV records support quoted multiline cells. Non-file VS Code filesystem providers require a whole-file read, followed by incremental processing.

## Search and filters

The level filter (next to the search box) is a multi-select — check any combination of Trace/Debug/Info/Warn/Error/Fatal/Unclassified. Click **Syntax** in the search box for a reference to the query syntax below.

Search supports Datadog-style queries:

- Field filters — `level:error`, `service:api`
- Quoted phrases, negation, and OR — `"database timeout" -service:web`, `service:web OR service:api`
- Wildcards and exact match — `status:5xx`, `status:503`
- Comparisons and ranges — `duration:>200`, `status:[500 TO 599]`
- Field presence — `exists:requestId`
- Regex — `message:/timeout/i`
- Relative or absolute time — `last:15m`, `timestamp:[2026-01-01 TO 2026-01-02]`

A term becomes a field filter when a bare identifier precedes the colon. URLs such as `http://api/health` and clock times such as `12:30:05` are free text. Quote an entire `host:port` value, such as `"localhost:3000"`, to prevent it being interpreted as a field filter. Ordinary text matching ignores case; regex patterns preserve case and escapes, and use the `i` flag for case-insensitive matching.

Field names match as typed and fall back to common aliases, so `statusCode:200` and `status:200` both work whether the log calls the field `status` or `statusCode`. The same holds for `level`/`severity`, `message`/`msg`, `service`/`service_name`, `requestId`/`request_id`, `traceId`/`trace_id`, and `durationMs`/`duration`.

Right-click a table cell to **Include value** or **Exclude value** in the current search. The menu shows the field and value, preserves quotes and whitespace, and applies the condition to every `OR` branch. Matching follows the normal search rules (usually case-insensitive contains matching, with special handling for status codes). Server and level selections remain active. Missing or empty values, unsupported field names, and actions that would exceed the 256-character search limit are disabled with an explanation.

Applied search terms appear as removable chips inside the search control. Type a term and press Enter to add it; click a chip to edit it or use its **×** button to remove it. Use **Clear all filters** to remove every query term while keeping server and level selections.

For keyboard access, Tab into a table cell, use arrow keys to move between rendered cells, and press **Shift+F10** to open its menu. Use Up/Down and Enter to choose an action; Escape returns focus to the cell. Applying a filter while inspecting an event returns to Browse. Menus close when the table scrolls or its displayed rows are replaced.

The search row has separate **Saved searches**, **Columns**, and **Analyze** controls. **Saved searches** stores up to 50 named combinations of query, server, and levels, including level-only filters. Saving the same combination replaces its previous entry; use its × button to delete it. There is no automatic recent-search history. While typing, field names and common values are suggested for the field-query syntax used by search.

Autocomplete preserves preceding terms and quotes suggested values, including spaces, quotes, and backslashes. Suggestions for older input or a previously selected server are ignored.

## Columns and log formats

Automatic columns use fields from the selected server, recognize common aliases, and fall back to custom JSON fields instead of showing no payload columns. **Columns** offers up to 200 retained payload fields, including nested dotted paths, so you can add fields beyond the six automatic choices. Added columns are saved with the webview state. Explicit `logline.columns` settings also resolve common aliases.

Format handling covers [ECS](https://www.elastic.co/docs/reference/ecs/logging/nodejs/winston) dotted or nested fields such as `service.name`, `log.level`, `@timestamp`, and `http.response.status_code`; [Pino HTTP](https://github.com/pinojs/pino-std-serializers) request/response fields; and individual [OpenTelemetry log records](https://opentelemetry.io/docs/specs/otel/logs/data-model/) with severity, body, typed attributes, and nanosecond timestamps. Full OTLP batch envelopes and arbitrary arrays are available in event details rather than expanded into table columns.

Plain-text lines in [logfmt](https://brandur.org/logfmt), such as `time=2026-10-03T10:00:00Z level=warn msg="slow query" durationMs=212`, become structured events: `level`, `msg`, and `time` work as they do in JSON, and the remaining keys become searchable, sortable fields. Pure numbers are stored as numbers, so `durationMs:>200` works. A line counts as logfmt only when every token is a `key=value` pair and there are at least two pairs, so ordinary text containing `=` stays plain text.

Log4j2 JsonLayout output is supported directly: the `timeMillis` field is read as the event timestamp, and MDC values nested under `contextMap` are flattened so they're searchable like any other field.

The timezone setting supports Local and UTC.

Click a column's name to sort by that field and click it again to reverse the direction; the arrow shows the active direction. Drag its grip to rearrange columns, or drag the divider at its right edge to resize. Payload fields also have an `×` remove control, and **Columns** restores them. Column widths and order are saved per webview. Rows keep a single-line preview; expand an event to read its full contents. Scrolling past an expanded event preserves its details and internal scroll position.

## Analysis

**Analyze** summarizes the retained logs that match the current filter: totals for events, errors (with their share), and p50/p95/p99 latency; event volume with errors and latency over time, with unusual spikes marked; status codes; the most common values of fields such as source, service, and path; error groups; and the top 20 log patterns, shown with their variable parts as `*` (`POST * completed in *`). Patterns and error groups show their share, a trend over the range, and a **New** badge when they first appeared in its last quarter. Error groups also show where the error was thrown and when it was first and last seen.

Everything is a way into the logs: click a bar to filter to its time range, a status code or field value to filter to it, a source to select it, or a pattern or error group to filter to its messages. The filter is added to the current search. Numbers with units (`48ms`, `1.5s`) and ids do not split a message into separate patterns, and an error logged both with and without its stack is one group. A few events with timestamps far from the rest, such as plain lines stamped on arrival among replayed logs, are left out of the time charts and noted, but still count everywhere else. Analysis uses only events currently retained in memory.

## Exceptions and surrounding context

Expand an event to read structured exceptions as stack frames with real line breaks and nested causes. Common `err`, `error`, `exception`, `thrown`, and stack fields are supported, including Log4j2 throwable frames and OpenTelemetry exception fields. Click a stack frame to open its source location in the workspace; ambiguous filenames open a file picker. **Original event** keeps the JSON available, and **Copy** copies the original formatted event. Plain-text stack traces are joined into one event: Java and Node `at` frames, `Caused by:`/`Suppressed:` sections, `... N more` lines, and Python tracebacks (including chained ones) attach to the line before them. An uncaught Node.js crash is joined as one block: the `path:line` header, the source line and caret, the error, its frames and properties, and the `Node.js v…` line. The row shows the first line (the error line for a Node crash), and a trace headed by an exception without a leading severity is an error; expanding it shows every frame with source links, and error grouping uses the originating frame. A line is held briefly (100 ms) to see whether frames follow it, and JSON lines are never held or joined. When a plain-text crash or stack trace follows a JSON error from the same source and run, within 2 seconds (30 seconds for a Node crash ending in `Node.js v…`, which Node prints as the process exits) and with no other JSON line between them, the two are linked: the error's details show the crash's stack with source links, and the crash row and its details lead back to the error. Both stay separate events in capture order, so search, export, redaction and the persisted log see them exactly as captured; agents inspecting the error receive the crash too, redacted on its own. Imported files are not linked. Turn this off with `logline.joinStackTraces`.

Rows show what they link to: a code icon when Logline knows the log statement behind the event (click it to open the statement), a trace icon when the event has a trace id, and a log doctor icon when the statement has a finding (click it to open the event and read the finding). Hover over a row for icon buttons at the end of its message: **Surrounding logs**, **Trace**, **Open code**, and **Break here**, without expanding it. While **Live**, new rows are held while the pointer moves over the table, so rows do not shift while you aim at one. They appear two seconds after the pointer stops moving, or as soon as it leaves the table.

Choose **Surrounding logs** on an expanded event to see up to 25 retained events before and after it, in capture order, from the same command run. Context includes all levels and both captured streams, regardless of the current search. Select any surrounding event to inspect its details. **Back to results** (or Escape) returns to the existing search and scroll position. Context is a fixed snapshot; ingestion continues, and discarded events cannot be recovered. Each newly imported file has its own context boundary.

## OpenTelemetry and traces

Choose **More actions → Start OpenTelemetry receiver** (or **Logline: Start OpenTelemetry Receiver**) to receive telemetry from instrumented apps on this machine, without running a collector, Jaeger, or another backend. Logline listens for OTLP/HTTP on `127.0.0.1:4318` (`logline.otlp.port`). It accepts `application/json` and `application/x-protobuf` on `/v1/logs` and `/v1/traces`, with optional gzip or deflate compression. Requests over 1 MiB are decoded on a worker thread, and large batches are added in steps, so a big export does not stall the editor. Requests to `/v1/metrics` are accepted and discarded. If another collector already uses the port, Logline listens on a free port instead and says so; it never takes over a port in use. Start and Stop apply to the current window and do not change settings; set `logline.otlp.enabled` to start the receiver automatically, and changing that setting takes over from Start and Stop. The receiver only binds to loopback and refuses requests that carry a browser `Origin` or a non-loopback `Host` header, so web pages cannot send it telemetry.

While the receiver runs and `logline.otlp.injectEnvironment` is on, new processes are pointed at it with standard SDK variables: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_TRACES_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, and shorter batch delays so telemetry appears within a second. This applies to Logline servers and tasks (which also get `OTEL_SERVICE_NAME` from their label), debug launch configurations, and new VS Code terminals. If an environment already chooses an exporter destination (any `OTEL_EXPORTER_OTLP_*ENDPOINT`, `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, or `OTEL_SDK_DISABLED`), Logline adds nothing; otherwise it only adds variables that are not already set. Terminals that were open before the receiver started keep their old environment; VS Code marks them so you can relaunch them.

Each service that sends telemetry appears as a source named **OTel · <service.name>**. Log records become events with `service`, `traceId`, `spanId`, severity, scope, resource attributes (under `resource.`), and their own attributes as searchable fields; an attribute whose name collides with a Logline field is kept as `attributes.<name>`. Exception attributes (`exception.type`, `exception.message`, `exception.stacktrace`) appear as readable stack traces, and `code.filepath`/`code.lineno` link to the log statement. Spans are kept for trace views (up to 20,000 spans or about 64 MiB, oldest first out). `logline.otlp.showSpans` also adds rows for spans: `entry` (the default) shows trace roots and incoming server or consumer spans, such as `GET /orders/:id (182 ms)`, with `durationMs`, `spanKind`, `spanStatus`, and span attributes as fields, so `durationMs:>200` and **Analyze** latency work on requests. `all` shows every span and `none` keeps spans out of the table.

Choose **Traces** in the search toolbar to see recent requests: each trace's start time, root operation, services, duration (as a bar scaled to the slowest trace), and how many spans and logs it has. Traces with errors are marked in red, **Errors only** narrows the list, and choosing a trace opens its waterfall, where **All traces** returns to the list. The list includes traces that only appear in logs, such as JSON logs with a `traceId`, so it is useful without OpenTelemetry too. The button shows how many traces with spans are retained, and while the receiver runs a green **OpenTelemetry** chip under the toolbar shows its address; click it to open the list. In the table, rows that belong to a trace have a trace button next to the message that opens its waterfall in one click.

Expand any event that has a trace id (from OpenTelemetry or from a JSON log's `traceId`/`trace_id` field) and choose **Trace**. Events without a trace id show **Trace** disabled, with the reason in its tooltip. You can also run **Logline: Show Trace** with an id. The trace view is a waterfall of every received span across services, indented by parent, with failed spans in red and the critical path (the chain of spans that determined when the request finished) highlighted. **Self** is the time a span spent itself: its duration less the time its child spans cover, with overlapping children counted once and time outside the span ignored. A span with a large duration and little self time was waiting on its children; one with a large self time was doing the work, or waiting on something it did not trace. **Where the time went**, above the waterfall, ranks up to 8 operations (grouped by service and name, across every span of the trace, including those beyond the display limit) by total self time, with their span count and share of all self time; choose one to scroll to its first span. Hover over an operation to see its attributes and events. Retained logs with the same trace id appear under their span, or in a separate list when they name no received span; click one to open its surrounding logs. Logs from processes that only print JSON with a trace id are included too, so services that log to stdout and services that export over OTLP join up. **Filter logs by trace** applies `traceId:<id>` to the table. **Clear** removes spans as well as events. With `logline.persistLogs`, received log records and span rows are written to `latest.log` as the JSON lines shown in the table.

## Log statements in the editor

Logline indexes logging calls in workspace source files: calls such as `logger.info(...)`, `console.error(...)`, `log.Printf(...)`, `slog.Info(...)`, `_logger.LogInformation(...)`, `print(...)`, or Rust's `info!(...)` whose message is a string literal, in JavaScript, TypeScript, Python, Java, Kotlin, Scala, Groovy, Go, C#, Rust, Ruby, PHP, Swift, Dart, and C/C++ files. The message can be the first argument, or the second after a context object or marker (`logger.info({ userId }, "renewed")`, SLF4J markers). It can concatenate literals with expressions (`"Order " + id + " rejected"`) or be wrapped in a format call (`String.format`, `fmt.Sprintf`, `string.Format`, `util.format`). Placeholders such as `${id}`, `{}`, `{UserId}`, `%s`, `%(name)s`, `#{x}`, Kotlin `$name`, and concatenated expressions become wildcards. Messages assembled elsewhere (in a variable or helper) are only attributed by reported location. Indexing covers open editors and up to 5,000 workspace files (`logline.logLensMaxFiles`) of at most 512 KiB, skips common dependency and build folders and calls inside comments, and follows edits and file changes. When an event reports a file the scan did not reach, Logline finds and indexes that file on demand.

Each captured event is attributed to a statement by the code location it reports, when it reports one: the debugger's output location, OpenTelemetry `code.filepath`/`code.lineno` (or `code.file.path`/`code.line.number`), Log4j and Go `source.file`/`source.line`, Python `pathname`/`lineno`, ECS `log.origin.file.*`, or a `caller` such as `pkg/handler.go:42`. Otherwise the message text is matched against the statement's literal text. Short or generic templates (fewer than six distinctive characters) are only matched by location. A message that two statements explain equally well is not attributed to either.

Statements that produced retained events show a CodeLens such as **12 hits · 2 errors · last 3s ago**; click it to filter the Logs panel to those events. Hover over the statement to see its three most recent messages and how they were matched. With `logline.logLenses` set to `codelens+gutter`, statements that logged errors are also marked in the gutter and overview ruler. Counts cover the retained events and change as events arrive or are evicted; **Clear** resets them. Expanded events offer **Open code · file:line** to jump to the statement behind them, and **Logline: Show Log Statements That Have Not Logged** lists statements in the active file without retained events, which helps when a code path was never reached. Set `logline.logLenses` to `off` to stop indexing.

## Log breakpoints

Breakpoints usually stop on code. Log breakpoints stop on what the program logs, which is often how you notice a bug first.

- Expand an event and choose **Break here**. Logline adds a regular debugger breakpoint on the statement that logged the event (found the same way as **Open code**) and opens it in the editor. The next time that statement runs, the debugger stops there, before the line is logged, with the full stack and variables. It is an ordinary breakpoint, so you can add a condition or remove it in the Breakpoints view.
- Choose **More actions → Break on matching logs** to break on the current search and level filter, for example `level:error "payment failed"`. Logline adds breakpoints on up to 10 statements that already logged matching events. It also watches output from debug sessions: when a session logs another matching event that has no Logline breakpoint (for example from a library or a statement it could not map to code), Logline asks the debugger to pause right after it. A notification names the event, with **Show event** and **Remove log breakpoint**. Pausing after the fact cannot stop before the line ran; at most one pause per log breakpoint is requested every 1.5 seconds, and none while the program is already paused.

A status bar item, **Break on log**, shows while log breakpoints are active; click it, or run **Logline: Manage Log Breakpoints**, to see their matches and remove them. **Logline: Break on Matching Logs** asks for a search. Log breakpoints last for the window and work with any debugger that supports the Debug Adapter Protocol `pause` request.

## Log doctor

Log doctor reports problems with log statements in the Problems panel, based on what they actually logged rather than on how the code looks. Findings on statements need log lenses, which match events to the statements they index. Secrets and personal data are also checked in every source's output, including libraries, imported files, terminals, and OpenTelemetry, where no statement is matched: those findings appear in **Log issues** and the health report under the source's name, with **Show example** to open the latest event that carried the value with the logs around it. The same findings appear in the Logs panel: **Log issues** in the toolbar lists them with **Fix…** (opens the statement with its quick fixes) and **Show events**, rows from a statement with a finding carry a log doctor icon, and expanding such an event explains the finding.

| Finding | Reported when | Severity |
| --- | --- | --- |
| `secret` | A statement logged a JSON Web Token, bearer token, AWS, GitHub, Slack, Google or Stripe key, private key, or a value in a credential field such as `password` or `authorization` | Warning |
| `personal` | A statement logged an email address or a payment card number (grouped like a card, or in a card field, and passing the Luhn check) | Warning |
| `missing-exception` | A statement inside a `catch`/`except` block logged errors without a stack trace and does not pass the caught variable | Warning |
| `noisy` | A statement below warning level produced at least 30% of at least 500 retained events | Information |
| `unstructured` | A statement formats two or more values into plain-text messages instead of logging fields | Hint |
| `quiet-failure` | At least half of a statement's events (and at least 3) are logged at trace, debug, or info but describe a failure: a stack trace, a 5xx status, or a message such as "failed", "refused", or "timed out". Messages that deny a failure, such as "no errors", do not count | Warning |
| `contextless` | Most structured logs carry a trace, request, or correlation id, but at least 3 of a statement's events (most of them) are structured warnings or errors without one | Information |
| `oversized` | A statement's events average 8 KB or more, or some were cut at `maxLineLength` | Information |

Evidence is always masked: a finding says what was logged and where (`Logged a JSON Web Token in field headers.authorization in 37 events (eyJh…[jwt])`), never the value itself. Examples like `user@example.com` and already redacted values are ignored. Findings follow the retained events, so they update as logs arrive and disappear after **Clear**.

Quick fixes (Ctrl+. or Cmd+.) depend on the finding: **Lower to debug** for a noisy `info` or `log` call; **Raise to error** for a failure logged at `info`, `debug`, or `log`; **Pass 'err' to the log call** (or **logger.exception** in Python) for a missing exception; **Fix with Copilot** for secrets, personal data, unstructured messages, exceptions, oversized events, and missing request context, which opens chat with the finding and statement; **Show the events in Logs**; and **Ignore this finding**, which adds a `logline-ignore: <finding>` comment above the statement. A `logline-ignore` comment without a finding name silences every finding for that statement. **Logline: Show Log Health** opens a Markdown summary of all findings in the workspace, with what to do about each kind, that you can paste into an issue or pull request. Set `logline.logDoctor` to `security` for secrets and personal data only, or `off`.

## Tasks

Logline observes VS Code task lifecycle events automatically. Shell, process, `node-terminal`, and tasks launched through `launch.json` appear in the Logs selector with their task name, dependency information, process id, and exit reason. VS Code does not expose a supported output stream for an arbitrary task, so use **Logline: Convert VS Code Task to Logline** (or **Logline: Capture VS Code Task in Logline**) to create a captured wrapper when the task's stdout/stderr should be retained line by line. The converter follows `dependsOn` links and creates wrappers for supported dependencies too.

New automatic task IDs include the workspace folder, task type, and exact label, so equal labels in different folders and labels with similar punctuation remain separate. Explicit `taskId` values, including IDs in existing converted tasks, are preserved. Dependency status follows the latest matching run in the same folder and recognizes converted task labels. Dependency status indicates whether a task has finished, not whether it succeeded.

Servers can also be started as a VS Code task, with output streamed into the same Logs panel. Tasks are discovered in every workspace folder and run in their own folder's scope. Conversion preserves existing task comments and rejects malformed task files or files changed on disk while its picker was open. Add a task of type `logline` to `.vscode/tasks.json` — comments and trailing commas are fine, it's read as JSONC:

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "logline",
      "label": "Run API",
      "command": "npm",
      "args": ["run", "dev"],
      "jsonOnly": false,
      // "shell": false,
      // "dependsOn": ["Logline: Build"],
      // "dependsOrder": "sequence",
      // "options": { "cwd": "${workspaceFolder}/server", "env": {} }
    }
  ]
}
```

Supplying `args` selects literal argument mode by default, including `args: []`. Arguments containing spaces or quotes are passed directly to the process unless `shell: true` is set.

Set `shell: true` when the command is a shell line containing pipes, redirects, or shell operators. Task variables such as `${env:NAME}`, `${config:logline.source}`, and `${input:name}` are resolved by VS Code immediately before the Logline task starts, including variables in `command`, `args`, `options.cwd`, and `options.env`. `jsonOnly: true` applies to this task only and drops non-JSON lines while retaining structured output.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `logline.servers` | `[]` | Saved server commands shown in the server selector. Each entry supports `cwd` (which expands `${workspaceFolder}`), `env`, `autoStart`, and `jsonOnly`. |
| `logline.source` | `both` | Capture `stdout`, `stderr`, or `both`. |
| `logline.captureTerminals` | `false` | Capture new commands from supported shell-integrated VS Code terminals. |
| `logline.captureDebugSessions` | `true` | Capture program output from debug sessions for every debugger. Applies to sessions started afterwards. |
| `logline.otlp.enabled` | `false` | Start the local OpenTelemetry (OTLP/HTTP) receiver automatically. The Start/Stop commands change only the current window. |
| `logline.otlp.port` | `4318` | Preferred receiver port; a free port is used if it is taken. `0` picks any free port. |
| `logline.otlp.injectEnvironment` | `true` | Point Logline servers and tasks, debug sessions, and new terminals at the receiver with `OTEL_*` variables, without replacing values you set. |
| `logline.otlp.showSpans` | `entry` | Spans shown as table rows: `none`, `entry` (roots and incoming requests), or `all`. |
| `logline.logLensMaxFiles` | `5000` | Workspace source files scanned for log statements; files that events report are indexed on demand beyond it. |
| `logline.logLenses` | `codelens` | `off`, `codelens`, or `codelens+gutter`: show activity for log statements in the editor. |
| `logline.containerPrefixes` | `auto` | Split Docker Compose and `kubectl logs --prefix` prefixes so each service is its own source; `off` keeps them in the message. |
| `logline.logDoctor` | `all` | `off`, `security` (secrets and personal data), or `all`: report problems with log statements in the Problems panel. |
| `logline.joinStackTraces` | `true` | Join plain-text stack trace lines into one event for new captures, followed files, and plain-text imports. |
| `logline.columns` | `[]` | Preferred table columns. Empty auto-detects common fields. |
| `logline.timezone` | `local` | `local` or `utc` for displayed timestamps. |
| `logline.newestFirst` | `true` | Show the newest logs at the top of the Logs panel. Turn off for terminal order, with the newest at the bottom. |
| `logline.indentation` | `2` | Spaces used when formatting expanded JSON. |
| `logline.maxEvents` | `50000` | Maximum events retained in memory. Applied immediately. |
| `logline.maxMemoryMb` | `100` | Approximate memory budget for retained events. Applied immediately. |
| `logline.maxLineLength` | `65536` | Maximum characters retained from one live log line or imported record. |
| `logline.refreshIntervalMs` | `500` | Minimum time between Logs panel updates. The panel refreshes as soon as new data arrives rather than on a fixed poll, so this only caps how often that happens during a heavy burst of log lines. |
| `logline.persistLogs` | `false` | Persist captured logs to `.logline/latest.log` in the first workspace folder. |
| `logline.maxDiskMb` | `1000` | Size at which `latest.log` rolls over to `latest.log.1`. Only the current and one previous file are kept. |
| `logline.redactExports` | `true` | Redact common credentials and secret-like fields in exports and **Copy results**. Shared-agent results are always redacted. |
| `logline.redactionFields` | `[]` | Additional field names to redact in exports, **Copy results**, and shared-agent results. |
| `logline.redactionReplacement` | `[REDACTED]` | Replacement text used for redacted exports, **Copy results**, and shared-agent results. |

## Bounded retention

Numeric settings are clamped to their documented ranges; event counts, line lengths, indentation, and refresh intervals use whole numbers. Invalid setting types fall back to defaults. Malformed saved servers are ignored for execution, `autoStart` requires the boolean `true`, and only string environment values are passed through. Preferred columns are limited to 200. Manage servers distinguishes duplicate labels by ID.

The viewer retains up to **50,000 events or 100 MiB** of estimated event storage by default, whichever limit is reached first. The estimate includes top-level strings, flattened field names and values, dependency strings, and approximate object/property overhead. It is not a bound on total VS Code memory: indexes, temporary exports, and browser DOM storage add overhead. Older events are evicted automatically, and the footer shows the live figure against the configured budget. Raising or lowering `maxEvents` or `maxMemoryMb` takes effect immediately, without reloading the window. Wide structured logs may reach the memory limit before the event limit.

Search and analysis cover retained history only; enable `persistLogs` or use a log service for archival storage. Persisted logs are written to `.logline/` in the first workspace folder — add that directory to your `.gitignore`.

Disk persistence buffers up to 8 MiB of estimated text storage, including writes in progress. If the disk falls behind, new disk writes are skipped until space becomes available; live capture continues. Write failures also warn and count the affected batch's lines in the footer's **disk writes skipped** counter; later batches can continue. Accepted writes remain ordered. Each rollover retains one previous file, so disk use can approach twice `maxDiskMb`, plus a batch. Field-name indexes release names when their last retained event is evicted, and each event exposes at most 120 flattened fields, including MDC fields; the original raw event remains available within the line-length limit.

Redaction applies to exports and **Copy results** when enabled; shared-agent results are always redacted. **Copy** on an expanded event and disk persistence retain original content. Additional `redactionFields` match structured field names; free-text redaction recognizes common credential assignments. If valid JSON is too deeply nested to redact and serialize, its exported raw payload is replaced entirely with the redaction marker.

## Workspace trust

The extension runs server commands defined in workspace settings and tasks, so it is disabled in restricted mode and in virtual workspaces. Trust the workspace to use it.
