// What Suggest a feature and Vote on what's next offer, shared by the Logs
// panel's form and the editor side that sends it.
import { redactText } from './redaction';

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

// What a suggestion must not carry, in the order it is replaced. Credentials go first, through the
// redaction exports use; then anything that could say who or where someone is. A suggestion rarely
// needs any of these, so a false match costs a word, while a missed one could identify someone.
const SCRUBS: [RegExp, string][] = [
  [/\b(?:https?|ftp|ssh|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/\S+/gi, '[URL]'],
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g, '[EMAIL]'],
  [/(?:~|\/(?:Users|home|var|opt|srv|etc|tmp|private|mnt|Volumes)|\b[A-Za-z]:\\)[^\s'"`,;:)]*/g, '[PATH]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[IP]'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[IP]'],
  [
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|co|cloud|app|ai|internal|local|corp|lan|intranet|home)\b/gi,
    '[HOST]',
  ],
  [/\b(?:\d{4}[ -]){3}\d{3,4}\b|\b\d{4}[ -]\d{6}[ -]\d{5}\b/g, '[NUMBER]'],
  [/(?:\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{3,4}\b/g, '[PHONE]'],
  [/\b\d{6,}\b/g, '[NUMBER]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED]'],
];

/**
 * A suggestion as it may be sent: credentials redacted as in exports, then URLs,
 * email addresses, paths, IP addresses, host names, card, phone, and long numbers,
 * and long token-like strings replaced. The Logs panel shows this before Send, and
 * the editor applies it again before anything leaves.
 */
export function scrubFeedback(text: string): string {
  let scrubbed = redactText(text.trim().slice(0, FEEDBACK_TEXT_LIMIT));
  for (const [pattern, replacement] of SCRUBS) scrubbed = scrubbed.replace(pattern, replacement);
  return scrubbed;
}
