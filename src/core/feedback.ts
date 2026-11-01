// What Suggest a feature and Vote on what's next offer, shared by the Logs
// panel's form and the editor side that sends it.

/** What a suggestion can be about. */
export const FEEDBACK_AREAS = ['Capture', 'Search', 'Views', 'Connections', 'Agents', 'Something else'] as const;
/** What could come next, as the vote offers it. Keep in step with the PostHog survey's choices. */
export const ROADMAP = [
  'More log stores and services',
  'Alerts when a log pattern appears',
  'Share a captured session with a teammate',
  'Saved panel layouts and views',
  'Deeper agent investigations',
] as const;
/** The longest suggestion, in characters. */
export const FEEDBACK_TEXT_LIMIT = 500;

/** Open the feedback form; `sendable` is false while usage counts are off, so it offers a GitHub issue. */
export interface FeedbackOpen {
  mode: 'suggest' | 'vote';
  sendable: boolean;
}

/** What the form sends. `github` asks for a GitHub issue instead. */
export type FeedbackRequest =
  | { mode: 'suggest'; area: string; text: string; github?: boolean }
  | { mode: 'vote'; picks: string[]; github?: boolean };

/** How it went: sent to the developers, opened as a GitHub issue, or not sent. */
export interface FeedbackResult {
  ok: boolean;
  via: 'posthog' | 'github';
}
