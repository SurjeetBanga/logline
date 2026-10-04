import { extractExceptions } from './exceptions';
import { getField } from './query';
import { isSensitiveKey } from './redaction';
import type { LogEvent } from './types';

/** What kind of sensitive value an event carried. */
export type SensitiveKind = 'jwt' | 'bearer' | 'aws-key' | 'github-token' | 'slack-token' | 'google-key' | 'stripe-key' | 'private-key'
  | 'credential' | 'email' | 'card';

export interface SensitiveValue {
  kind: SensitiveKind;
  /** `secret` values grant access; `personal` values identify a person or account. */
  category: 'secret' | 'personal';
  /** Where it was: a field path, or `message` for plain text. */
  path: string;
  /** A masked hint of the value. Never the value itself. */
  preview: string;
}

export const SENSITIVE_LABELS: Record<SensitiveKind, string> = {
  jwt: 'a JSON Web Token', bearer: 'a bearer token', 'aws-key': 'an AWS access key', 'github-token': 'a GitHub token',
  'slack-token': 'a Slack token', 'google-key': 'a Google API key', 'stripe-key': 'a Stripe live key', 'private-key': 'a private key',
  credential: 'a credential', email: 'an email address', card: 'a payment card number'
};

interface Detector { kind: SensitiveKind; category: 'secret' | 'personal'; hint: string; pattern: RegExp; check?: (match: string) => boolean; }

// Each pattern is anchored on a fixed prefix or a bounded character run, and
// the cheap `hint` substring test runs first, so plain log lines cost one
// `includes` per detector. Patterns must stay linear: a quantified group may
// only repeat over a character it consumes.
const DETECTORS: Detector[] = [
  { kind: 'private-key', category: 'secret', hint: 'PRIVATE KEY', pattern: /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----/ },
  { kind: 'jwt', category: 'secret', hint: 'eyJ', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'bearer', category: 'secret', hint: 'earer ', pattern: /\b[Bb]earer [A-Za-z0-9._~+/-]{16,}=*/ },
  { kind: 'aws-key', category: 'secret', hint: 'IA', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: 'github-token', category: 'secret', hint: 'gh', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { kind: 'slack-token', category: 'secret', hint: 'xox', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google-key', category: 'secret', hint: 'AIza', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'stripe-key', category: 'secret', hint: '_live_', pattern: /\b[rs]k_live_[0-9A-Za-z]{16,}/ },
  { kind: 'email', category: 'personal', hint: '@', pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/ },
  // 15- and 16-digit card numbers (Amex, Visa, Mastercard, Discover), grouped 4-4-4-4 or Amex 4-6-5.
  { kind: 'card', category: 'personal', hint: '', pattern: /\b[3-6]\d{3}(?:(?:[ -]?\d{4}){2}[ -]?\d{3,4}|[ -]\d{6}[ -]\d{5})\b/, check: luhn }
];
// Long numbers are often ids; a card needs its usual grouping or a field named like one.
const CARD_GROUPS = /^\d{4}([ -])\d{4}\1\d{4}\1\d{3,4}$|^\d{4}([ -])\d{6}\2\d{5}$/;
const CARD_FIELD = /(?:card|^pan$|^cc|credit)/i;
const HAS_DIGIT_RUN = /\d{4}/;
// Values that are already masked, and placeholders that are not real secrets.
const MASKED = /^(?:\[?REDACTED\]?|\*+|x+|•+|<[^>]*>|null|undefined|none|true|false|)$/i;
// Addresses that commonly appear in examples and test fixtures.
const EXAMPLE_EMAIL = /@(?:example\.(?:com|org|net)|test|localhost)\b/i;

/** Sensitive values in an event, at most one per kind, each with a masked preview. */
export function findSensitiveValues(event: LogEvent): SensitiveValue[] {
  const found = new Map<SensitiveKind, SensitiveValue>();
  // One value can look like several kinds (a JWT is also a bearer token);
  // the most specific detector, earliest in the list, claims each field.
  const claimed = new Set<string>();
  const consider = (path: string, text: string) => {
    for (const detector of DETECTORS) {
      if (claimed.has(`${path}\0${detector.category}`)) continue;
      if (detector.kind === 'card' ? !HAS_DIGIT_RUN.test(text) : !text.includes(detector.hint)) continue;
      const match = detector.pattern.exec(text);
      if (!match || (detector.check && !detector.check(match[0]))) continue;
      if (detector.kind === 'card' && !CARD_GROUPS.test(match[0]) && !CARD_FIELD.test(path.slice(path.lastIndexOf('.') + 1))) continue;
      if (detector.kind === 'email' && EXAMPLE_EMAIL.test(match[0])) continue;
      claimed.add(`${path}\0${detector.category}`);
      const previous = found.get(detector.kind);
      // Report the most specific field path: payloads repeat nested values under bare aliases.
      if (!previous || depth(path) > depth(previous.path)) {
        found.set(detector.kind, { kind: detector.kind, category: detector.category, path, preview: mask(detector.kind, match[0]) });
      }
    }
  };
  const fields = event.fields ?? {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (typeof value !== 'string' || !value) continue;
    consider(key, value);
    // A field named like a credential, holding a value no detector recognized.
    if (!claimed.has(`${key}\0secret`) && isSensitiveKey(key.slice(key.lastIndexOf('.') + 1)) && !MASKED.test(value.trim()) && value.trim().length >= 6) {
      const previous = found.get('credential');
      if (!previous || depth(key) > depth(previous.path)) found.set('credential', { kind: 'credential', category: 'secret', path: key, preview: mask('credential', value) });
    }
  }
  // A field covered by a specific kind needs no generic credential finding.
  const credential = found.get('credential');
  if (credential && [...found.values()].some(value => value.kind !== 'credential' && value.path === credential.path)) found.delete('credential');
  // Plain-text lines and messages carry values outside any field.
  const text = event.isJson ? event.message ?? '' : event.raw ?? event.message ?? '';
  if (text) consider('message', text.slice(0, 8192));
  return [...found.values()];
}

const depth = (path: string) => path === 'message' ? -1 : path.split('.').length;

function mask(kind: SensitiveKind, value: string): string {
  if (kind === 'email') {
    const at = value.indexOf('@');
    return `${value[0]}…@${value.slice(at + 1)}`;
  }
  if (kind === 'card') return `•••• ${value.replace(/\D/g, '').slice(-4)}`;
  if (kind === 'private-key') return '-----BEGIN … PRIVATE KEY-----';
  const visible = kind === 'credential' ? 0 : Math.min(4, Math.floor(value.length / 4));
  return `${value.slice(0, visible)}…[${kind}]`;
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * The variable of the `catch`/`except` block around a line, when the logging
 * call on that line does not mention it. Logging an error there without the
 * caught exception drops its stack trace.
 *
 * @param line 1-based line of the logging call.
 */
export function uncaughtExceptionVariable(text: string, line: number, language: string): string | undefined {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return undefined;
  const call = callText(lines, line - 1);
  const python = language === 'py';
  for (let index = line - 2, depthOpen = 0; index >= 0 && index >= line - 31; index--) {
    const source = lines[index];
    if (python) {
      const indent = source.length - source.trimStart().length;
      const siteIndent = lines[line - 1].length - lines[line - 1].trimStart().length;
      if (!source.trim()) continue;
      if (indent >= siteIndent) continue;
      const except = /^\s*except\b[^:#]*\bas\s+([A-Za-z_]\w*)\s*:/.exec(source);
      if (except) return mentions(call, except[1]) ? undefined : except[1];
      // The nearest enclosing block that is not an `except` ends the search.
      return undefined;
    }
    // Brace languages: walk outwards, tracking how many blocks were closed on the way up.
    for (let char = source.length - 1; char >= 0; char--) {
      if (source[char] === '}') depthOpen++;
      else if (source[char] === '{') {
        if (depthOpen > 0) { depthOpen--; continue; }
        const header = source.slice(0, char);
        const caught = /\bcatch\s*\(\s*(?:[\w.<>|\s]+\s+)?([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*$/.exec(header);
        if (caught) return mentions(call, caught[1]) ? undefined : caught[1];
        // Inside some other block; keep looking for an enclosing catch.
      }
    }
  }
  return undefined;
}

// The logging call's text, up to its closing parenthesis, at most a few lines.
function callText(lines: string[], start: number): string {
  let text = '';
  let depth = 0;
  for (let index = start; index < Math.min(lines.length, start + 8); index++) {
    const source = lines[index];
    text += source + '\n';
    for (const char of source) {
      if (char === '(') depth++;
      else if (char === ')' && --depth <= 0) return text;
    }
  }
  return text;
}

const mentions = (call: string, name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(call);

// Words a failure is described with. A message that denies one ("no errors",
// "0 failures") is not a failure.
const FAILURE_WORDS = /\b(?:error|exception|failed|failure|fatal|panic|traceback|unhandled|crash(?:ed)?|refused|timed out|timeout)\b/i;
const NOT_A_FAILURE = /\b(?:no|0|zero|without|none)\s+(?:errors?|exceptions?|failures?)\b|\b(?:errors?|failures?)\s*[=:]\s*(?:0|none|null|false)\b/i;
const QUIET_LEVELS = new Set(['trace', 'debug', 'info']);

/**
 * An event logged below warning that describes a failure: it carries a stack,
 * a 5xx status, or says it failed. Error filters, alerts and error counts miss it.
 */
export function isQuietFailure(event: LogEvent): boolean {
  if (!QUIET_LEVELS.has(event.level)) return false;
  const status = Number(getField(event, 'status'));
  if (Number.isFinite(status) && status >= 500 && status < 600) return true;
  const message = event.message ?? '';
  if (FAILURE_WORDS.test(message) && !NOT_A_FAILURE.test(message)) return true;
  return extractExceptions(event).length > 0;
}

/** A structured event that names the request or trace it belongs to. */
export function hasRequestContext(event: LogEvent): boolean {
  return [getField(event, 'traceId'), getField(event, 'requestId'), getField(event, 'correlationId'), getField(event, 'correlation_id')]
    .some(value => value !== undefined && value !== null && value !== '');
}

export function isStructured(event: LogEvent): boolean {
  return Boolean(event.isJson) || Object.keys(event.fields ?? {}).length > 0;
}

/** Sensitive values found in one source's events, by kind. */
export interface SourceSensitive {
  serverId: string; server: string; value: SensitiveValue; count: number; lastId: number;
}

/**
 * Sensitive values in events that no log statement claimed: third-party
 * output, imports, terminals, OpenTelemetry. Like a sensitive data scanner,
 * it needs no source code. Counts follow retention: evicted events are
 * subtracted, and only events carrying a value are remembered.
 */
export class SensitiveScanner {
  /** The newest event id scanned. */
  watermark = 0;
  private readonly found = new Map<string, SourceSensitive>();
  private carried: { id: number; keys: string[] }[] = [];
  private carriedHead = 0;
  /** Changes whenever the counts change. */
  version = 0;

  reset(): void {
    this.found.clear(); this.carried = []; this.carriedHead = 0; this.watermark = 0; this.version++;
  }

  /** Scan events in id order; `claimed` says whether a statement already reports an event. */
  scan(events: Iterable<LogEvent>, claimed: (event: LogEvent) => boolean = () => false): void {
    for (const event of events) {
      if (event.id <= this.watermark) continue;
      this.watermark = event.id;
      if (claimed(event)) continue;
      const values = findSensitiveValues(event);
      if (!values.length) continue;
      const serverId = event.serverId ?? '';
      const keys: string[] = [];
      for (const value of values) {
        const key = `${serverId}\0${value.kind}`;
        const entry = this.found.get(key);
        if (entry) { entry.count++; entry.lastId = event.id; entry.value = value; }
        else this.found.set(key, { serverId, server: event.server ?? serverId, value, count: 1, lastId: event.id });
        keys.push(key);
      }
      this.carried.push({ id: event.id, keys });
      this.version++;
    }
  }

  /** Forget events older than `oldestId`, which retention has dropped. */
  evict(oldestId: number): void {
    while (this.carriedHead < this.carried.length && this.carried[this.carriedHead].id < oldestId) {
      for (const key of this.carried[this.carriedHead++].keys) {
        const entry = this.found.get(key);
        if (entry && !--entry.count) this.found.delete(key);
      }
      this.version++;
    }
    if (this.carriedHead > 1024 && this.carriedHead * 2 > this.carried.length) {
      this.carried = this.carried.slice(this.carriedHead);
      this.carriedHead = 0;
    }
  }

  get findings(): SourceSensitive[] { return [...this.found.values()]; }
}
