# Changelog

All notable changes to Logline are documented in this file.

## 1.14.0 — 2026-10-10

### Changes

- **Connect Claude Code or Codex** also installs three skills, step-by-step investigations with the Logline tools: `logline-verify` checks a change in the logs it produces, `logline-triage` ranks what is failing and why, and `logline-slow-request` explains where a slow request spends its time. The agent picks one when a request fits, or start one with `/logline-verify` in Claude Code or `$logline-verify` in Codex. Installed skills update with Logline. The MCP server offers the same workflows as prompts to any client that supports them.
- **Metrics**: the OpenTelemetry receiver keeps metrics instead of discarding them. **Metrics** in the toolbar lists each series with its latest value and a trend line: gauges by value, counters as a rate per second, and histograms by the p95 of the latest interval. Apps Logline points at the receiver export metrics every 5 seconds.
- Log doctor checks OpenTelemetry spans and metrics against the semantic conventions: services without a name, ids in span names, 5xx responses not marked as errors, HTTP server spans without `http.route`, attribute names replaced in the stable conventions, and units in metric names. Findings are listed per service under **OpenTelemetry conventions** in **Log issues** and the health report, with **Show trace**.
- **Logline: Show Status** (also **More actions → Status and troubleshooting…**) shows the OpenTelemetry receiver, agent connections and skills, sharing, capture, retention, and editor features in one list. Each item that is off or broken offers its fix, such as choosing another receiver port when 4318 was taken, and **Copy status** copies it for a bug report.
- In Cursor, Windsurf, and Kiro, **Connect Claude Code or Codex** offers the editor's own agent first and adds Logline to its MCP settings file. Without GitHub Copilot Chat, **Fix with Copilot** and the **Ask Copilot** button are not offered, and investigation prompts are copied for another agent.
- **My changes**, next to the level filter in a git repository, shows only logs from code you changed since the last commit: the statement that logged them, the location they report, or a frame in their stack trace is on a changed line, and new files count throughout. It adds `changed:true` to every `OR` branch, so it combines with any search (`level:error changed:true` for errors your edits caused) and works in Analyze, exports, saved searches, and **Break on matching logs**. Edits count once saved or written to disk, including by an agent or formatter. Agent searches, analysis, and waits take `changedOnly` for the same filter, and say how many files changed.
- The trace waterfall shows each span's **self time**: its duration less the time its child spans cover, counting parallel children once. **Where the time went** above the waterfall ranks the operations that spent the most time themselves, per service, with how many spans each had and their share of the trace; choose one to jump to its first span. A slow request whose time is in its own code, rather than in a database call or downstream service, now stands out without reading the whole waterfall. `logline_get_trace` returns the same self times and ranking to agents.
- Log lenses show how long a statement's work takes when its events report a duration (`durationMs`, `duration`, `duration_ms`, or `responseTime`): **1,204 hits · p50 12 ms · p95 180 ms**, from its latest 256 retained events. Hover for p99 and the maximum.
- An uncaught Node.js crash becomes one event: the `path:line` header, source line, caret, error, `at` frames, error properties, and the `Node.js v…` line are joined, and the row shows the error (`TypeError: …`) instead of the path.
- Joined plain-text traces headed by an exception, and Node crash blocks, are errors instead of Unclassified when the line has no leading severity.
- Frames of joined traces such as `TypeError: …` are clickable in the expanded event and anchor error grouping.
- A plain-text crash or stack trace that follows a JSON error from the same source and run, within 2 seconds (30 seconds for a Node crash that ends the process), is linked to it. The error's details show the crash's stack, and the crash row leads back to the error. Both stay separate events in capture order, and agent `inspect` of the error includes the crash, redacted on its own.
- The Logs toolbar is quieter: the search row's controls have no border until hovered, opened, or on, the filter box gets more room, **My changes** looks like an applied filter while on, only **Live** keeps a colored outline, and **Log issues** shows its count in the warning color. On narrow panels, **Saved searches**, **Columns**, **Traces**, **Metrics**, and **Log issues** show only their icon and count.

### Security

- Logs shared with agents, and redacted exports, now also hide credentials that appear without a sensitive key name: GitHub, AWS, Slack, Google and Stripe keys, JSON Web Tokens, bearer tokens, private keys, and passwords in URLs such as `postgres://user:password@host`.
- An MCP agent started outside a window's workspace folders can no longer read that window's shared logs because it happens to be the only one open. Set `LOGLINE_WORKSPACE` to choose a window explicitly.
- `.logline/latest.log`, which is unredacted, is readable only by your user. Folders and files written by earlier versions are tightened on the next write.

### Fixes

- Copilot and an MCP agent such as Claude Code can both wait for new logs at once (up to four waits) instead of the second failing as busy, and waiting searches again only when new events arrive.
- Turning `logline.externalAgents` off and on quickly no longer leaves an extra agent listener running.
- The OpenTelemetry receiver no longer decompresses a request body it already refused as too large.

## 1.13.1 — 2026-10-04

### Changes

- Improved Marketplace listing: categories, keywords, sponsor link, and README overview.

## 1.13.0 — 2026-10-04

### Changes

- **Analyze** opens with totals for events, errors, and p50/p95/p99 latency, adds the most common values of fields such as source, service, and path, and shows status codes as bars. Every bar, status code, value, pattern, and error group filters the logs to it. Patterns read like `POST * completed in *`, show their share, trend, and a **New** badge, and there are 20 instead of 10. Error groups show where they were thrown, when they were first and last seen, and their trend.
- **Log doctor** reports failures logged at info or debug (with a **Raise to error** quick fix), errors without a trace or request id when most logs have one, and statements whose events average 8 KB or more or were truncated. It also finds secrets and personal data in output that no statement accounts for, such as libraries, imports, and terminals, and lists them by source with **Show example**. The health report explains what to do about each kind of finding.
- The newest logs appear at the top of the Logs panel, as in Datadog and other log tools. Scrolling down to read leaves Live so new rows no longer push the rows you are reading, and scrolling back to the top resumes it. Set `logline.newestFirst` to `false` for terminal order.

### Performance

- Live refreshes send only the new rows instead of the whole 1,000-row page, so a busy stream sends about 25 KiB per refresh instead of about 400 KiB.
- Scrolling builds only the rows that come into view and leaves the others in place: frames take about a third of the time, and the slowest frame went from about 10 ms to under 3 ms.
- Refreshes no longer force a layout per table cell for keyboard navigation, or a layout of the half-updated toolbar before rendering rows.

### Fixes

- **Analyze** no longer splits one message into many patterns or error groups when it contains numbers with units (`after 48ms`), or one error into two groups when it was logged both with and without its stack.
- A few events with timestamps far from the rest, such as plain lines stamped on arrival among replayed logs, no longer squeeze the **Analyze** charts into a few bars; they are noted and left out of the time charts only.
- Following a large log file could read the whole file instead of its tail when the extension host was busy at start-up.
- A task that cannot start keeps its spawn error as the reason instead of `exit code -2`.

## 1.12.2 — 2026-10-04

### Fixes

- The Traces list names a trace that has only logs by the request its logs describe, such as `POST /orders/checkout`, instead of its first log message. Logline reads the method and path from fields like `method`, `path`, `requestUrl`, or `http.route`, or from `requestUrl=…` and `GET /path` text in a message, and leaves out the query string.
- Long operations in the Traces list wrap to two lines instead of being cut off; the tooltip still has all of it.
- Searches and columns treat `http.method` and `requestMethod` as `method`, and `http.route`, `http.target`, `http.url`, `requestUrl`, `requestUri`, and `uri` as `path`.

## 1.12.1 — 2026-10-04

### Fixes

- **Logline: Connect Claude Code or Codex** writes the setup command for your default terminal shell. On Windows with Git Bash it no longer starts with PowerShell's `&`, which failed with `syntax error near unexpected token '&'`; Command Prompt gets plain double quotes, and PowerShell is unchanged.

## 1.12.0 — 2026-10-04

### Behavior changes

- Each VS Code window running Logline now listens on `127.0.0.1` for MCP clients and keeps a small discovery file in `~/.logline/agents/`, readable only by you, plus the MCP server script at `~/.logline/mcp.js`. Agents still read nothing until you choose **Share with agent**. Set `logline.externalAgents` to `false` to turn this off.
- The status line shows sharing as **Sharing all runs** or **Sharing N runs**, with details in its tooltip, and the running command as a single muted line.
- Messages in the table no longer have a tooltip.
- While **Live**, new rows are held only while the pointer moves over the table. Two seconds after it stops, or as soon as it leaves, the table catches up, so a pointer resting on the table no longer freezes it.

### Changes

- Share logs with **Claude Code**, **Codex**, and other MCP clients, not only Copilot. **Logline: Connect Claude Code or Codex** (also under **More actions**) registers Logline's MCP server with the agent; it exposes the same six read-only tools, answers only from what **Share with agent** shares, always redacted, and **Sharing · Stop** cuts every agent off. The server runs with VS Code's own runtime from `~/.logline/mcp.js` and reaches the window whose workspace contains the agent's working directory over `127.0.0.1` with a per-window token. While sharing, the status line shows which agents read the logs recently. Set `logline.externalAgents` to `false` to turn this off.
- While sharing, the status line names the agents that read the logs under the current grant, such as *Sharing all runs · read by Claude Code*. Stopping sharing clears it, and an agent's refused calls do not count.
- The status line stays on one line: shorter sharing text with details in its tooltip, and the running command as a muted `$ …` line cut to fit.
- The Traces list gives the operation the remaining width, with the full operation and trace id in its tooltip, and its duration column lines up with each row.
- Messages in the table no longer show a tooltip that repeats them; click a row to read the full message. Tooltips wrap long values and stop at 280 characters.
- The run picker names runs by their command, or their task or source, instead of an internal id. Observed VS Code tasks record their command line.

## 1.11.0 — 2026-10-03

### Behavior changes

Nothing was removed, but a few things look or behave differently after updating:

- While **Live**, new rows are held while the pointer is over the table and appear when it leaves, so rows no longer move under the pointer. The mode label says when rows are held.
- Actions on expanded events have new names: **Show context** is **Surrounding logs**, **Open log statement** is **Open code**, **Break when this logs again** is **Break here**, **Show trace** is **Trace**, **Copy event** is **Copy**, and **Share source with Agent** is **Share with agent**. The toolbar's **Share logs with agent** is **Share with agent**.
- Log lens counts drop evicted events right away instead of within about 10 seconds.
- Log doctor findings also appear in the Logs panel (**Log issues**, row icons, and expanded events), not only in the Problems panel. Set `logline.logDoctor` to `off` to turn them off.

### Changes

- Expanded events show their actions as one labeled toolbar with icons: **Surrounding logs**, **Trace**, **Open code**, and **Break here** on the left, **Copy** and **Share with agent** on the right. Actions that do not apply to an event, such as **Trace** without a trace id, stay visible but disabled, with the reason in their tooltip, so they can be discovered from any event. **Open code** shows the file name and line, with the full path in its tooltip. A dismissible tip under the event explains right-click filtering on table cells.
- Rows show what they link to without being opened: a code icon when Logline knows the log statement behind the event, the trace icon, and a log doctor icon when that statement has a finding. Hovering a row reveals icon buttons at the end of its message for **Surrounding logs**, **Trace**, **Open code**, and **Break here**, a chevron marks rows that expand, and a one-time tip explains opening events.
- Toolbar buttons have icons (terminal capture, share with agent, Live/Resume/Browse, clear, stop, levels, saved searches, columns, analyze, copy results) and descriptive tooltips. Tooltips appear after a short pause instead of the browser's one-second delay, on hover or keyboard focus, styled like editor hovers. On narrower panels, **Clear**, **Stop all**, **Copy results**, **Saved searches**, and **Columns** show only their icon, leaving room for the search box. **Share logs with agent** is now **Share with agent** (**Sharing · Stop** while on), and the remove button on search filter chips is centered.
- While following live, new rows are held while the pointer is over the table, so rows do not move between pointing and clicking; the mode label says so, and the rows catch up when the pointer leaves.
- Add **Log issues** to the Logs toolbar while log doctor is on, with a count when it has findings and an explanation of what it checks when it has none. It lists findings by kind (secrets, personal data, missing exceptions, noisy statements, values in messages) with **Fix…**, which opens the statement with its quick fixes, **Show events**, and a link to the full report. An expanded event explains the findings on its statement with the same actions.
- The Traces list no longer offers **Start OpenTelemetry receiver** while the receiver is already running. Its empty state says where the receiver is listening and how to point an app at it.
- Log lenses no longer slow down the editor in large workspaces. Each statement is matched by its rarest word instead of its longest, so statements that share common words ("Processing", "completed") are no longer all tested against every message, and once retention is full, evicted events are subtracted instead of recounting every retained event every 10 seconds.
- Log doctor reuses source it already read, skips refreshes when no counts changed, and only updates Problems for files whose findings changed.

## 1.10.0 — 2026-10-03

### Behavior changes

Nothing was removed or renamed, but some new features are on by default and change what you see after updating. Each can be turned off with one setting:

- Plain-text stack traces are joined into one event instead of one event per line. Set `logline.joinStackTraces` to `false` to keep one event per line.
- Docker Compose and `kubectl logs --prefix` output is split into one source per service. A saved search scoped to the source that captured that output no longer matches its events; scope it to a service source instead, or set `logline.containerPrefixes` to `off`.
- Output from debug sessions (F5) appears in Logs. Set `logline.captureDebugSessions` to `false` to turn this off.
- Logging calls in your editor show a CodeLens with live hit counts. Set `logline.logLenses` to `off` to hide them.
- Log doctor reports problems with log statements in the Problems panel. Set `logline.logDoctor` to `security` to report only secrets and personal data, or `off` to turn it off.

### Changes

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
- The Logs status line no longer shows an empty box after the session count when no command is running.

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
