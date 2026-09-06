# Logline

**Live tail for JSON logs.** Logline is a VS Code bottom-panel log viewer for long-running server processes. It parses JSON logs, preserves plain-text output, and provides expandable details, searchable fields, level filters, timestamps, and per-server filtering.

![The Logline panel live-tailing a Node server: colour-coded levels, auto-detected columns, and per-event details.](media/screenshot.png)

## Use

Run **Logline: Run Command**, or open **Manage servers** in the Logs panel to add, edit, and delete saved commands. Multiple servers can run concurrently; the dropdown separates them by server ID. **Stop server** stops the selected process; **Stop all** stops every process. Running a command requires a trusted workspace.

A saved server can also start automatically when the extension activates by setting `autoStart: true` on it (also requires a trusted workspace).

**Live** follows the newest events. Turn it off to browse retained history with Older/Newer. The panel renders up to **1,000 rows per page**.

Search supports Datadog-style queries:

- Field filters — `level:error`, `service:api`
- Quoted phrases, negation, and OR — `"database timeout" -service:web`, `service:web OR service:api`
- Wildcards and exact match — `status:5xx`, `status:503`
- Comparisons and ranges — `duration:>200`, `status:[500 TO 599]`
- Field presence — `exists:requestId`
- Regex — `message:/timeout/i`
- Relative or absolute time — `last:15m`, `timestamp:[2026-01-01 TO 2026-01-02]`

A term only becomes a field filter when a bare identifier precedes the colon, so pasted values that contain colons — URLs, `host:port` pairs, clock times — are searched as free text.

Field names match as typed and fall back to common aliases, so `statusCode:200` and `status:200` both work whether the log calls the field `status` or `statusCode`. The same holds for `level`/`severity`, `message`/`msg`, `service`/`service_name`, `requestId`/`request_id`, `traceId`/`trace_id`, and `durationMs`/`duration`.

The timezone setting supports Local and UTC.

## Tasks

Servers can also be started as a VS Code task, with output streamed into the same Logs panel. Add a task of type `logline` to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "logline",
      "label": "Run API",
      "command": "npm run dev"
    }
  ]
}
```

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `logline.servers` | `[]` | Saved server commands shown in the server selector. Each entry supports `cwd` (which expands `${workspaceFolder}`), `env`, and `autoStart`. |
| `logline.source` | `both` | Capture `stdout`, `stderr`, or `both`. |
| `logline.columns` | `[]` | Preferred table columns. Empty auto-detects common fields. |
| `logline.timezone` | `local` | `local` or `utc` for displayed timestamps. |
| `logline.indentation` | `2` | Spaces used when formatting expanded JSON. |
| `logline.maxEvents` | `100000` | Maximum events retained in memory. Applied immediately. |
| `logline.maxMemoryMb` | `100` | Approximate memory budget for retained events. Applied immediately. |
| `logline.maxLineLength` | `65536` | Maximum characters retained from one unfinished log line. |
| `logline.refreshIntervalMs` | `250` | How often the Logs panel refreshes. |
| `logline.persistLogs` | `false` | Persist captured logs to `.logline/latest.log` in the first workspace folder. |
| `logline.maxDiskMb` | `1000` | Size at which `latest.log` rolls over to `latest.log.1`. Only the current and one previous file are kept. |

## Bounded retention

The viewer retains up to **100,000 events or 100 MiB** of estimated event storage by default, whichever limit is reached first. Older events are evicted automatically, and the footer shows the live figure against the configured budget. Raising or lowering `maxEvents` or `maxMemoryMb` takes effect immediately, without reloading the window.

Search covers retained history only; enable `persistLogs` or use a log service for archival storage. Persisted logs are written to `.logline/` in the first workspace folder — add that directory to your `.gitignore`.

## Development

This directory contains the extension core. Manual testing uses a pair of demo servers — a Node server that emits mixed JSON and plain-text events, and a Spring Boot app — kept outside this repository and not part of the published package.

```sh
npm install
npm run check
npm run package
```

Press F5 to launch an Extension Development Host. Commands run from the selected working directory using a shell. On macOS/Linux, Stop signals the process group and escalates after two seconds.

## Workspace trust

The extension runs server commands defined in workspace settings and tasks, so it is disabled in restricted mode and in virtual workspaces. Trust the workspace to use it.
