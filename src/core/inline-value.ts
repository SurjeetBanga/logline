import { META } from './log-insert';
import type { LogSite } from './log-sites';
import { createRedactor, type RedactionOptions } from './redaction';
import type { LogEvent } from './types';

/** How many characters of a value the end of a line shows; the hover can copy all of it. */
export const INLINE_VALUE_LIMIT = 60;

type ValueEvent = Pick<LogEvent, 'message' | 'raw' | 'isJson' | 'fields'>;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each template's pattern, built the first time a message is read against it.
const patterns = new Map<string, RegExp | null>();
const MAX_PATTERNS = 2000;

/**
 * The pattern that reads a template's placeholders out of a message: its literals in order, each
 * placeholder a capture. A template with no placeholders captures what was logged after its text,
 * as `console.log("total", total)` prints `total 19.9`.
 */
function patternOf(template: string): RegExp | null {
  const cached = patterns.get(template);
  if (cached !== undefined) return cached;
  const parts = template.split('…');
  if (parts.length === 1) parts.push('');
  let source = '';
  parts.forEach((part, index) => {
    source += escapeRegex(part.trim()).replace(/\s+/g, '\\s+');
    if (index === parts.length - 1) return;
    // The last placeholder runs to the end of the message; the others stop at the next literal.
    const last = index === parts.length - 2 && !parts[index + 1].trim();
    source += last ? '\\s*(.*)$' : '\\s*(.*?)\\s*';
  });
  let pattern: RegExp | null;
  try {
    pattern = new RegExp(source, 's');
  } catch {
    pattern = null;
  }
  if (patterns.size >= MAX_PATTERNS) patterns.clear();
  patterns.set(template, pattern);
  return pattern;
}

function compact(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The fields an event added beyond what its logger adds to every event. */
function ownFields(event: ValueEvent): [string, unknown][] | undefined {
  if (event.isJson && event.raw) {
    try {
      const parsed = JSON.parse(event.raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const own = Object.entries(parsed).filter(([key]) => !META.has(key));
        if (own.length) return own;
      }
    } catch {
      /* not JSON after all: read the message */
    }
    return undefined;
  }
  if (!event.fields) return undefined;
  const own = Object.entries(event.fields).filter(([key]) => !META.has(key));
  return own.length ? own : undefined;
}

/**
 * What a log statement logged, in full and redacted: the structured fields its event added, or else
 * the values that filled its message's placeholders. Undefined when the message is only its text.
 */
export function siteValue(
  event: ValueEvent,
  site: Pick<LogSite, 'template'>,
  redaction: RedactionOptions = { enabled: true },
): string | undefined {
  const redactor = createRedactor({ ...redaction, enabled: true });
  const own = ownFields(event);
  if (own) {
    const redacted = own.map(([key, value]) => [key, redactor.value(value, key)] as const);
    if (redacted.length === 1) return compact(redacted[0][1]);
    return event.isJson
      ? compact(Object.fromEntries(redacted))
      : redacted.map(([key, value]) => `${key}=${compact(value)}`).join(' ');
  }
  const message = event.message?.replace(/\s+$/, '');
  if (!message) return undefined;
  const match = patternOf(site.template)?.exec(message);
  if (!match) return undefined;
  const values = match
    .slice(1)
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return values.length ? redactor.text(values.join(' · ')) : undefined;
}

/** A value cut to fit the end of a line. */
export function shortValue(value: string, limit = INLINE_VALUE_LIMIT): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
