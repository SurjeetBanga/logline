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

/**
 * Parsed JSON payloads are flattened into `fields` with both dotted paths and
 * convenience aliases. A secret under `credentials.value` can therefore also
 * appear as a plain `value` key. Redact aliases whose primitive value is the
 * same as a value found under a sensitive path.
 */
function redactFields(fields: Record<string, string | number | boolean>, replacement: string, configuredFields: string[], redactText: (text: string) => string): Record<string, string | number | boolean> {
  const sensitiveValues = new Set<string | number | boolean>();
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split('.');
    const sensitivePath = isSensitiveKey(key, configuredFields)
      || parts.slice(0, -1).some((_part, index) => isSensitiveKey(parts.slice(0, index + 1).join('.'), configuredFields));
    if (sensitivePath) sensitiveValues.add(value);
  }
  const redacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    const sensitive = isSensitiveKey(key, configuredFields) || sensitiveValues.has(value);
    const safeValue = typeof value === 'string' ? redactText(value) : value;
    if (sensitive) {
      if (key === '__proto__') Object.defineProperty(redacted, key, { value: replacement, enumerable: true, writable: true, configurable: true });
      else redacted[key] = replacement;
    } else if (key === '__proto__') Object.defineProperty(redacted, key, { value: safeValue, enumerable: true, writable: true, configurable: true });
    else redacted[key] = safeValue;
  }
  return redacted;
}

export interface Redactor {
  text(text: string): string;
  value(value: unknown, key?: string): unknown;
  event(event: LogEvent): LogEvent;
}

/** Compile all field-specific patterns once for a search/export operation. */
export function createRedactor(options: RedactionOptions = {}): Redactor {
  const enabled = options.enabled !== false;
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const configuredFields = [...(options.fields ?? [])];
  const customPatterns = configuredFields.flatMap(field => {
    if (!field || !/^[A-Za-z0-9_.-]+$/.test(field)) return [];
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [{
      quoted: new RegExp(`(${escaped})(\\s*[:=]\\s*)(["'])(.*?)\\3`, 'gi'),
      bare: new RegExp(`(${escaped})(\\s*[:=]\\s*)(?!["'])((?:(?:Bearer|Basic)\\s+)?[^\\s,;\\]}]+)`, 'gi')
    }];
  });

  const redactTextInternal = (text: string): string => {
    if (!enabled) return text;
    let result = text
      .replace(quoted, (_match, key, separator, quote) => `${key}${separator}${quote}${replacement}${quote}`)
      .replace(bare, (_match, key, separator) => `${key}${separator}${replacement}`);
    for (const patterns of customPatterns) {
      result = result
        .replace(patterns.quoted, (_match, key, separator, quote) => `${key}${separator}${quote}${replacement}${quote}`)
        .replace(patterns.bare, (_match, key, separator) => `${key}${separator}${replacement}`);
    }
    return result;
  };

  const redactValueInternal = (value: unknown, key?: string): unknown => {
    if (!enabled) return value;
    if (key !== undefined && isSensitiveKey(key, configuredFields)) return replacement;
    if (typeof value === 'string') return redactTextInternal(value);
    if (Array.isArray(value)) return value.map(item => redactValueInternal(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) =>
      [entryKey, redactValueInternal(entryValue, entryKey)]));
  };

  const redactEventInternal = (event: LogEvent): LogEvent => {
    if (!enabled) return { ...event };
    const redacted: LogEvent = {
      ...event,
      fields: event.fields ? redactFields(event.fields, replacement, configuredFields, redactTextInternal) : event.fields,
      message: event.message === undefined ? event.message : redactTextInternal(event.message)
    };
    // Metadata is part of the agent response too. A secret in a terminal label,
    // command, task name, or working directory must not bypass redaction merely
    // because it is outside the structured payload.
    for (const key of ['timestamp', 'stream', 'serverId', 'server', 'sessionId', 'taskName', 'taskType', 'taskState', 'dependencyState', 'exitReason', 'command', 'cwd', 'captureReason']) {
      const value = (redacted as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string') (redacted as unknown as Record<string, unknown>)[key] = redactTextInternal(value);
    }
    if (event.raw !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(event.raw);
      } catch {
        redacted.raw = redactTextInternal(event.raw);
        return redacted;
      }
      try {
        redacted.raw = JSON.stringify(redactValueInternal(value));
      } catch {
        // Deep valid JSON can exceed the recursive serializer's stack. Falling
        // back to text here would expose quoted JSON credentials unchanged.
        redacted.raw = replacement;
      }
    }
    return redacted;
  };

  return { text: redactTextInternal, value: redactValueInternal, event: redactEventInternal };
}

export function redactText(text: string, options: RedactionOptions = {}): string {
  return createRedactor(options).text(text);
}

export function redactValue(value: unknown, options: RedactionOptions = {}, key?: string): unknown {
  return createRedactor(options).value(value, key);
}

export function redactEvent(event: LogEvent, options: RedactionOptions = {}): LogEvent {
  return createRedactor(options).event(event);
}
