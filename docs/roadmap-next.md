# Roadmap: the next three features

Status: proposal · October 2026

The first roadmap ([roadmap.md](roadmap.md)) shipped in full. The code now covers debug capture, the OpenTelemetry receiver and trace view, and live log lenses. This proposal has a sharper goal: **build things that neither VS Code nor IntelliJ IDEA supports**, so that both editor teams have a reason to notice.

What the editors ship today (October 2026):

- **VS Code.** The Output panel and Debug Console treat program output as plain text with a substring filter. The request for a structured logging console ([microsoft/vscode#185904](https://github.com/microsoft/vscode/issues/185904)) and the Debug Console filter request ([#93750](https://github.com/microsoft/vscode/issues/93750)) are still open. Breakpoints can be conditional or logpoints, but nothing pauses the debugger *because of what the program logged*.
- **IntelliJ IDEA 2026.2.** The new OpenTelemetry plugin adds a Logs table, traces, and a service map, but only for OTLP data. The Run console is still text with a basic filter. Breakpoints, logpoints, and exception breakpoints exist, but there is no breakpoint triggered by log content. The integrated MCP server exposes run configurations and the debugger, but no structured log history.
- **Neither editor** can save a log investigation: the query, the result, the trace, and the explanation together as a file that can be re-run, reviewed in a PR, or attached to an issue. That workflow exists only in hosted tools such as Datadog Notebooks.

| # | Feature | Why neither IDE has it | VS Code API it showcases |
| --- | --- | --- | --- |
| 1 | **Docker Compose and container sources** | Both IDEs show Compose output as prefixed text. Logline gets it wrong today too (see below). | `ProcessRunner`, sources |
| 2 | **Log breakpoints: "break when this is logged"** | Both IDEs break on *code* (lines, exceptions, conditions), never on *output*. | `debug.addBreakpoints`, `DebugAdapterTracker`, DAP `pause` |
| 3 | **Investigation notebooks (`.logbook`)** | Neither IDE has a notebook over local runtime logs and traces. | `NotebookSerializer`, `NotebookController`, notebook renderers, LM tools |

Suggested order: 1, then 2, then 3. Compose is the smallest change and fixes data that is parsed incorrectly today. Log breakpoints is the "how did nobody build this?" demo. Notebooks is the largest and is the 2.0 headline.

---

## 1. Docker Compose and container sources

### Pain

Many full-stack developers run their stack with `docker compose up`. Compose prefixes every line with the service name. The prefix breaks JSON detection in `parseLogLine`, so structured logs become plain text with no level, no fields, and no way to filter by service. This is easy to reproduce today:

```
input:  api-1  | {"level":"error","msg":"db timeout","durationMs":812}
stored: level "info", isJson false, fields {}
```

Every search, Analyze chart, error group, log lens, and trace link fails for these users. The first roadmap set container sources aside because `docker compose logs -f` already works with **Run Command**. The code shows that it runs, but the output is parsed incorrectly.

### What users get

- **Prefix-aware parsing.** Lines in the form `<service>  | <payload>` (Compose v2), `<service>_1  | ` (v1), and `[pod/<name>/<container>] ` (`kubectl logs --prefix`, `stern`) are split. The payload goes through the normal JSON, logfmt, and plain-text pipeline. The prefix becomes a `container` field, and the level, fields, and timestamps come from the payload.
- **One source per service.** Each Compose service appears as its own source in the Sources tab, for example "Compose · api" and "Compose · db". Filtering, run scoping, and Copilot sharing therefore work per service.
- **Logline: Follow Docker Compose Project** finds `compose.yaml` / `docker-compose.yml` in the workspace. It runs `docker compose logs -f --no-color --timestamps` and uses Docker's timestamps when the payload has none. When the workspace has a compose file, **Run Command** offers the same command as a suggestion.
- **OpenTelemetry bridge.** When the receiver is running, the Follow command notes that containers reach it at `host.docker.internal:<port>`. Optionally, it writes a `compose.override.yaml` snippet that sets `OTEL_EXPORTER_OTLP_ENDPOINT`, so traces from containerized services join the waterfall.

### Design

- New pure function `src/core/container-prefix.ts`: `splitContainerPrefix(line) → { container, payload } | undefined`. It is anchored and linear, with no backtracking, and it only accepts a prefix when the separator column is consistent within the stream. This prevents false matches on ordinary text that contains ` | `. In `parseLogLine`, call it before JSON detection, only for `stdout`/`stderr`/`terminal` streams, and only when the whole line is not already valid JSON.
- Docker's `--timestamps` adds a leading RFC 3339 timestamp. Strip it and use it as `timestampMs` when the payload does not provide one.
- Source splitting: `SessionRegistry` gains child sources keyed by `serverId + container`, with a new `SourceKind` `'container'`. The parent run stays the unit for **Stop**.
- `StackJoiner` must join continuation lines per container. Today it joins per stream. Otherwise interleaved stack traces from two services get merged. This is the trickiest correctness detail, and it needs targeted tests.
- No Docker SDK or socket access: shelling out to the `docker` CLI matches how **Run Command** already works, avoids a new dependency, and keeps the same workspace-trust boundary.

### Effort and risks

- About 1 week for prefix parsing, per-service sources, and the follow command. The OTel override snippet adds about 2 days.
- Risk: false prefix detection in ordinary text logs, such as Markdown tables printed to stdout. Mitigation: require a consistent column and a valid service-name pattern, and add a setting, `logline.containerPrefixes: auto | off`.

### Success metric

Compose users see the same structured table as everyone else, and "docker" becomes a Marketplace search term that leads to Logline.

---

## 2. Log breakpoints: "break when this is logged"

### Pain

You often find a bug through a log line, such as `WARN cart total negative: -12.40` or `status:500 on /checkout`, and then want to stop *the next time it happens* to look at the stack and variables. Today the workflow is manual: find the statement that logged it, set a breakpoint, guess a condition that matches only the bad case, rerun, and step past the good hits. Every debugger has exception breakpoints ("break when this is thrown"). None has the equivalent for logs, even though logs are how most bugs are noticed first.

This is new in both IDEs. VS Code and IntelliJ breakpoints are anchored to code and code conditions. Neither can say "pause when the program logs something that matches `level:warn message:"total negative"`."

### What users get

- **Break next time this logs.** Right-click an event (or use the inspection dialog) and choose **Break when this logs again**. Logline resolves the statement through log lenses (`LogSiteIndex.match`, exact debugger locations first) and adds a real breakpoint at that line. The breakpoint is labelled `Logline: <message template>` so that it is easy to recognize in the Breakpoints view.
  - Optional **"…with these values"**: Logline turns the event's interpolated values into a breakpoint condition where it can do so safely, for example `total < 0` from a `${total}` placeholder. You can edit the condition before the breakpoint is added.
- **Log breakpoints from a query.** In the search box, **More → Break on matching logs** adds a *log breakpoint* entry, for example `level:error service:api`, shown in the Logs panel and in the status bar. It works in two tiers:
  1. **Exact (preferred).** Every indexed log statement whose template could produce a matching message gets a breakpoint, so the debugger stops *before* the log runs, with the full stack and locals.
  2. **Fallback.** When no statement can be resolved (the output comes from a library or a binary dependency), Logline sends a DAP `pause` to the debug session as soon as matching output arrives. The program stops a moment *after* the log, which is usually still inside the same request. The entry shows **"stopped after log"** so that you know it was not exact.
- **Hit history.** Each log breakpoint keeps the last N matching events, so after you resume you can see which hits paused and which were skipped, together with their values.
- **Works with every debugger.** It only uses source breakpoints and DAP, so Node, Python, Java, Go, .NET, and C++ all work.

### Design

- New `src/vscode/log-breakpoints.ts`:
  - Exact tier: `vscode.debug.addBreakpoints([new SourceBreakpoint(location, true, condition)])`. Logline keeps a registry of the breakpoints it created, removes them with `removeBreakpoints` when the log breakpoint is deleted, and listens to `onDidChangeBreakpoints` so that it does not lose track when the user edits or deletes them by hand.
  - Fallback tier: the existing tracker in `debug-capture.ts` already sees every `output` event. Add a hook that runs the compiled query (`matchesQuery` in `query.ts`) on each new event from a debug source. On a match, call `session.customRequest('pause', { threadId })`, using the thread from the last `stopped` or `thread` event, or thread 0 / all threads when the adapter allows it. Throttle to one pause per resume to avoid pause storms.
- New pure helper `src/core/site-conditions.ts`: maps a message template and an event's values to a language-specific condition expression, *only* for simple placeholders (`${x}`, f-string `{x}`, Python `%s` with a named argument, SLF4J `{}` with a resolvable argument). Anything else produces no condition, so the breakpoint stops on every hit, which is always correct. Unit-test this in `src/core` like `log-sites.ts`.
- Query-to-statement resolution reuses `findPatterns` templates and `siteQuery` in `log-sites.ts`. If a query cannot be mapped to statements (for example, only numeric field ranges), use the fallback tier and say so.
- Copilot: a `logline_break_on_log` tool lets an agent say "I'll stop the next time this error is logged", always with a confirmation prompt, because it changes debugger state.

### Effort and risks

- About 2 weeks. The exact tier is small because log lenses already does the hard part. The fallback tier and per-language conditions take most of the time.
- Risk: adapters that do not support `pause`, or that require a valid `threadId`. Mitigation: check `session` capabilities and thread events, and show "pause not supported by this debugger" instead of failing silently.
- Risk: wrong statement attribution for short, generic templates. Mitigation: use exact attribution only when lenses marks the match as `exact` or the template is distinctive. Otherwise ask the user to pick from the candidate statements in a quick pick.

### Success metric

A 10-second GIF: a red log row appears, the user picks **Break when this logs again**, and the next request stops on that line with the values visible. This is the clip most likely to be picked up by the VS Code and JetBrains debugger teams, because it is a debugger capability their products do not have.

---

## 3. Investigation notebooks (`.logbook`)

### Pain

A log investigation ends up scattered across a filter you typed, a trace you looked at, a chart you screenshotted, and a Slack message that says "it's the retry loop in `payments.ts`". None of it can be replayed. The next time the bug appears, or when a reviewer asks "how do you know?", you start again.

Hosted platforms solved this with notebooks (Datadog Notebooks and similar investigation and postmortem notebooks), but only for data that has already been shipped to their cloud. Neither VS Code nor IntelliJ has a notebook over the logs and traces on your own machine. VS Code already has a first-class notebook platform (Jupyter, REST Book, Polyglot), but nobody has applied it to runtime logs.

### What users get

- **New Logline notebook**, or **Open as notebook** from the current filter, creates a `*.logbook` file. Cells come in a few kinds:
  - **Query cells.** A Logline query, such as `level:error service:api last:15m`. Running it renders a compact results table with expandable events, using the same renderer as the Logs panel.
  - **Analysis cells.** Rate, errors, latency, and patterns charts for a query.
  - **Trace cells.** A trace waterfall for a `traceId`.
  - **Markdown cells** for the explanation.
- **Live or pinned.** By default, cells run against the logs Logline currently holds, so a notebook becomes a reusable runbook ("run these 5 checks after starting the stack"). **Pin results** stores the outputs (redacted by default) in the file, so the notebook still shows the evidence when it is opened elsewhere: in a PR, on another machine, or months later.
- **Click-through.** Events in outputs keep their actions: **Open log statement**, **Show trace**, and **Open in Logs panel**.
- **Share.** **Export as Markdown** produces a GitHub-ready write-up with tables and a text waterfall, for issues and postmortems.
- **Copilot / agents.** The *Ask Copilot to investigate* handoff can write its findings *into a notebook*: each query it ran becomes a cell with its output and reasoning, so the agent's investigation can be reviewed and re-run instead of disappearing in chat.

### Design

- `vscode.workspace.registerNotebookSerializer('logline-logbook', …)` for a small JSON format: `{ version, cells: [{ kind: 'query'|'analysis'|'trace'|'markdown', source, pinnedOutput? }] }`. Diffs read cleanly in PRs.
- `vscode.notebooks.createNotebookController` executes cells on the host against `LogStore` (`snapshot`, `analysis`) and `traceView`, the same entry points that `message-router.ts` uses. No new query engine is needed.
- A notebook renderer (`contributes.notebookRenderer`) reuses the webview table, `analysis/charts.ts`, and `inspection/trace.ts` modules from a separate esbuild entry, so outputs look exactly like the Logs panel.
- Pinned outputs go through `redaction.ts` (always on, as for agent tools) and are capped per cell, for example 200 rows, so notebooks stay small enough to commit.
- Relative time (`last:15m`) is evaluated at run time. Pinned outputs record the absolute range they captured.
- Workspace trust: executing cells only reads Logline's in-memory store and never runs commands, so notebooks are safe to open from an untrusted PR. Logline still requires trust to activate.

### Effort and risks

- About 3–4 weeks. The renderer packaging and the output UX take most of the time. Execution is thin glue over existing APIs.
- Risk: pinned outputs leak data into git. Mitigation: always redact, show a "contains pinned output" banner, and add a `logline.notebooks.pinOutputs` setting for teams that want to forbid it.
- Risk: this overlaps the Logs panel. Positioning: the panel is for *looking*, the notebook is for *keeping*. **Open as notebook** is the bridge between them.

### Success metric

Notebooks attached to real issues and PRs ("here's the logbook that shows the bug"). A strong candidate for a VS Code release-notes or extension spotlight, because it uses the notebook API for something it was not built for.

---

## Considered, not chosen

- **Run diff** and **watch rules** (from the earlier draft of this proposal) were set aside in favour of features that neither IDE has.
- **An MCP server for logs.** It would make logs available to Claude Code, Cursor, and other agents, not only Copilot. It is useful, but JetBrains' built-in MCP server already exposes run and debugger context, so it is less distinctive. It is still a good follow-up for the agent audience.
- **Replay a request from its trace** (rebuild an `.http` request from span attributes, resend it, and compare the new trace with the old one). This is a strong demo, but OTLP spans rarely carry request bodies or headers, so it would only work for simple GETs.
