# Changelog

All notable changes to Logline are documented in this file.

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
- A search-syntax cheat sheet (ⓘ next to the search box) documents field filters, aliases, wildcards, numeric ranges, regex, and time-range queries.
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
