import type { LogEvent } from './types';

export interface RedactionOptions {
  enabled?: boolean;
  fields?: string[];
  replacement?: string;
}

const DEFAULT_REPLACEMENT = '[REDACTED]';
const SENSITIVE_KEY = /(?:password|passphrase|secret|token|api[-_ ]?key|authorization|cookie|private[-_ ]?key|access[-_ ]?key|credential)/i;

// Permit a camelCase or snake_case field prefix (sessionToken,
// userPassword, client_secret) while still requiring the sensitive keyword
// to be immediately followed by an assignment separator. This catches
// secrets embedded in free-text messages as well as JSON object keys.
const key = '(?:[A-Za-z0-9_.-]*?(?:password|passphrase|secret|token|api[-_ ]?key|authorization|cookie|private[-_ ]?key|access[-_ ]?key|credential))';
const quoted = new RegExp(`(${key})(\\s*[:=]\\s*)(["'])(.*?)\\3`, 'gi');
const bare = new RegExp(`(${key})(\\s*[:=]\\s*)(?!["'])((?:(?:Bearer|Basic)\\s+)?[^\\s,;\\]}]+)`, 'gi');

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
  let result = text
    .replace(quoted, (_match, key, separator, quote) => `${key}${separator}${quote}${replacement}${quote}`)
    .replace(bare, (_match, key, separator) => `${key}${separator}${replacement}`);
  for (const field of options.fields ?? []) {
    if (!field || !/^[A-Za-z0-9_.-]+$/.test(field)) continue;
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result
      .replace(new RegExp(`(${escaped})(\\s*[:=]\\s*)(["'])(.*?)\\3`, 'gi'), (_match, key, separator, quote) => `${key}${separator}${quote}${replacement}${quote}`)
      .replace(new RegExp(`(${escaped})(\\s*[:=]\\s*)(?!["'])((?:(?:Bearer|Basic)\\s+)?[^\\s,;\\]}]+)`, 'gi'), (_match, key, separator) => `${key}${separator}${replacement}`);
  }
  return result;
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
  // Metadata is part of the agent response too. A secret in a terminal label,
  // command, task name, or working directory must not bypass redaction merely
  // because it is outside the structured payload.
  for (const key of ['timestamp', 'stream', 'serverId', 'server', 'sessionId', 'taskName', 'taskType', 'taskState', 'dependencyState', 'exitReason', 'command', 'cwd', 'captureReason']) {
    const value = (redacted as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string') (redacted as unknown as Record<string, unknown>)[key] = redactText(value, options);
  }
  if (event.raw !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(event.raw);
    } catch {
      redacted.raw = redactText(event.raw, options);
      return redacted;
    }
    try {
      redacted.raw = JSON.stringify(redactValue(value, options));
    } catch {
      // Deep valid JSON can exceed the recursive serializer's stack. Falling
      // back to text here would expose quoted JSON credentials unchanged.
      redacted.raw = options.replacement ?? DEFAULT_REPLACEMENT;
    }
  }
  return redacted;
}
