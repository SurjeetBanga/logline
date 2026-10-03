# Roadmap: the next three features

Status: proposal · October 2026

The first roadmap ([roadmap.md](roadmap.md)) shipped in full. The code now covers debug capture, the OpenTelemetry receiver and trace view, and live log lenses. This proposal has a sharper goal: **build things that neither VS Code nor IntelliJ IDEA supports**, so that both editor teams have a reason to notice.

What the editors ship today (October 2026):

- **VS Code.** The Output panel and Debug Console treat program output as plain text with a substring filter. The request for a structured logging console ([microsoft/vscode#185904](https://github.com/microsoft/vscode/issues/185904)) and the Debug Console filter request ([#93750](https://github.com/microsoft/vscode/issues/93750)) are still open. Breakpoints can be conditional or logpoints, but nothing pauses the debugger *because of what the program logged*.
- **IntelliJ IDEA 2026.2.** The new OpenTelemetry plugin adds a Logs table, traces, and a service map, but only for OTLP data. The Run console is still text with a basic filter. Breakpoints, logpoints, and exception breakpoints exist, but there is no breakpoint triggered by log content. The integrated MCP server exposes run configurations and the debugger, but no structured log history.
- **Neither editor** checks log statements against what they actually logged. IntelliJ's logging inspections are static, cover only Java and Kotlin, and target performance. CodeQL and Bearer detect sensitive logging in CI by guessing from variable names. VS Code has no logging diagnostics. None can say "this line logged a JWT 37 times in your last run".

| # | Feature | Why neither IDE has it | VS Code API it showcases |
| --- | --- | --- | --- |
| 1 | **Docker Compose and container sources** | Both IDEs show Compose output as prefixed text. Logline gets it wrong today too (see below). | `ProcessRunner`, sources |
| 2 | **Log breakpoints: "break when this is logged"** | Both IDEs break on *code* (lines, exceptions, conditions), never on *output*. | `debug.addBreakpoints`, `DebugAdapterTracker`, DAP `pause` |
| 3 | **Log doctor: diagnostics backed by runtime evidence** | IDE and CI log checks are static guesses. Logline has seen the actual output of each statement. | `DiagnosticCollection`, `CodeActionProvider`, LM tools |

Suggested order: 1, then 2, then 3. Compose is the smallest change and fixes data that is parsed incorrectly today. Log breakpoints is the "how did nobody build this?" demo. Log doctor turns the same event-to-statement mapping into security and cost findings with one-click fixes.

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

## 3. Log doctor: diagnostics on log statements, backed by what they actually logged

### Pain

Logging mistakes are expensive and hard to see from the code:

- **Secrets and personal data in logs.** A request object, a token, an email address, or a card number gets interpolated into a message. The code looks harmless (`log.info("auth ok", ctx)`), but the output is not. This is [CWE-532](https://codeql.github.com/codeql-query-help/java/java-sensitive-log/), and it is a common cause of security advisories.
- **Noisy statements.** One debug-level statement inside a loop produces most of the log volume, which raises cost and buries the useful lines. Teams usually find it on the bill, through a log pipeline vendor, long after the code shipped.
- **Unstructured logging.** Values concatenated into message strings cannot be filtered or charted, by Logline or by any production log tool.
- **Errors without their exception.** `log.error("payment failed")` inside a `catch` that has an `err` in scope loses the stack trace that would have explained the failure.

What exists today is all **static**:

- IntelliJ's logging inspections, such as [string concatenation in a log call](https://jetbrains.com/help/inspectopedia/StringConcatenationArgumentToLogCall.html), cover Java and Kotlin, and target performance.
- CodeQL and Bearer flag sensitive logging in CI by guessing from variable names. That produces false positives, and it misses secrets hidden inside objects.
- VS Code has no logging diagnostics at all.

None of them knows what the program *actually logged*. Logline does: it maps every event to the statement that produced it.

### What users get

- **Problems with proof.** Diagnostics appear on log statements in the editor and the Problems panel, with evidence from captured runs. For example:
  - `⚠ Logged a JWT in 37 events in the last run (field ctx.headers.authorization). Last seen 2 min ago.`
  - `ⓘ 61% of all log lines in this run (48,210 events, ~3.1k/s). Called inside a loop.`
  - `ⓘ 3 values are interpolated into the message: userId, orderId, total. Log them as fields to make them searchable.`
  - `⚠ Error logged without the caught exception 'err'. No stack trace was recorded (12 events).`
- **Quick fixes** (Ctrl+.), language and logger aware:
  - **Sensitive data**: remove the argument, wrap it in a mask, or add the path to the logger's redaction config (for example pino `redact: ['req.headers.authorization']`).
  - **Noise**: lower the level (`info` → `debug`), or add a sampling or once-per-N guard.
  - **Unstructured**: convert to structured fields: pino `logger.info({ userId }, 'user logged in')`, Python `extra=` or structlog key-values, SLF4J placeholders or key-value pairs, Go `slog` attributes.
  - **Missing exception**: pass the caught error to the call.
  - **Suppress**: add `// logline-ignore: secret` for intentional cases.
  - **Fix with Copilot**: for cases a rule cannot fix safely.
- **Log health report.** **Logline: Show Log Health** lists every finding in the workspace, ranked by severity and volume, with a one-line summary such as "2 statements logged secrets, 3 statements produce 80% of volume". It can be copied as Markdown into a PR or issue.
- **Proof without leaking.** The evidence never repeats the secret. It shows the type (JWT, AWS key, email, card number), the field path, a masked preview (`eyJh…[JWT]`), and a link to the events, which stay redacted in exports and agent tools as they are today.

### Design

- **New pure module `src/core/log-findings.ts`.** It runs over events per log statement, using the attribution that `LogSiteTracker` in `log-sites.ts` already performs during ingestion, and keeps a small, bounded aggregate per statement: counts per finding type, field paths, the first and last event IDs, and masked previews only.
- **Detectors**:
  - **Sensitive values**: value-shape detectors in addition to the existing key-name rules in `redaction.ts`: JWT, `Bearer` tokens, AWS, GCP, GitHub and Slack key prefixes, PEM private keys, emails, and card numbers checked with Luhn. All regular expressions must be anchored and linear, as required by the earlier log lens performance fix. Share the detectors with `redaction.ts` so that exports also redact these values, which improves today's key-only redaction.
  - **Volume**: a statement's share of events in the run, plus its peak rate. Detect "inside a loop" by looking for an enclosing `for`/`while`/`forEach` in the document symbols or the extracted range of the statement.
  - **Unstructured**: the log lens template has interpolation placeholders (`${x}`, f-string `{x}`, `+ x +`, `%s`) and the matched events carry no structured fields for them.
  - **Missing exception**: an error-level event with no exception block (`exceptions.ts`), from a statement inside a `catch`/`except` block that does not reference the caught identifier.
- **New `src/vscode/log-diagnostics.ts`.** It contains a `DiagnosticCollection` keyed by statement location, refreshed with the same debounce as lenses, and a `CodeActionProvider` with fix builders per logger:
  - First release: JS/TS (console, pino, winston), Python `logging`, and Java SLF4J.
  - Go `slog` and others get diagnostics without auto-fixes.
- **Settings**: `logline.logDiagnostics` (`off` | `security` | `all`, default `security`), and per-category severity overrides.
- **Workspace trust and privacy.** Findings come only from data already in the local store and are never sent anywhere. The masked previews are created at detection time, so raw secrets are never copied into diagnostic messages.
- **Copilot**: a `logline_log_findings` tool returns findings (masked), so an agent can be asked to "fix all logging issues in this PR".

### Effort and risks

- About 2–3 weeks. Detectors and diagnostics take about 1 week, and the quick-fix builders take the rest, mostly tests per logger.
- Risk: false positives, for example emails that are legitimately logged in a dev environment. Mitigation: categories can be turned off, there is a per-statement ignore comment, and the default `security` level covers only high-confidence secrets (JWT, keys, private keys, cards that pass Luhn).
- Risk: incorrect automatic fixes. Mitigation: offer rule-based fixes only for recognized logger call shapes, and fall back to **Fix with Copilot** with the evidence attached.

### Success metric

The demo: run the app, and a yellow squiggle appears under `log.info("auth ok", ctx)` with "logged a JWT 37 times". Press Ctrl+. and choose **Add to pino redact paths**. On the next run, the squiggle is gone. It is a security story with proof, which static analyzers cannot provide. It also fits the security and diagnostics narrative that both editor teams promote.

---

## Considered, not chosen

- **Run diff**, **watch rules**, **investigation notebooks**, and **log replay debugger** (from earlier drafts of this proposal) were set aside in favour of the three features above.
- **An MCP server for logs.** It would make logs available to Claude Code, Cursor, and other agents, not only Copilot. It is useful, but JetBrains' built-in MCP server already exposes run and debugger context, so it is less distinctive. It is still a good follow-up for the agent audience.
- **Replay a request from its trace** (rebuild an `.http` request from span attributes, resend it, and compare the new trace with the old one). This is a strong demo, but OTLP spans rarely carry request bodies or headers, so it would only work for simple GETs.
