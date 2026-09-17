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
    version: '1.8.0',
    date: '2026-09-15',
    highlights: [
      { title: 'Capture the terminal you already use', text: 'Turn Terminal capture: On once and run commands normally; new shell-integrated terminal output becomes searchable in Logs, with plain text shown as Unclassified when no level is marked.', section: 'capture' },
      { title: 'Share logs with agent', text: 'Confirm once to share retained sources and new runs in this window. Results are always redacted, but may still contain sensitive information. Choose specific runs from More actions to limit access.', section: 'share' },
      { title: 'Keep using your existing agent chat', text: 'Sharing logs · Stop makes your sharing state visible. Ask Copilot to check the logs through read-only Logline tools, share an expanded event’s exact run, and click the sharing button again to stop.', section: 'share' }
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
