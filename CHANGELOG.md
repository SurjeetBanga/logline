# Changelog

All notable changes to Logline are documented in this file.

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
