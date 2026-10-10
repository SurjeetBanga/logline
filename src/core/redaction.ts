import type { LogEvent } from './types';

export interface RedactionOptions {
  enabled?: boolean;
  fields?: string[];
  replacement?: string;
}

const DEFAULT_REPLACEMENT = '[REDACTED]';
const SENSITIVE_KEY = /(?:password|passphrase|secret|token|api[-_ ]?key|authorization|cookie|private[-_ ]?key|access[-_ ]?key|credential)/i;

// Credentials recognizable by their value alone, wherever they appear. Each
// pattern starts on a fixed prefix and repeats only over characters it
// consumes, so it stays linear; the `hint` test skips plain lines cheaply.
const SECRET_VALUES: { hint: string; pattern: RegExp; keep?: number }[] = [
  { hint: 'PRIVATE KEY', pattern: /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*(?:-----END [A-Z ]{0,20}PRIVATE KEY-----)?/g },
  { hint: 'eyJ', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { hint: 'earer ', pattern: /\b([Bb]earer )[A-Za-z0-9._~+/-]{16,}=*/g, keep: 1 },
  { hint: 'IA', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { hint: 'gh', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { hint: 'xox', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { hint: 'AIza', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { hint: '_live_', pattern: /\b[rs]k_live_[0-9A-Za-z]{16,}/g },
  // The password in `scheme://user:password@host`.
  { hint: '://', pattern: /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@"']{1,256}:)[^\s/@"']{1,256}(?=@)/gi, keep: 1 }
];

function redactSecretValues(text: string, replacement: string): string {
  for (const { hint, pattern, keep } of SECRET_VALUES) {
    if (!text.includes(hint)) continue;
    text = text.replace(pattern, (match, prefix: unknown) =>
      match.includes(replacement) ? match : (keep && typeof prefix === 'string' ? prefix : '') + replacement);
  }
  return text;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string, fields: string[] = []): boolean {
  const normalized = normalizedKey(key);
  if (fields.some(field => normalizedKey(field) === normalized)) return true;
  return SENSITIVE_KEY.test(key) && !/(count|limit|ttl|expires?|duration)$/i.test(key);
}

function isKeyCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_.-]/.test(value);
}

/**
 * Redact assignment values with a bounded scanner. A global regexp has to
 * repeatedly backtrack over long non-secret lines and also misses quoted keys
 * in truncated JSON. Scanning each code unit once handles both cases without
 * changing the surrounding log text.
 */
function redactAssignments(text: string, replacement: string, sensitive: (key: string) => boolean, depth = 0): string {
  let output = '';
  let cursor = 0;
  let index = 0;
  // End of the bare token most recently measured. Rescanned values are
  // suffixes of that token, so reuse it to keep the scan linear.
  let bareEnd = 0;
  while (index < text.length) {
    const start = index;
    let key: string | undefined;
    let keyEnd = index;
    if ((text[index] === '"' || text[index] === "'") && !isKeyCharacter(text[index - 1])) {
      const quote = text[index++];
      const keyStart = index;
      let escaped = false;
      while (index < text.length) {
        const char = text[index++];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === quote) { key = text.slice(keyStart, index - 1); keyEnd = index; break; }
      }
    } else if (isKeyCharacter(text[index]) && !isKeyCharacter(text[index - 1])) {
      while (isKeyCharacter(text[index])) index++;
      key = text.slice(start, index);
      keyEnd = index;
    } else {
      index++;
      continue;
    }
    // An apostrophe or a quoted phrase in prose is not a key. Resume just past
    // the opening quote so assignments inside or after it are still scanned.
    const quotedKey = text[start] === '"' || text[start] === "'";
    if (key === undefined) { index = start + 1; continue; }
    let separatorEnd = keyEnd;
    while (/\s/.test(text[separatorEnd] ?? '')) separatorEnd++;
    if (text[separatorEnd] !== ':' && text[separatorEnd] !== '=') { index = quotedKey ? start + 1 : Math.max(index, keyEnd); continue; }
    separatorEnd++;
    while (/\s/.test(text[separatorEnd] ?? '')) separatorEnd++;
    const valueStart = separatorEnd;
    let valueEnd = valueStart;
    const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] : undefined;
    if (quote) {
      valueEnd++;
      let escaped = false;
      while (valueEnd < text.length) {
        const char = text[valueEnd++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) break;
      }
    } else {
      valueEnd = Math.max(valueStart, bareEnd);
      while (valueEnd < text.length && !/[\s,;\]}]/.test(text[valueEnd])) valueEnd++;
      bareEnd = valueEnd;
      // Authorization headers commonly use a two-token scheme, for example
      // `Bearer eyJ...`; consume the credential as one value so the scanner
      // cannot leave the recognizable token behind.
      const scheme = valueEnd - valueStart <= 6 ? text.slice(valueStart, valueEnd).toLowerCase() : '';
      if (scheme === 'bearer' || scheme === 'basic') {
        while (/\s/.test(text[valueEnd] ?? '')) valueEnd++;
        while (valueEnd < text.length && !/[\s,;\]}]/.test(text[valueEnd])) valueEnd++;
        bareEnd = valueEnd;
      }
      // A bare assignment inside a quoted phrase (`"failed password=x"`) ends
      // at the phrase's closing quote; keep that quote outside the value.
      const last = text[valueEnd - 1];
      if (valueEnd - valueStart > 1 && (last === '"' || last === "'")) valueEnd--;
    }
    if (valueEnd === valueStart) { index = Math.max(index, keyEnd); continue; }
    if (!sensitive(key)) {
      // Message fields frequently contain a JSON document as a quoted string.
      // Decode one bounded nesting level so escaped inner keys are visible to
      // the same scanner, then serialize the value back with its delimiters.
      if (quote && depth < 4) {
        const encoded = text.slice(valueStart, valueEnd);
        let decoded: string | undefined;
        try { decoded = quote === '"' ? JSON.parse(encoded) as string : encoded.slice(1, -1); } catch { /* incomplete value */ }
        if (typeof decoded === 'string') {
          const redacted = redactAssignments(decoded, replacement, sensitive, depth + 1);
          if (redacted !== decoded) {
            output += text.slice(cursor, valueStart) + (quote === '"' ? JSON.stringify(redacted) : quote + redacted + quote);
            cursor = valueEnd;
          }
        }
      }
      // An unquoted value such as a URL can carry its own assignments
      // (`?access_token=...`), so rescan it rather than skipping it whole.
      index = quote ? valueEnd : valueStart;
      continue;
    }
    output += text.slice(cursor, valueStart);
    if (quote) output += quote + replacement + (text[valueEnd - 1] === quote ? quote : '');
    else output += replacement;
    cursor = valueEnd;
    index = valueEnd;
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

/**
 * Parsed JSON payloads are flattened into `fields` with both dotted paths and
 * convenience aliases. A secret under `credentials.value` can therefore also
 * appear as a plain `value` key. Redact a sensitive path and any alias that
 * ends that path with the same value. Matching on the value alone would also
 * blank unrelated fields that merely share it, such as `success: false` next
 * to `password_reset: false`.
 */
function redactFields(fields: Record<string, string | number | boolean>, replacement: string, configuredFields: string[], redactText: (text: string) => string): Record<string, string | number | boolean> {
  const sensitivePaths = new Map<string | number | boolean, string[]>();
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split('.');
    const sensitivePath = isSensitiveKey(key, configuredFields)
      || parts.slice(0, -1).some((_part, index) => isSensitiveKey(parts.slice(0, index + 1).join('.'), configuredFields));
    if (sensitivePath) sensitivePaths.set(value, [...sensitivePaths.get(value) ?? [], key]);
  }
  const redacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    const sensitive = isSensitiveKey(key, configuredFields)
      || (sensitivePaths.get(value)?.some(path => path === key || path.endsWith('.' + key)) ?? false);
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
  const redactTextInternal = (text: string): string => enabled
    ? redactSecretValues(redactAssignments(text, replacement, key => isSensitiveKey(key, configuredFields)), replacement)
    : text;

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
    if (Array.isArray(redacted.dependencies)) redacted.dependencies = redacted.dependencies.map(value => redactTextInternal(value));
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
