# Usage reference

[← Back to README](../README.md)

Detailed behavior and settings for Logline. For an interactive quick reference, open **Help** in the Logs toolbar.

## Capture and live tail

Open **Help** in the Logs toolbar for the offline **Logline Guide**. It is a visual quick reference for capture, search, inspection, analysis, sharing, and retention. The **What’s new** tab shows curated highlights for releases you have not viewed; the full version history is available from that tab. The Command Palette also exposes **Logline: Open Guide** and **Logline: What’s New**. The Help button gets a small **New** badge after an update, and the guide never opens by itself.

Run **Logline: Run Command**, or open **Manage servers** in the Logs panel to add, edit, and delete saved commands. Multiple servers can run concurrently; the source dropdown separates them by server ID and the run dropdown separates individual command executions. **Stop server** stops the selected process; **Stop all** stops every process. Running a command requires a trusted workspace.

A saved server can also start automatically when the extension activates by setting `autoStart: true` on it (also requires a trusted workspace). Set `jsonOnly: true` on a server whose command interleaves build-tool output with its own JSON logs (for example `gradle bootRun`) to discard everything that isn't valid JSON.

Enable **Capture** in the toolbar (or run **Logline: Enable Terminal Capture**) to observe new commands in supported VS Code terminals. Capture starts at the next shell-integrated command; terminal scrollback from commands that were already running is not recoverable. Terminal output is stored as one `terminal` stream because the shell integration API does not expose stdout and stderr separately. Structured JSON levels remain authoritative; unstructured lines use an explicit leading level marker when present and otherwise appear as **Unclassified**. Capture is local and does not transmit logs by itself. Disable it at any time without stopping a terminal command.

Use **Logline: Manage Terminal Capture** to ignore or re-enable a terminal for the lifetime of that terminal instance. Full-screen alternate-screen applications are skipped; run the command again in a regular shell to capture it.

Choose **Share logs with agent** to make all retained Logline sources and new runs in this VS Code window available to Copilot, regardless of the current source, run, or search filters. The first use shows a confirmation explaining the scope and that common credentials are redacted but logs may still contain sensitive information. Accepting **Share logs** remembers that confirmation on this VS Code profile; later uses enable sharing immediately. Cancelling or choosing **Choose specific runs…** does not remember acceptance. You can enable sharing before any logs have arrived.

The toolbar shows **Sharing logs · Stop** and a scope description. Click it to revoke access. Sharing itself is held in memory and ends when logs are cleared or the window or workspace changes; it is never restored automatically. Use **More actions → Choose specific runs to share…**, or **Logline: Choose Specific Runs to Share with Agent**, to select individual runs instead. Those runs include continuing output, but later commands are excluded. Expanding an event also offers **Share source with Agent**, which grants only that event’s source and exact run. Cancelling the picker preserves the current sharing scope.

Agent tools respect the active sharing scope and are always redacted, even when export redaction is disabled. They can list shared sources and runs, search with bounded pagination, inspect one event with nearby context, analyze rates/errors/latency/status patterns, and wait briefly for fresh events after a reproduction. Log content is untrusted application data; sharing does not allow an agent to run or stop commands. Continue in any Copilot agent chat in this window and ask it to inspect the shared logs. With the Logline tools enabled in chat, Copilot can discover the shared runs without a chat picker or handoff prompt. Sharing makes logs available on request; it does not send all logs into chat or send a chat message. The optional **Logline: Ask Copilot to Investigate Logs** command still opens an editable prompt.

**Live** follows the newest events automatically. Turn it off to browse retained history with Older/Newer. Sorting switches to Browse; returning to Live (or Resume after inspecting an event) clears the sort and expanded event and jumps to the newest rows in capture order. The panel renders up to **1,000 rows per page**.

While an event is expanded, incoming logs leave the inspected rows alone. Changing filters, paging, sorting, or selecting columns closes inspection and refreshes the results in Browse mode. Choose Live to follow new events again.

Saved server commands and ad-hoc commands run through the platform's default shell; tasks can select literal argument mode. Stop sends SIGTERM to the process group on macOS/Linux, escalating to SIGKILL after two seconds. Windows uses `taskkill /T /F` to stop the process tree immediately. Changes to `source` and `maxLineLength` apply to newly started processes; restart an existing process to change its capture settings.

## Import and export

The source selector shows terminal, server, task, and imported sources; the run selector narrows a source to one command. Use **Export** to save the current source, run, search, and level filters as JSON Lines, JSON, CSV, or **AI context (Markdown)**, with redaction enabled by default. The AI context option and **Copy results** include the latest 1,000 matching events in capture order. **Import** loads JSON, JSONL, CSV, and plain-text log files into a separate `Imported · filename` source for offline searching. A CSV exported by Logline replays its `raw` payloads; imported events receive new IDs, an import stream, and a new session. Other CSV rows use their header names as fields, or replay a nonempty `raw` cell when present.

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

Log4j2 JsonLayout output is supported directly: the `timeMillis` field is read as the event timestamp, and MDC values nested under `contextMap` are flattened so they're searchable like any other field.

The timezone setting supports Local and UTC.

Click a column's name to sort by that field and click it again to reverse the direction; the arrow shows the active direction. Drag its grip to rearrange columns, or drag the divider at its right edge to resize. Payload fields also have an `×` remove control, and **Columns** restores them. Column widths and order are saved per webview. Rows keep a single-line preview; expand an event to read its full contents. Scrolling past an expanded event preserves its details and internal scroll position.

## Analysis

**Analyze** opens retained metrics for the current filter: event rate, errors, latency, status-code counts, the top 10 log patterns by volume, and normalized error groups. Analysis uses only events currently retained in memory.

## Exceptions and surrounding context

Expand an event to read structured exceptions as stack frames with real line breaks and nested causes. Common `err`, `error`, `exception`, `thrown`, and stack fields are supported, including Log4j2 throwable frames and OpenTelemetry exception fields. Click a stack frame to open its source location in the workspace; ambiguous filenames open a file picker. **Original event** keeps the JSON available, and **Copy event** copies the original formatted event. Plain-text exception lines can link to source, but separate physical lines are not automatically grouped.

Choose **Show context** on an expanded event to see up to 25 retained events before and after it, in capture order, from the same command run. Context includes all levels and both captured streams, regardless of the current search. Select any surrounding event to inspect its details. **Back to results** (or Escape) returns to the existing search and scroll position. Context is a fixed snapshot; ingestion continues, and discarded events cannot be recovered. Each newly imported file has its own context boundary.

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
| `logline.columns` | `[]` | Preferred table columns. Empty auto-detects common fields. |
| `logline.timezone` | `local` | `local` or `utc` for displayed timestamps. |
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

Redaction applies to exports and **Copy results** when enabled; shared-agent results are always redacted. **Copy event** and disk persistence retain original content. Additional `redactionFields` match structured field names; free-text redaction recognizes common credential assignments. If valid JSON is too deeply nested to redact and serialize, its exported raw payload is replaced entirely with the redaction marker.

## Workspace trust

The extension runs server commands defined in workspace settings and tasks, so it is disabled in restricted mode and in virtual workspaces. Trust the workspace to use it.
