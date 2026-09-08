import type { LogEvent } from './types';

export interface RedactionOptions {
  enabled?: boolean;
  fields?: string[];
  replacement?: string;
}

const DEFAULT_REPLACEMENT = '[REDACTED]';
const SENSITIVE_KEY = /(?:password|passphrase|secret|token|api[-_ ]?key|authorization|cookie|private[-_ ]?key|access[-_ ]?key|credential)/i;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string, fields: string[] = []): boolean {
  const normalized = normalizedKey(key);
  if (fields.some(field => normalizedKey(field) === normalized)) return true;
  return SENSITIVE_KEY.test(key) && !/(count|limit|ttl|expires?|duration)$/i.test(key);
}

export function redactText(text: string, options: RedactionOptions = {}): string {
  if (options.enabled === false) return text;
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const quoted = /\b(password|passphrase|secret|token|api[-_ ]?key|authorization|cookie|private[-_ ]?key|access[-_ ]?key|credential)\b(\s*[:=]\s*)(["'])(.*?)\3/gi;
  const bare = /\b(password|passphrase|secret|token|api[-_ ]?key|authorization|cookie|private[-_ ]?key|access[-_ ]?key|credential)\b(\s*[:=]\s*)(?!["'])((?:(?:Bearer|Basic)\s+)?[^\s,;\]}]+)/gi;
  return text
    .replace(quoted, (_match, key, separator, quote) => `${key}${separator}${quote}${replacement}${quote}`)
    .replace(bare, (_match, key, separator) => `${key}${separator}${replacement}`);
}

export function redactValue(value: unknown, options: RedactionOptions = {}, key?: string): unknown {
  if (options.enabled === false) return value;
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const fields = options.fields ?? [];
  if (key !== undefined && isSensitiveKey(key, fields)) return replacement;
  if (typeof value === 'string') return redactText(value, options);
  if (Array.isArray(value)) return value.map(item => redactValue(item, options));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) =>
    [entryKey, redactValue(entryValue, options, entryKey)]));
}

export function redactEvent(event: LogEvent, options: RedactionOptions = {}): LogEvent {
  if (options.enabled === false) return { ...event };
  const redacted: LogEvent = {
    ...event,
    fields: event.fields ? redactValue(event.fields, options) as LogEvent['fields'] : event.fields,
    message: event.message === undefined ? event.message : redactText(event.message, options)
  };
  if (event.raw !== undefined) {
    try {
      redacted.raw = JSON.stringify(redactValue(JSON.parse(event.raw), options));
    } catch {
      redacted.raw = redactText(event.raw, options);
    }
  }
  return redacted;
}
