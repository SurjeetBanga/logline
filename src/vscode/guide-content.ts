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
    version: '1.13.0',
    date: '2026-10-04',
    highlights: [
      { title: 'Newest logs on top', text: 'New logs appear at the top. Scroll down to read and Live pauses so rows stay put; scroll back to the top to resume. Set logline.newestFirst to false for terminal order.', section: 'inspect' },
      { title: 'Analyze, then click through', text: 'Analyze opens with error rate and p95 latency, adds top values of fields like service and path, and every bar, value, pattern, and error group filters your logs to it.', section: 'analyze' },
      { title: 'Log doctor finds more', text: 'Log doctor flags failures logged at info, errors without a request id, and oversized events, and finds secrets and personal data in output from libraries, imports, and terminals too.', section: 'inspect' }
    ]
  },
  {
    version: '1.12.0',
    date: '2026-10-04',
    highlights: [
      { title: 'Share with Claude Code and Codex', text: 'Run Logline: Connect Claude Code or Codex once. The agent then reads the logs you share through Logline\'s MCP server, with the same read-only tools, redaction, and Sharing · Stop as Copilot.', section: 'inspect' },
      { title: 'See who is reading', text: 'While sharing, the status line names the agents that read your logs, and stopping cuts every agent off at once, including waits in progress.', section: 'inspect' },
      { title: 'Cleaner Traces and runs', text: 'The Traces list gives operations room to read, and the run picker names every run by its command or task instead of an id.', section: 'inspect' }
    ]
  },
  {
    version: '1.11.0',
    date: '2026-10-03',
    highlights: [
      { title: 'See what each event links to', text: 'Rows show icons for their trace, the log statement behind them, and log doctor findings. Hover a row for Surrounding logs and Break here, and expand an event for every action, with unavailable ones explaining why.', section: 'inspect' },
      { title: 'Log issues next to your logs', text: 'Log issues in the toolbar lists what log doctor found, such as secrets, missing exceptions, and noisy statements, with Fix… to open the statement and its quick fixes and Show events to filter the table.', section: 'inspect' },
      { title: 'Faster in large workspaces', text: 'Log lenses match statements by their rarest word and subtract evicted events instead of recounting, so big repositories and full retention no longer slow the editor.', section: 'inspect' }
    ]
  },
  {
    version: '1.10.0',
    date: '2026-10-03',
    highlights: [
      { title: 'Capture more of your runs', text: 'Debug sessions, followed log files, and Docker Compose or Kubernetes output become sources, with one source per service and plain-text stack traces joined into one event.', section: 'capture' },
      { title: 'Follow requests across services', text: 'Start the local OpenTelemetry receiver, browse recent requests in the Traces list, and open a waterfall with every span and log of a trace.', section: 'inspect' },
      { title: 'Logs in your editor', text: 'Log lenses show live hits above logging calls, Break here on an event stops the debugger on a statement, and log doctor reports secrets, personal data, and missing exceptions in the Problems panel.', section: 'inspect' }
    ]
  },
  {
    version: '1.9.0',
    date: '2026-09-17',
    highlights: [
      { title: 'Scope sources and runs together', text: 'Use one accessible picker with Sources and Runs tabs to filter by server, task, terminal, imported source, or one command execution.', section: 'capture' },
      { title: 'Stop one active run', text: 'The Runs tab offers inline Stop actions for Logline-owned processes and VS Code tasks while externally captured terminal commands stay observe-only.', section: 'capture' },
      { title: 'Capture terminals more reliably', text: 'Already-open terminals are ready for their next command, completed empty runs are cleaned up, and the toolbar clearly shows Off, On, Capturing…, or Needs attention.', section: 'capture' }
    ]
  },
  {
    version: '1.8.0',
    date: '2026-09-15',
    highlights: [
      { title: 'Capture the terminal you already use', text: 'Turn Terminal capture: On once and run commands normally; new shell-integrated terminal output becomes searchable in Logs, with plain text shown as Unclassified when no level is marked.', section: 'capture' },
      { title: 'Share with agent', text: 'Confirm once to share retained sources and new runs in this window. Results are always redacted, but may still contain sensitive information. Choose specific runs from More actions to limit access.', section: 'share' },
      { title: 'Keep using your existing agent chat', text: 'Sharing · Stop makes your sharing state visible. Ask Copilot to check the logs through read-only Logline tools, share an expanded event’s exact run, and click the sharing button again to stop.', section: 'share' }
    ]
  },
  {
    version: '1.7.0',
    date: '2026-09-14',
    highlights: [
      { title: 'A visual quick reference', text: 'See capture, search, inspection, analysis, sharing, and retention at a glance with compact UI previews.', section: 'capture' },
      { title: 'Search chips stay in context', text: 'Applied terms become editable, removable chips; autocomplete, cell filters, and saved searches keep the active server and level selection together.', section: 'search' },
      { title: 'Safer inspection and exports', text: 'Browse-mode inspection, streaming exports, and redaction preserve context as logs change.', section: 'share' }
    ]
  },
  {
    version: '1.6.0',
    date: '2026-09-14',
    highlights: [
      { title: 'Faster, safer exports', text: 'Large JSON, JSONL, and CSV exports now stream in cancellable batches, with redaction and staged writes.', section: 'share' },
      { title: 'Search suggestions stay in context', text: 'Autocomplete keeps your query prefix, escapes suggested values, and uses the selected source\'s index.', section: 'search' },
      { title: 'Inspect without losing your place', text: 'Changing filters, paging, sorting, or columns while inspecting an event returns cleanly to Browse mode.', section: 'inspect' }
    ]
  }
];

export const latestGuideRelease = GUIDE_RELEASES[0];
export const GUIDE_STATE_KEY = 'logline.guide.lastSeenVersion';

export function guideStatus(lastSeenVersion: string | undefined): GuideStatus {
  return { version: latestGuideRelease.version, unread: lastSeenVersion !== latestGuideRelease.version };
}
