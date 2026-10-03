# Roadmap: three flagship features

Status: implemented on this branch · October 2026 (see the changelog's Unreleased section)

Logline already covers capture, search, inspection, analysis, export, and Copilot sharing well. These three features target the gaps developers hit most often. Each one relies on a VS Code-native API that browser-based log tools cannot use, so together they make Logline feel like part of the editor rather than a log viewer that happens to run inside it.

| # | Feature | Pain it removes | VS Code API it showcases |
| --- | --- | --- | --- |
| 1 | **Debug Console capture** | Output from F5 debug sessions is unsearchable, unstructured plain text | `debug.registerDebugAdapterTrackerFactory` |
| 2 | **Local OpenTelemetry receiver with trace view** | Seeing local traces requires running Jaeger, Grafana, or Aspire in Docker | `EnvironmentVariableCollection`, webview, LM tools |
| 3 | **Live log lenses (log ↔ code)** | You cannot tell which line of code produced a log, or how often a log statement fires | `CodeLensProvider`, decorations, hover |

Suggested order: 1 → 3 → 2. Feature 1 is the smallest and widens the audience the most. Feature 3 builds on the source locations that Feature 1 collects. Feature 2 is the largest and is the headline feature for a 2.0 release.

---

## 1. Debug Console capture

### Pain

F5 is the most common way developers run their apps in VS Code. Today, output from a debug session goes to the Debug Console, which has a basic text filter and nothing else: no JSON expansion, no level filters, no search history, and no retention after the session restarts. Logline captures terminals, tasks, and its own processes, but it does not see debug sessions at all. That is the biggest capture gap Logline has.

### What users get

- **Terminal capture: On** gains a sibling setting, **Debug capture**. When it is enabled, every debug session's output (`stdout`, `stderr`, and `console`) streams into the Logs panel as its own source. The source is named after the launch configuration, for example "Launch API (node)".
- It works for every debug adapter (Node, Python, Java, Go, .NET, C++, and others) because it reads the Debug Adapter Protocol, not a runtime-specific hook.
- Restarting a debug session creates a new **run**, so "this run vs. last run" works the same way it does for tasks.
- When a debug adapter attaches a source location to an output event (js-debug does this for every `console.log`), Logline stores it. **Open source** then jumps to the exact line that logged the event, with no stack trace needed.
- Copilot sharing covers debug runs automatically.

### Design

- New `src/vscode/debug-capture.ts` registers a `DebugAdapterTrackerFactory` for `'*'`. In `onDidSendMessage`, it handles `{ type: 'event', event: 'output' }` messages and maps `body.category` to a stream. It ignores `telemetry` and treats `important` as stderr.
- It feeds lines into the existing `LineReader` → `StackJoiner` → `Ingestion` path. `body.output` arrives in arbitrary chunks, so it reuses the partial-line framing that `TerminalCapture` already has.
- `SessionRegistry` gains a `debug` source kind. The session ID is the `DebugSession.id`, and the label comes from `session.name` plus the debug type. The run ends on `onDidTerminateDebugSession`.
- When `body.source.path` and `body.line` are present, they are stored as event metadata (`sourceLocation`), separate from the payload, alongside the stack-frame locations that `exceptions.ts` already parses.
- Stopping a run is observe-only, like external terminals, because VS Code owns the debug session. An inline **Stop** action can call `vscode.debug.stopDebugging(session)`.
- New setting: `logline.captureDebugSessions` (default `true`). Unlike terminal capture, it does not need command re-execution, and the data stays local.

### Effort and risks

- About 1 week, including tests that use a mock tracker and an update to the guide card.
- Risk: some adapters also send program output through `runInTerminal`. In that case terminal capture already covers it. To avoid duplicates, skip tracker output when the launch configuration uses `console: integratedTerminal` and terminal capture is on.

### Success metric

Debug sessions are the most-used source type within one release. The Marketplace listing can honestly say "works with F5".

---

## 2. Local OpenTelemetry receiver with trace view

### Pain

OpenTelemetry is now the default way to instrument services, but local development is still awkward. Production exporters point at a collector you don't have on your laptop, so locally you see nothing unless you start Jaeger, Grafana LGTM, or the Aspire dashboard in Docker and switch to a browser. When a request crosses services, the logs from each service end up in separate streams, and correlating them means copying a `traceId` from one place to another.

JetBrains shipped a built-in OpenTelemetry tool window in IntelliJ, GoLand, PyCharm, and WebStorm 2026.2. VS Code has no first-party equivalent, which leaves a visible gap that Logline can fill.

### What users get

- **Zero-config ingestion.** Logline runs an OTLP/HTTP receiver on `127.0.0.1:4318`. Apps started by Logline servers, Logline tasks, or VS Code terminals automatically get `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME`, so instrumented apps send telemetry to Logline without code changes.
- **Logs and spans in one table.** OTLP log records become normal Logline events with `service`, `traceId`, `spanId`, severity, and attributes. Every existing feature works on them: query, chips, Analyze, export, and Copilot.
- **Trace view.** Click a `traceId` cell, or choose **Show trace** in an inspected event, to open a waterfall of every span in that trace across services. The trace's log events are interleaved at their timestamps, errors are highlighted, and the critical path is marked. This answers "why was this request slow?" without leaving the editor.
- **Correlation everywhere.** Plain JSON logs that include a `traceId` (from the existing alias list in `query.ts`) link to the same trace view, so services that log to stdout and services that export over OTLP join up.
- **Copilot tool.** `logline_get_trace` returns a redacted span tree plus logs, so an agent can answer "which service made this request slow?" directly.

### Design

- New `src/capture/otlp-receiver.ts` runs a Node `http` server bound to loopback only. It accepts `POST /v1/logs` and `POST /v1/traces` with `application/json` (OTLP JSON) and `application/x-protobuf`. For protobuf, ship a small generated decoder for the logs and traces messages only. That keeps bundle size down; avoid pulling in all of `protobufjs`.
- If port 4318 is taken, for example by a real collector, fall back to an ephemeral port and inject that port. Show the active endpoint in the toolbar's capture status.
- Inject environment variables through `ExtensionContext.environmentVariableCollection` for terminals, and merge them into the environment of `ProcessRunner` and the Logline task. Respect variables that the user has already set; Logline never overrides them.
- Spans live in a new bounded `SpanStore` keyed by `traceId`, capped at 20,000 spans and cleared with `LogStore`. `logline.otlp.showSpans` controls which spans also become table rows: `entry` (trace roots and incoming requests, the default), `all`, or `none`.
- The existing `logline.servers[].env` keeps working. The OTel variables are only defaults.
- The trace view is a new dialog in `src/webview/inspection`, rendered with the virtual-scrolling table primitives to handle traces with thousands of spans.
- Security: loopback only; requests with a browser `Origin` or a non-loopback `Host` header are refused (cross-site and DNS-rebinding protection); 16 MiB body and 64 MiB decompressed limits; and a trusted workspace requirement (already enforced by Logline).
- New settings: `logline.otlp.enabled` (default `false`), `logline.otlp.port`, `logline.otlp.injectEnvironment`, and `logline.otlp.showSpans`.

### Effort and risks

- About 3–4 weeks. The biggest pieces are the protobuf decoding and the trace waterfall UI.
- Risk: users who already run a collector on 4318. Mitigation: detect the conflict, never steal the port, and offer to forward ("tee") received data to an upstream endpoint later.
- Risk: memory. Spans are capped separately, and evicting spans first keeps logs available.
- Scope out of v1: metrics. Logs and traces cover the debugging workflow, and the Analyze view already shows rates and latency.

### Success metric

"OpenTelemetry" becomes a top Marketplace search term that leads to Logline. This is also the feature most likely to be featured in the VS Code release notes or extension spotlight, because it matches a JetBrains capability that VS Code lacks.

---

## 3. Live log lenses (log ↔ code)

### Pain

Logs and code are disconnected. Given a log line, finding the statement that printed it means grep-ing for a fragment of the message and hoping it wasn't built from variables. Given a log statement in the editor, you cannot tell whether it ran, how often, or what values it printed without running the app and searching the output. This is an IDE-only problem, and only an IDE extension can solve it.

### What users get

- **CodeLens above log statements**, shown only while Logline has retained matching events:
  `⚡ 132 hits · 4 errors · last 3s ago`
  Clicking it filters the Logs panel to exactly those events.
- **Hover** on a log statement shows the last three rendered values, for example `user 4812 logged in`, so you can see runtime values without a breakpoint.
- **Go to log statement** on any event, in the context menu and the inspection dialog, opens the line of code that produced it, even when there is no stack trace.
- **Gutter dots** in the editor for statements that logged errors in the current run, styled like coverage indicators.
- **Quiet statements.** A command lists log statements in the current file that *never* fired during the last run, which helps when you ask "why didn't my code reach this branch?"

### Design

- **Location sources, in order of confidence:**
  1. Exact metadata: the debug adapter output `source`/`line` from Feature 1, OTLP `code.filepath`/`code.lineno` attributes from Feature 2, and common logger fields (`caller`, `file`/`line`, Log4j `source`, `pino-caller`, zap `caller`).
  2. Template matching: index log call sites in workspace files and convert each format string into a matcher. Examples: `logger.info("user %s logged in")`, `log.info("user {} logged in")` for SLF4J, `` `user ${id} logged in` `` for JavaScript template literals, f-strings, `fmt.Printf`, and `slog.Info("msg", ...)`. Then match those templates against the message templates that `findPatterns` in `log-analysis.ts` already produces.
- New `src/core/log-sites.ts` is a pure, language-agnostic extractor with a regex table for each language. It has no VS Code dependency, so the module can be unit-tested like the rest of `src/core`.
- New `src/vscode/log-lens.ts` contains the `CodeLensProvider` and `HoverProvider`. It indexes lazily: open editors first, then a background scan with `workspace.findFiles` that respects `files.exclude` and `search.exclude` and has a file cap. Changes to documents update the index incrementally.
- `LogStore` gains a small `siteId → {count, errors, lastSeen, lastSamples[3]}` aggregate that updates during ingestion and is released on eviction, like the existing field reference counts. Lens refresh is debounced to `logline.refreshIntervalMs`.
- New setting: `logline.logLenses` with the values `off`, `codelens`, and `codelens+gutter` (default `codelens`).

### Effort and risks

- About 2–3 weeks. Most of the work is the language regex table and its tests.
- Risk: false matches for short, generic messages such as `"done"`. Mitigation: require a minimum template length or a distinguishing literal for a template match. Prefer exact metadata when it exists, and show the confidence level in the hover.
- Risk: performance in large monorepos. Mitigation: index open files plus files referenced by stack frames first, cap background indexing, and add a setting to scope indexing to specific folders.

### Success metric

This is the demo GIF moment: a log statement in the editor showing a live hit count as requests come in. It is highly shareable and has no direct equivalent in other VS Code log extensions.

---

## Considered, not chosen (yet)

- **Run diff ("what's new since last run").** Compare log patterns and error groups between two runs to answer "what did my change break?". It is cheap because runs and `findPatterns` already exist, and it is a strong candidate for the release after these three.
- **Container and Kubernetes sources.** A container picker that tails `docker compose` services or pods. It is useful, but `docker compose logs -f` already works with **Run Command**, and the Container Tools and Kubernetes extensions own that space.
- **Natural-language queries.** Copilot sharing already covers this, and adding a second AI entry point would dilute the feature.

## Launch checklist (applies to each feature)

- Guide card in `media/guide.html` and a highlight in `src/vscode/guide-content.ts`.
- A new 10–15 second segment in `media/demo.gif`, which is the main driver of Marketplace conversion.
- Marketplace keywords: add `opentelemetry`, `otel`, `traces`, `debug console`, and `codelens`. Change `categories` from `Other` to `Debuggers`, `Visualization`, and `Other` so the extension appears in category browsing.
- A short post on the VS Code Tips/Extensions community channels and r/vscode, built around the GIF.
