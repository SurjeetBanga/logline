# Roadmap: the next three features

Status: proposal · October 2026

The first roadmap ([roadmap.md](roadmap.md)) shipped in full. The code now covers debug capture, the OpenTelemetry receiver and trace view, and live log lenses. This proposal comes from reading the code, not the docs. It looks for workflows that the code still does not support, and for patterns that other log tools have already proven.

| # | Feature | Gap in the code today | Built from |
| --- | --- | --- | --- |
| 1 | **Run diff: "what changed since the last run?"** | Analysis covers one filter at a time. No module compares runs (`log-analysis.ts` has no comparison API, and the protocol has no message for one). | `findPatterns`, `groupErrors`, `analyzeEvents`, sessions/runs, log sites |
| 2 | **Watch rules: alerts and highlights** | Nothing tells you when an important log arrives unless the Logs panel is visible. `ViewNotifications` only redraws the webview. Rows have no rule-based colouring. | query engine (`query.ts`), ingestion, status bar, `window.show*Message` |
| 3 | **Docker Compose and container sources** | `docker compose logs -f` / `docker compose up` prefix every line with `service-1  \| `. `parseLogLine` then treats JSON lines as plain text: `api-1 \| {"level":"error",...}` is stored as `level: info`, with no fields and no source split. | `ProcessRunner`, `SessionRegistry`, `parseLogLine` |

Suggested order: 1, then 2, then 3. Run diff is the most distinctive feature and uses the most existing code. Watch rules make Logline useful even when the panel is hidden. Compose support is the smallest change and fixes data that is parsed incorrectly today.

---

## 1. Run diff: "what changed since the last run?"

### Pain

The most common question in the edit, run, check loop is "what did my change break?" Today you answer it from memory: you scan for errors and try to recall whether they appeared last time. Logline already keeps several runs of the same source (task runs, debug sessions, terminal commands, and server restarts), but it never compares them.

Hosted platforms treat this as a headline feature. Examples include Oracle Logging Analytics' *Compare* view, Datadog's log pattern comparison, and Sentry's "new issue in this release". No VS Code log tool offers it, and it fits the inner loop even better than it fits production, because "last run" is always one F5 away.

### What users get

- In the Runs tab, each run has a **Compare with previous run** action, and the Analyze view has a **Compare** toggle. Logline picks the baseline automatically: the previous run of the same source.
- The diff view has four sections:
  - **New**: error groups and log patterns that did not appear in the baseline. Each entry links to its first sample event and its log statement.
  - **Gone**: patterns that stopped appearing, such as "cache warmed" disappearing after a refactor.
  - **Changed volume**: patterns whose rate changed by more than 2× after normalizing for run duration, plus a p50/p95 latency comparison when `durationMs` is present.
  - **Log statements**: statements that fired in the baseline but not in this run, and the reverse. This uses log lens site IDs and answers "my change stopped this code path from running."
- **CodeLens delta.** While a comparison is active, the log lens shows `+12 vs last run` or `new`.
- **Copilot tool.** `logline_compare_runs` returns the same diff, redacted. "Why is my test failing now?" becomes a single tool call.

### Design

- New pure module `src/core/run-diff.ts`: `diffRuns(baseline: LogEvent[], current: LogEvent[]) → RunDiff`. It reuses `normalizeMessage` and `errorFingerprint` from `log-analysis.ts`. Export them, and do not copy them, so that grouping cannot drift between Analyze and the diff. The existing top-10 pattern cap does not apply here. Use a cap of 200 per section, ranked by how much each pattern changed.
- Normalize rates by run duration (`endedAt - startedAt`, or the first-to-last event span). Otherwise a 30-second run compared with a 5-minute run reports false "volume drops".
- New protocol messages: `{ type: 'runDiff'; sessionId; baselineSessionId? }` and the reply `{ type: 'runDiff'; diff }`. Validate them in `protocol/messages.ts` in the same way as `analysis`.
- Baseline choice: the most recent completed session with the same `serverId` (or `taskLabel` or debug configuration name) that started before the current one. The user can choose a different baseline from a dropdown.
- Retention caveat: if eviction removed part of the baseline, show "Baseline partially evicted" instead of reporting incorrect "Gone" entries. `SessionSummary.events` compared with the count actually retained gives this signal.
- Log-site deltas: `LogStore` already aggregates per site. Add a per-session key (`sessionId:siteId`) that is capped, using the same eviction bookkeeping.

### Effort and risks

- About 1.5–2 weeks. The core module is easy to unit-test, and most of the work is in the UI.
- Risk: noisy "new" patterns from IDs that `normalizeMessage` does not catch, such as UUIDs with dashes and ISO timestamps inside messages. Extend the normalizer and add tests. This also improves the current Patterns view.

### Success metric

"Compare with previous run" becomes the most-clicked action in the Runs tab. It is also the feature to demo: change a line, press F5, and the diff shows `NEW: TypeError at cart.ts:42`.

---

## 2. Watch rules: alerts and highlights

### Pain

Logline only helps while you are looking at it. With the panel collapsed, or while you work in a different editor group, an `UnhandledPromiseRejection` or a `status:5xx` goes unnoticed until something visibly breaks. Inside the panel, every row looks the same, so a deprecation warning you care about gets lost among a thousand info lines.

`lnav` has *watch expressions* (a query evaluated on every message that raises an event) and field highlights. IntelliJ's console offers "highlight and notify" filters through the Grep Console plugin. Datadog and Grafana build log monitors around the same idea. Logline already has the query language, so it needs only the trigger.

### What users get

- **Watch rules** are saved searches with an action. You create one from the search box (**Save as watch rule**) or with a right-click on a cell (**Watch this value**). Each rule has:
  - **Notify**: a VS Code notification with **Show** (opens the event), **Open log statement**, and **Mute 10 min**. Rules are rate-limited and coalesced, for example "`level:error service:api` matched 14 times in 5s".
  - **Badge**: a count on the Logs view badge (`WebviewView.badge`) and a status bar item such as `⚠ 3 new errors`, visible while the panel is hidden. Opening the panel clears the count.
  - **Highlight**: a row colour or left-border colour in the table (for example, all `requestId:abc123` rows in amber), using theme colours.
  - **Focus**: the panel opens and jumps to the event. Use it sparingly, for fatal errors only.
- **Built-in default:** one active rule, `level:error OR level:fatal`, set to *Badge* only. You get value without configuring anything and without unwanted pop-ups.
- Rules live in the `logline.watchRules` setting, so a team can commit them to `.vscode/settings.json`, for example "always notify on `ConnectionRefused`".
- Copilot: when sharing is on, `logline_wait_for_logs` can wait on a named watch rule ("tell me when the migration finishes").

### Design

- New `src/core/watch-rules.ts` compiles each rule's query once, using the existing parser in `query.ts`, and exposes `match(event) → ruleIds[]`. It runs in ingestion right after `LogStore.append`, and only for new events, so the cost is O(rules) per event. Cap the setting at 20 rules.
- New `src/vscode/watch-alerts.ts` owns notification throttling (at most one toast per rule every 10 s, with counts in between), the view badge, and the status bar item. Toast suppression respects `window.state.focused` and VS Code's Do Not Disturb mode.
- Highlights travel with snapshots as a `highlight?: string` per event. Compute it on the host so that the webview never re-parses queries. Add it to the event clone in `log-store.ts`, next to `location`.
- Settings validation follows `settings.ts` and `server-config.ts`: unknown fields are dropped, and invalid queries appear in **Manage watch rules** with the parser's error message.
- Privacy: notifications show the redacted, first-line message, using `redaction.ts`, because notifications can appear in screen shares.

### Effort and risks

- About 1.5 weeks.
- Risk: notification fatigue, which makes users disable the extension. Mitigation: the default rule is badge-only, throttling is strict, and every notification has **Mute**.
- Risk: ingestion throughput. Benchmark with `scripts/benchmark.mjs` and 20 rules. Queries are already compiled for snapshot filtering, so the cost should be small.

### Success metric

At least half of active users keep a non-default rule. Fewer issues say "I didn't notice the error".

---

## 3. Docker Compose and container sources

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

## Considered, not chosen (yet)

- **Interactive timeline.** Brushing a range on the Analyze charts would set `timestamp:[…]`. The charts in `webview/analysis/charts.ts` are display-only today. It is a good small follow-up after Run diff, which reuses the same charts.
- **Collapse repeated lines** (`×37` for identical consecutive messages). It is useful and cheap, but it is less important than the three above.
- **Bookmarks and notes on events**, saved with an investigation and exported to Markdown or Copilot. Strong for incident write-ups, but it needs a persistence design first.
- **Remote and SSH sources.** VS Code Remote already runs Logline on the remote host, so the main case is covered.
