# Roadmap: the next three features

Status: proposal · October 2026

The first roadmap ([roadmap.md](roadmap.md)) shipped in full. The code now covers debug capture, the OpenTelemetry receiver and trace view, and live log lenses. This proposal has a sharper goal: **build things that neither VS Code nor IntelliJ IDEA supports**, so that both editor teams have a reason to notice.

What the editors ship today (October 2026):

- **VS Code.** The Output panel and Debug Console treat program output as plain text with a substring filter. The request for a structured logging console ([microsoft/vscode#185904](https://github.com/microsoft/vscode/issues/185904)) and the Debug Console filter request ([#93750](https://github.com/microsoft/vscode/issues/93750)) are still open. Breakpoints can be conditional or logpoints, but nothing pauses the debugger *because of what the program logged*.
- **IntelliJ IDEA 2026.2.** The new OpenTelemetry plugin adds a Logs table, traces, and a service map, but only for OTLP data. The Run console is still text with a basic filter. Breakpoints, logpoints, and exception breakpoints exist, but there is no breakpoint triggered by log content. The integrated MCP server exposes run configurations and the debugger, but no structured log history.
- **Neither editor** can debug *after the fact* from ordinary logs. Replay debugging exists only for one runtime or one product at a time: Undo for Java (a paid recorder, Linux JVM only), Temporal (workflow histories), and Salesforce's Apex Replay Debugger (Apex debug logs). Nothing turns the logs and traces that every app already produces into a debug session you can step through.

| # | Feature | Why neither IDE has it | VS Code API it showcases |
| --- | --- | --- | --- |
| 1 | **Docker Compose and container sources** | Both IDEs show Compose output as prefixed text. Logline gets it wrong today too (see below). | `ProcessRunner`, sources |
| 2 | **Log breakpoints: "break when this is logged"** | Both IDEs break on *code* (lines, exceptions, conditions), never on *output*. | `debug.addBreakpoints`, `DebugAdapterTracker`, DAP `pause` |
| 3 | **Log replay debugger** | Replay debugging in both IDEs needs a runtime-specific recorder. Neither can replay plain logs. | Inline `DebugAdapter`, DAP `stepBack` / `reverseContinue`, decorations |

Suggested order: 1, then 2, then 3. Compose is the smallest change and fixes data that is parsed incorrectly today. Log breakpoints is the "how did nobody build this?" demo, and it lays the groundwork for feature 3: both rely on mapping events to log statements and on debugger integration. The replay debugger is the largest feature and is the 2.0 headline.

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

## 3. Log replay debugger: step through a request that already happened

### Pain

The hardest bugs are the ones you cannot reproduce: a failure in CI, on a teammate's machine, in staging, or in a production log someone pasted into an issue. All you have are logs. Reading them means jumping between a wall of text and the source code, working out which line printed each message and in which order, and keeping the values in your head.

Time-travel debuggers solve this, but only after recording the process with a runtime-specific tool. Examples are Undo for Java (paid, Linux JVM only), rr, and WinDbg TTD. Product-specific replay debuggers exist for Temporal workflows and Salesforce Apex. None of them work with the logs and traces an ordinary app *already* produces, in any language, from any source. Neither VS Code nor IntelliJ can do it.

Logline already has the pieces: it maps events to the exact log statement (log lenses), groups events by request (trace and request IDs), and orders them across services (spans). Feature 2 adds debugger integration. Put together, a request's logs can become a debug session.

### What users get

- **Replay this request.** Choose **Replay in debugger** on any event, trace, or filter result. VS Code's own debug UI starts a session called "Logline replay". There is no new panel to learn.
- **Stepping moves through log statements.** The editor opens at the statement that produced the first event, with the familiar yellow current-line highlight.
  - **Step Over** (F10) moves to the next event in the request.
  - **Step Back** and **Reverse Continue** go backwards, because DAP supports them.
  - **Continue** runs to the next breakpoint.
- **Real breakpoints work.** A breakpoint on a log statement, or on any line inside a function that logged, stops the replay there. Conditional breakpoints evaluate against the event's fields, for example `status >= 500` or `userId == "4812"`. Log breakpoints from feature 2 work in replay too, so the same breakpoint works live and after the fact.
- **The Variables pane shows what was logged.**
  - **Event**: message, level, and timestamp.
  - **Fields**: every structured field, nested.
  - **Exception**: parsed causes.
  - **Request so far**: values seen earlier in the same request.
  - Inline value decorations show the logged values next to the code, as VS Code does in a live session.
- **The Call Stack pane shows the request path.** With traces, each frame is a span (`gateway → orders-api → payments → db`), and selecting one jumps to its first log statement. Without traces, it shows the stack frames from an attached exception, or the single source.
- **Watch expressions** evaluate against the replay state, for example `fields.cart.total`.
- **Works on imported logs.** Import a production log file, check out the matching commit, and replay. This is post-mortem debugging without having reproduced the bug.
- **Gaps are visible.** Between two log statements, the editor dims the code that ran without logging and shows "no events between these lines". The replay never pretends to know more than the logs say.

### Design

- **An inline debug adapter.** New `src/vscode/replay/adapter.ts` implements DAP in-process through `vscode.debug.registerDebugAdapterDescriptorFactory('logline-replay', …)` returning a `DebugAdapterInlineImplementation`. The debug type is contributed in `package.json`, with no launch.json needed: the command starts the session with `debug.startDebugging(undefined, { type: 'logline-replay', … })`.
  - Capabilities: `supportsStepBack`, `supportsConditionalBreakpoints`, `supportsHitConditionalBreakpoints`, `supportsEvaluateForHovers`, and `supportsRestartRequest`.
  - Requests: `stackTrace`, `scopes`, `variables`, `evaluate`, `next`, `stepBack`, `continue`, `reverseContinue`, and `setBreakpoints`. There is one thread per service (or per run) when the replay spans several.
- **Timeline construction.** New pure module `src/core/replay.ts`: `buildTimeline(events, spans?) → Step[]`.
  - Each step is `{ eventId, location, spanPath, values }`. Events are ordered by timestamp with `event-order.ts` tie-breaks, and the request is found through trace, span, or request ID fields.
  - Locations come from `eventLocation` (debugger, OTel `code.*`, logger caller fields) first, then from `LogSiteIndex.match`.
  - Steps without a resolvable location are kept with `location: undefined`. The UI shows them as "unattributed" in a virtual `logline-replay:` document instead of skipping them.
- **Breakpoint semantics.** A breakpoint hits a step when its line is the step's statement, *or* when it lies inside the same enclosing function as the step's statement and before it.
  - Function ranges come from `vscode.executeDocumentSymbolProvider`, with a line-proximity fallback.
  - Conditions are evaluated by a small, safe expression evaluator over the step's values: comparisons, `&&`, `||`, and field paths. It never uses `eval`. The same evaluator powers `evaluate` for watches and hovers.
- **Values.** Each step's values are the event's fields plus the placeholder values extracted from the message using its matched template (the same template matching that log lenses and feature 2's `site-conditions.ts` use). For example, `user 4812 logged in` from `` `user ${id} logged in` `` gives `id = 4812`.
- **Code drift.** If the file changed since the logs were written, a log statement's line may have moved. Re-match by template within the file. If a step cannot be mapped, mark it "statement not found in this version" and offer **Check out commit…** when the logs carry a version or commit field.
- **Copilot.** A `logline_replay_steps` tool returns the same timeline (redacted), so an agent can explain a failed request step by step and point at the exact lines involved.

### Effort and risks

- About 3–4 weeks. The DAP adapter is mostly glue. Building the timeline, extracting values from templates, and mapping breakpoints to functions take most of the time.
- Risk: users expect line-by-line stepping. Mitigation: name it clearly ("steps move between log statements"), dim unlogged code, and show the gap message. It reads as "replaying evidence", not "pretending to execute".
- Risk: sparse logs make poor replays. This is also an opportunity: the "no events between these lines" hint, plus **Show Log Statements That Have Not Logged**, shows exactly where adding one log line would make the next replay clearer.
- Risk: concurrent requests interleave in one stream. Mitigation: replay one request at a time when a trace or request ID exists. Otherwise, replay the filter result in timestamp order and warn that requests may interleave.

### Success metric

The demo: a teammate pastes a failing request's logs into an issue. You import them, click **Replay in debugger**, and press F10 through the services until the exception, with values inline in the editor. Neither VS Code nor IntelliJ can do this, it works for every language, and it uses VS Code's own debugger UI. That makes it the strongest candidate for attention from both editor teams.

---

## Considered, not chosen

- **Run diff**, **watch rules**, and **investigation notebooks** (from earlier drafts of this proposal) were set aside in favour of the three features above.
- **An MCP server for logs.** It would make logs available to Claude Code, Cursor, and other agents, not only Copilot. It is useful, but JetBrains' built-in MCP server already exposes run and debugger context, so it is less distinctive. It is still a good follow-up for the agent audience.
- **Replay a request from its trace** (rebuild an `.http` request from span attributes, resend it, and compare the new trace with the old one). This is a strong demo, but OTLP spans rarely carry request bodies or headers, so it would only work for simple GETs.
