import type { GuideStatus } from '../protocol/messages';

/**
 * User-facing release highlights. Keep this list short and curate it for the
 * guide; the complete history remains available in CHANGELOG.md.
 */
export interface GuideHighlight {
  title: string;
  text: string;
  section: string;
}
export interface GuideRelease {
  version: string;
  date: string;
  highlights: GuideHighlight[];
}

export const GUIDE_RELEASES: GuideRelease[] = [
  {
    version: '1.17.0',
    date: '2026-10-25',
    highlights: [
      {
        title: 'Add a connection in one form',
        text: 'Add Connection opens a Connection tab in the Logs panel: choose the service or database, test it, pick the log table with a preview of its rows, and name it. Nothing is saved until you add it.',
        section: 'connections',
      },
      {
        title: 'Edit a connection',
        text: 'Edit on a connection opens the same form filled in, to rename it, sign in again, or map another table. Its saved password stays while it points at the same server, and its runs stay with it.',
        section: 'connections',
      },
      {
        title: 'A rail as wide as you like',
        text: 'Drag the right edge of the Sources rail, or focus it and press Left or Right; Compare, Traces, and Metrics use the same width.',
        section: 'capture',
      },
    ],
  },
  {
    version: '1.16.0',
    date: '2026-10-24',
    highlights: [
      {
        title: 'Production logs next to your local run',
        text: 'Add a connection to search and tail Datadog, Postgres, MySQL and Aurora (with AWS IAM sign-in), MongoDB, or SQLite logs from the Sources rail, read-only.',
        section: 'connections',
      },
      {
        title: 'Is it fixed? Compare tells you',
        text: 'Compare lines production errors up with your newest local runs and marks each Reproduced, Fixed locally, Not seen locally, or New. Agents you allow can fetch and compare too.',
        section: 'compare',
      },
      {
        title: 'A panel built around your sources',
        text: 'The Sources rail lists every run and connection with Run, Stop, and Remove; Share with agent opens a panel of what agents read; and a one-minute tour shows you around.',
        section: 'capture',
      },
      {
        title: 'Faster with big logs',
        text: 'Logs are parsed and kept about a third faster, so a million-line import takes about 2 seconds, and Analyze, sorting while logs stream in, and autocomplete are faster too.',
        section: 'settings',
      },
    ],
  },
  {
    version: '1.15.0',
    date: '2026-10-16',
    highlights: [
      {
        title: 'See what your app asks the model',
        text: 'The AI calls tab lists LLM calls, tool executions, and agent runs from OpenTelemetry GenAI spans, with tokens, cache share, p95 latency, and each call’s conversation and tool results.',
        section: 'inspect',
      },
      {
        title: 'AI calls in traces and for agents',
        text: 'GenAI spans in the trace waterfall carry a token chip that opens the call, and agents read the same calls with logline_get_ai_calls, redacted.',
        section: 'share',
      },
      {
        title: 'Every view is a tab',
        text: 'Analyze, Traces, AI calls, Metrics, and Issues are tabs next to Logs, the toolbar is two rows, and terminal capture moved to the status bar at the bottom of the panel.',
        section: 'capture',
      },
    ],
  },
  {
    version: '1.14.0',
    date: '2026-10-10',
    highlights: [
      {
        title: 'Logs from your changes',
        text: 'My changes, next to the level filter, shows only logs from code you changed since the last commit, and combines with any search, such as level:error for the errors your edits caused.',
        section: 'search',
      },
      {
        title: 'Where a slow request spends its time',
        text: "The trace waterfall shows each span's self time and ranks the hotspots, log lenses show p50 and p95 durations, and Metrics lists OpenTelemetry metrics with their trends.",
        section: 'inspect',
      },
      {
        title: 'Agent skills and Show Status',
        text: 'Connect Claude Code or Codex also installs skills to verify a change, triage errors, and explain a slow request. Logline: Show Status lists what is on, off, or broken, with the fix for each.',
        section: 'share',
      },
    ],
  },
  {
    version: '1.13.0',
    date: '2026-10-04',
    highlights: [
      {
        title: 'Newest logs on top',
        text: 'New logs appear at the top. Scroll down to read and Live pauses so rows stay put; scroll back to the top to resume. Set logline.newestFirst to false for terminal order.',
        section: 'inspect',
      },
      {
        title: 'Analyze, then click through',
        text: 'Analyze opens with error rate and p95 latency, adds top values of fields like service and path, and every bar, value, pattern, and error group filters your logs to it.',
        section: 'analyze',
      },
      {
        title: 'Log doctor finds more',
        text: 'Log doctor flags failures logged at info, errors without a request id, and oversized events, and finds secrets and personal data in output from libraries, imports, and terminals too.',
        section: 'inspect',
      },
    ],
  },
  {
    version: '1.12.0',
    date: '2026-10-04',
    highlights: [
      {
        title: 'Share with Claude Code and Codex',
        text: "Run Logline: Connect Claude Code or Codex once. The agent then reads the logs you share through Logline's MCP server, with the same read-only tools and redaction as Copilot, and Stop sharing cuts it off too.",
        section: 'inspect',
      },
      {
        title: 'See who is reading',
        text: 'While sharing, the status line names the agents that read your logs, and stopping cuts every agent off at once, including waits in progress.',
        section: 'inspect',
      },
      {
        title: 'Cleaner Traces and runs',
        text: 'The Traces list gives operations room to read, and the run picker names every run by its command or task instead of an id.',
        section: 'inspect',
      },
    ],
  },
  {
    version: '1.11.0',
    date: '2026-10-03',
    highlights: [
      {
        title: 'See what each event links to',
        text: 'Rows show icons for their trace, the log statement behind them, and log doctor findings. Hover a row for Surrounding logs and Break here, and expand an event for every action, with unavailable ones explaining why.',
        section: 'inspect',
      },
      {
        title: 'Log issues next to your logs',
        text: 'Log issues in the toolbar lists what log doctor found, such as secrets, missing exceptions, and noisy statements, with Fix… to open the statement and its quick fixes and Show events to filter the table.',
        section: 'inspect',
      },
      {
        title: 'Faster in large workspaces',
        text: 'Log lenses match statements by their rarest word and subtract evicted events instead of recounting, so big repositories and full retention no longer slow the editor.',
        section: 'inspect',
      },
    ],
  },
  {
    version: '1.10.0',
    date: '2026-10-03',
    highlights: [
      {
        title: 'Capture more of your runs',
        text: 'Debug sessions, followed log files, and Docker Compose or Kubernetes output become sources, with one source per service and plain-text stack traces joined into one event.',
        section: 'capture',
      },
      {
        title: 'Follow requests across services',
        text: 'Start the local OpenTelemetry receiver, browse recent requests in the Traces list, and open a waterfall with every span and log of a trace.',
        section: 'inspect',
      },
      {
        title: 'Logs in your editor',
        text: 'Log lenses show live hits above logging calls, Break here on an event stops the debugger on a statement, and log doctor reports secrets, personal data, and missing exceptions in the Problems panel.',
        section: 'inspect',
      },
    ],
  },
  {
    version: '1.9.0',
    date: '2026-09-17',
    highlights: [
      {
        title: 'Scope sources and runs together',
        text: 'Use one accessible picker with Sources and Runs tabs to filter by server, task, terminal, imported source, or one command execution.',
        section: 'capture',
      },
      {
        title: 'Stop one active run',
        text: 'The Runs tab offers inline Stop actions for Logline-owned processes and VS Code tasks while externally captured terminal commands stay observe-only.',
        section: 'capture',
      },
      {
        title: 'Capture terminals more reliably',
        text: 'Already-open terminals are ready for their next command, completed empty runs are cleaned up, and the toolbar clearly shows Off, On, Capturing…, or Needs attention.',
        section: 'capture',
      },
    ],
  },
  {
    version: '1.8.0',
    date: '2026-09-15',
    highlights: [
      {
        title: 'Capture the terminal you already use',
        text: 'Turn Terminal capture: On once and run commands normally; new shell-integrated terminal output becomes searchable in Logs, with plain text shown as Unclassified when no level is marked.',
        section: 'capture',
      },
      {
        title: 'Share with agent',
        text: 'Confirm once to share retained sources and new runs in this window. Results are always redacted, but may still contain sensitive information. Choose specific runs from More actions to limit access.',
        section: 'share',
      },
      {
        title: 'Keep using your existing agent chat',
        text: 'While sharing, the button reads Stop sharing and the status bar says what is shared. Ask Copilot to check the logs through read-only Logline tools, share an expanded event’s exact run, and press Stop sharing when done.',
        section: 'share',
      },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-09-14',
    highlights: [
      {
        title: 'A visual quick reference',
        text: 'See capture, search, inspection, analysis, sharing, and retention at a glance with compact UI previews.',
        section: 'capture',
      },
      {
        title: 'Search chips stay in context',
        text: 'Applied terms become editable, removable chips; autocomplete, cell filters, and saved searches keep the active server and level selection together.',
        section: 'search',
      },
      {
        title: 'Safer inspection and exports',
        text: 'Browse-mode inspection, streaming exports, and redaction preserve context as logs change.',
        section: 'share',
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Faster, safer exports',
        text: 'Large JSON, JSONL, and CSV exports now stream in cancellable batches, with redaction and staged writes.',
        section: 'share',
      },
      {
        title: 'Search suggestions stay in context',
        text: "Autocomplete keeps your query prefix, escapes suggested values, and uses the selected source's index.",
        section: 'search',
      },
      {
        title: 'Inspect without losing your place',
        text: 'Changing filters, paging, sorting, or columns while inspecting an event returns cleanly to Browse mode.',
        section: 'inspect',
      },
    ],
  },
];

/**
 * A card in the guide: what a feature does and where to find it. `target` is
 * the id of the Logs panel control that Show me points at (a test keeps it in
 * step with the panel); `fallback` is shown instead while the target is hidden,
 * such as a connection's controls before a connection is selected. A card can
 * instead run a command or open a setting.
 */
export interface GuideCard {
  section: string;
  title: string;
  /** Where to find it, outermost first, such as ['Status bar', 'Capture']. */
  where: string[];
  text: string;
  example?: string;
  target?: string;
  fallback?: string;
  command?: string;
  setting?: string;
  /** A heading in docs/usage.md, by its anchor. */
  docs?: string;
}

export interface GuideSection {
  id: string;
  title: string;
  summary: string;
  /** Marked New in the guide's sidebar. */
  isNew?: boolean;
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'capture',
    title: 'Capture',
    summary: 'Bring a terminal, command, task, debug session, or app into the Logs panel.',
  },
  {
    id: 'connections',
    title: 'Connections',
    summary:
      'Search production logs in Datadog, Postgres, MySQL and Aurora, MongoDB, or SQLite next to your local runs. Every connection is read-only.',
    isNew: true,
  },
  { id: 'search', title: 'Search', summary: 'Turn a noisy stream into the few events you need.' },
  {
    id: 'inspect',
    title: 'Inspect and analyze',
    summary: 'Move from a row to the story around it, and see the patterns in what is retained.',
  },
  {
    id: 'traces',
    title: 'Traces and AI calls',
    summary: 'Follow requests across services, and read what your app asks the model.',
  },
  {
    id: 'compare',
    title: 'Compare with production',
    summary: 'See whether your local run reproduces a production failure, and whether your fix removes it.',
  },
  {
    id: 'share',
    title: 'Share with agents',
    summary: 'Let Copilot, Claude Code, or Codex read what you choose, redacted and read-only.',
  },
  {
    id: 'settings',
    title: 'Settings and memory',
    summary: 'Keep memory bounded, redact what you export, and see what Logline is doing.',
  },
];

export const GUIDE_CARDS: GuideCard[] = [
  {
    section: 'capture',
    title: 'Capture your terminal',
    where: ['Status bar', 'Capture'],
    text: 'Turn on Capture, then run commands as usual in a VS Code terminal. Their output becomes searchable here.',
    example: 'npm test',
    target: 'captureToggle',
    docs: 'capture-and-live-tail',
  },
  {
    section: 'capture',
    title: 'Run a command',
    where: ['Command Palette', 'Logline: Run Command'],
    text: 'Start a long-running process and stream its stdout and stderr into Logs.',
    example: 'npm run dev',
    command: 'logline.runCommand',
  },
  {
    section: 'capture',
    title: 'Your sources and runs',
    where: ['Sources rail'],
    text: 'Click a source to see only its logs; its runs appear beneath it. Point at one to run it again, stop it, or remove it with its logs.',
    target: 'sourceRail',
  },
  {
    section: 'capture',
    title: 'Save server commands',
    where: ['More actions', 'Manage servers…'],
    text: 'Save a label, command, working directory, and environment, with optional auto-start or JSON-only output.',
    example: 'jsonOnly: true',
    target: 'manage',
  },
  {
    section: 'capture',
    title: 'Capture a VS Code task',
    where: ['Command Palette', 'Logline: Convert VS Code Task to Logline'],
    text: 'Convert shell, process, launch, or terminal tasks while keeping their dependencies.',
    example: '"type": "logline"',
    command: 'logline.convertTask',
  },
  {
    section: 'capture',
    title: 'Debug sessions',
    where: ['Run and Debug', 'F5'],
    text: 'Debug Console output from every debugger streams in as its own source, and each restart is a new run.',
    example: 'logline.captureDebugSessions',
    setting: 'logline.captureDebugSessions',
  },
  {
    section: 'capture',
    title: 'Follow a file, Compose, or Kubernetes',
    where: ['Command Palette', 'Logline: Follow Log File'],
    text: 'Tail a log file like tail -F, or a Docker Compose project. Compose and kubectl logs --prefix output becomes one source per service.',
    example: 'kubectl logs --prefix',
    command: 'logline.followFile',
  },
  {
    section: 'capture',
    title: 'Receive OpenTelemetry',
    where: ['Status bar', 'OpenTelemetry'],
    text: 'Start a receiver on this machine. Instrumented apps you start from Logline, a debug session, or a new terminal send their logs, traces, and metrics to it.',
    example: 'http://127.0.0.1:4318',
    target: 'otlpStatus',
    docs: 'opentelemetry-and-traces',
  },
  {
    section: 'connections',
    title: 'Add a connection',
    where: ['Sources rail', '+'],
    text: 'A Connection tab opens with a form: choose Datadog, Postgres, MySQL, MongoDB, or SQLite, test it, and pick the log table with a preview of its rows, or none to only run queries. Passwords and keys stay in VS Code secret storage, never in settings; Aurora and RDS can sign in with AWS IAM instead.',
    target: 'railAddConnection',
    fallback: 'sourceRail',
    docs: 'connections-datadog-postgres-mysql-mongodb-and-sqlite',
  },
  {
    section: 'connections',
    title: 'Edit a connection',
    where: ['Sources rail', 'Connection', 'Edit'],
    text: 'Opens the same form filled in and tests it, to rename the connection, sign in again, or choose another table and columns. A saved password is kept while the connection points at the same server; its runs stay with it.',
    command: 'logline.editConnection',
    target: 'sourceRail',
    docs: 'connections-datadog-postgres-mysql-mongodb-and-sqlite',
  },
  {
    section: 'connections',
    title: 'Search production',
    where: ['Select a connection', 'Run'],
    text: 'Your search becomes the store’s own query, shown before it runs. Each Run is a run of its own, so earlier results stay to compare.',
    example: 'service:checkout level:error',
    target: 'connectionRun',
    fallback: 'sourceRail',
  },
  {
    section: 'connections',
    title: 'Tail as it happens',
    where: ['Connection controls', 'Tail'],
    text: 'New rows and logs appear as they arrive. Stop the tail from the connection’s row in the rail.',
    target: 'connectionTail',
    fallback: 'sourceRail',
  },
  {
    section: 'connections',
    title: 'Run SQL',
    where: ['Connection controls', 'Run SQL…'],
    text: 'Run a read-only SELECT on a database. Columns named like a time, level, or message are read as those.',
    example: "SELECT * FROM app_logs WHERE severity = 'error'",
    target: 'connectionSql',
    fallback: 'sourceRail',
  },
  {
    section: 'connections',
    title: 'Open a Datadog link',
    where: ['Connection controls', 'Open link…'],
    text: 'Paste a Log Explorer link to fetch its search and, for a log with a trace, every log of that trace.',
    target: 'connectionLink',
    fallback: 'sourceRail',
  },
  {
    section: 'connections',
    title: 'Chart a metric',
    where: ['Metrics tab', 'Metric query'],
    text: 'Chart a Datadog metric or a SELECT of time and value, then drag across a spike to fetch the logs from that window.',
    example: 'avg:trace.http.request.duration{*}',
    target: 'metricInput',
    fallback: 'metrics',
    docs: 'metrics-from-connections',
  },
  {
    section: 'search',
    title: 'Build a query',
    where: ['Search box'],
    text: 'Combine free text, phrases, negation, OR, field filters, numeric ranges, regular expressions, and time windows. Applied terms become chips you can edit.',
    example: 'status:5xx last:15m',
    target: 'search',
  },
  {
    section: 'search',
    title: 'Search syntax',
    where: ['Search box', 'Syntax'],
    text: 'Every operator, with an example of each.',
    example: 'message:/time.?out/i',
    target: 'searchHelp',
  },
  {
    section: 'search',
    title: 'Filter by level',
    where: ['Filter row', 'All levels'],
    text: 'Choose any combination of Trace, Debug, Info, Warn, Error, Fatal, and Unclassified.',
    target: 'levelButton',
  },
  {
    section: 'search',
    title: 'Filter from a value',
    where: ['Table', 'right-click a value'],
    text: 'Include or exclude a value without retyping it. Your other filters stay.',
    example: 'service:"checkout"',
    target: 'eventsTable',
  },
  {
    section: 'search',
    title: 'Reuse a search',
    where: ['Search box', 'Saved searches'],
    text: 'Save the current query, source, and levels, and apply them again later.',
    target: 'searchTools',
  },
  {
    section: 'search',
    title: 'Logs from your changes',
    where: ['Filter row', 'My changes'],
    text: 'In a git repository, keep only logs from code you changed since the last commit.',
    example: 'level:error changed:true',
    target: 'changedOnly',
    fallback: 'search',
  },
  {
    section: 'inspect',
    title: 'Live and Browse',
    where: ['Filter row', 'Live'],
    text: 'Live keeps the newest rows on top. Scroll down to read and rows hold still; scroll back to the top to follow again.',
    target: 'follow',
  },
  {
    section: 'inspect',
    title: 'Expand an event',
    where: ['Table', 'click a message'],
    text: 'Read its formatted payload and exceptions, open the line that logged it, and see the logs around it from the same run.',
    target: 'eventsTable',
  },
  {
    section: 'inspect',
    title: 'Analyze the filter',
    where: ['Analyze tab'],
    text: 'Error rate and latency at a glance, volume over time, status codes, top values, patterns, and error groups. Click any of them to filter to it.',
    target: 'analyze',
  },
  {
    section: 'inspect',
    title: 'Choose columns',
    where: ['Filter row', 'Columns'],
    text: 'Show detected or custom fields. Drag headers to reorder and dividers to resize; click a header to sort.',
    example: 'method · path · status',
    target: 'fieldsButton',
  },
  {
    section: 'inspect',
    title: 'Jump between logs and code',
    where: ['Editor', 'CodeLens above a log call'],
    text: 'Log statements show how often they fired and their recent values. Click the CodeLens to filter Logs.',
    example: 'logline.logLenses',
    setting: 'logline.logLenses',
  },
  {
    section: 'inspect',
    title: 'Break when it logs',
    where: ['More actions', 'Break on matching logs'],
    text: 'Pause a debug session right after it logs anything that matches your filter.',
    target: 'breakOnLogs',
  },
  {
    section: 'inspect',
    title: 'Fix risky log statements',
    where: ['Issues tab'],
    text: 'Log doctor flags statements that logged secrets or personal data, dropped an exception, or flood the logs, with quick fixes.',
    command: 'logline.showLogHealth',
  },
  {
    section: 'traces',
    title: 'Follow a request',
    where: ['Traces tab'],
    text: 'Recent requests, then every span across services as a waterfall, with the logs that share its trace id. Where the time went ranks the slowest work.',
    target: 'traces',
    docs: 'opentelemetry-and-traces',
  },
  {
    section: 'traces',
    title: 'Read AI calls',
    where: ['AI calls tab'],
    text: 'Every LLM call, tool execution, and agent run with its model, tokens, and latency, and each call’s conversation.',
    example: 'gen_ai.*',
    target: 'aiCalls',
    fallback: 'traces',
  },
  {
    section: 'traces',
    title: 'Watch metrics',
    where: ['Metrics tab'],
    text: 'OpenTelemetry metrics with each series’ latest value and trend, next to metric queries you watch on a connection.',
    target: 'metrics',
    fallback: 'otlpStatus',
  },
  {
    section: 'compare',
    title: 'Compare with local',
    where: ['Connection controls', 'Compare with local'],
    text: 'Line up a production run’s errors with your newest local runs, matched by message across machines.',
    target: 'compare',
    fallback: 'sourceRail',
    docs: 'compare-production-with-local-runs',
  },
  {
    section: 'compare',
    title: 'What each status means',
    where: ['Compare tab'],
    text: 'Reproduced: in production and your newest run. Fixed locally: gone from your newest run. Not seen locally: production only. New: only in your newest run.',
  },
  {
    section: 'share',
    title: 'Share with agent',
    where: ['Top row', 'Share with agent'],
    text: 'Share what is captured in this window until you stop. Common credentials are redacted, and agents cannot run or stop anything.',
    target: 'shareAgent',
    docs: 'claude-code-codex-and-other-mcp-clients',
  },
  {
    section: 'share',
    title: 'Choose what agents read',
    where: ['Share with agent', '▾'],
    text: 'Share everything, or only the runs you pick. Expanding an event also shares its exact run.',
    target: 'shareMenuButton',
  },
  {
    section: 'share',
    title: 'Connect Claude Code or Codex',
    where: ['Share with agent', '▾', 'Connect…'],
    text: 'Register Logline with an agent once. It also gets skills such as one that checks a change in the logs it produces.',
    example: '/logline-verify',
    target: 'shareMenuButton',
  },
  {
    section: 'share',
    title: 'Let agents fetch production logs',
    where: ['Share with agent', '▾', 'Production access'],
    text: 'Allow a connection, and agents you share with can fetch its logs and check that a fix removed an error.',
    target: 'shareMenuButton',
  },
  {
    section: 'share',
    title: 'Export or copy',
    where: ['More actions', 'Export logs…'],
    text: 'Save JSON Lines, JSON, CSV, or AI context Markdown with the current source, run, and filters, redacted by default.',
    example: 'AI context (Markdown)',
    target: 'export',
  },
  {
    section: 'share',
    title: 'Import offline logs',
    where: ['More actions', 'Import logs…'],
    text: 'Load JSON, JSONL, CSV, or plain text into a source of its own for searching and analysis.',
    target: 'import',
  },
  {
    section: 'settings',
    title: 'Memory',
    where: ['Status bar', 'memory meter'],
    text: 'Logs stay within a memory budget, oldest first out. The meter’s panel shows what was received, kept, and discarded.',
    example: '50,000 events · 100 MiB',
    target: 'counts',
  },
  {
    section: 'settings',
    title: 'Redact what you export',
    where: ['Settings', 'Agents and privacy'],
    text: 'Common credentials and secret-like fields are redacted by default. Add your own field names and replacement text.',
    example: '[REDACTED]',
    setting: 'logline.redactExports',
  },
  {
    section: 'settings',
    title: 'Keep logs on disk',
    where: ['Settings', 'Memory and disk'],
    text: 'Also write captured logs to .logline/latest.log, rolled over at a size you choose.',
    example: '.logline/latest.log',
    setting: 'logline.persistLogs',
  },
  {
    section: 'settings',
    title: 'Status and troubleshooting',
    where: ['Status bar', '✓'],
    text: 'What Logline is doing in this window, with a fix for anything off or broken.',
    target: 'statusIcon',
  },
];

/** Keyboard shortcuts in the Logs panel, for the guide's Keyboard section. */
export const GUIDE_KEYS: [keys: string, action: string][] = [
  ['← →', 'Move between tabs'],
  ['↑ ↓  Home  End', 'Move between sources and runs in the rail, or items in a menu'],
  ['Delete', 'Remove the focused source in the rail'],
  ['Enter', 'Apply the filter you typed'],
  ['Escape', 'Close a menu, panel, or surrounding logs'],
  ['Arrow keys in the table', 'Move between cells; Enter opens a cell’s actions'],
];

/** How far someone has got, for the guide's Get started steps. */
export interface GuideProgress {
  captured: boolean;
  searched: boolean;
  shared: boolean;
}

export const latestGuideRelease = GUIDE_RELEASES[0];
export const GUIDE_STATE_KEY = 'logline.guide.lastSeenVersion';

export function guideStatus(lastSeenVersion: string | undefined): GuideStatus {
  return { version: latestGuideRelease.version, unread: lastSeenVersion !== latestGuideRelease.version };
}

/** The guide's new sections someone has opened, for the release that marked them new. */
export const GUIDE_SEEN_KEY = 'logline.guide.seenSections';
export interface GuideSeen {
  version: string;
  sections: string[];
}

/** The sections still to show as New: new in this release, and not opened since it came out. */
export function unseenNewSections(seen: Partial<GuideSeen> | undefined): string[] {
  const opened = seen?.version === latestGuideRelease.version && Array.isArray(seen.sections) ? seen.sections : [];
  return GUIDE_SECTIONS.filter((section) => section.isNew && !opened.includes(section.id)).map((section) => section.id);
}

/** What to store once a section is opened; a section not new in this release changes nothing. */
export function markSectionSeen(seen: Partial<GuideSeen> | undefined, id: string): GuideSeen | undefined {
  if (!GUIDE_SECTIONS.some((section) => section.isNew && section.id === id)) return undefined;
  const current = seen?.version === latestGuideRelease.version && Array.isArray(seen.sections) ? seen.sections : [];
  if (current.includes(id)) return undefined;
  return { version: latestGuideRelease.version, sections: [...current, id] };
}
