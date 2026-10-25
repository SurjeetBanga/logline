import type { LogEvent } from './types';
import { isPlainCrash, plainHeadline } from './exceptions';
import { parseLogfmt } from './logfmt';
import { terminalLevel } from './terminal-level';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_BY_CODE: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const IGNORED_FIELDS = new Set([
  'level',
  'severity',
  'message',
  'msg',
  'event',
  'name',
  'timestamp',
  'time',
  'ts',
  'datetime',
  'timeMillis',
  'contextMap',
]);
const MAX_FIELDS = 120;
type JsonObject = Record<string, unknown>;

export function parseLogLine(line: string, stream: string, id: number, receivedAt: Date): LogEvent {
  const trimmed = stripAnsi(line).trim();
  let value: unknown;
  if (looksLikeJson(trimmed)) {
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = undefined;
    }
  }
  // Plain-text lines in logfmt carry the same level/msg/time keys as JSON
  // logs, so they share the field, level and timestamp handling below while
  // staying non-JSON for details, exports and exception extraction.
  const object: JsonObject | undefined =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : value === undefined
        ? parseLogfmt(trimmed)
        : undefined;
  const severity = readValue(object, 'level', 'severity', 'log.level', 'severityText', 'SeverityText');
  const severityNumber = readValue(object, 'severityNumber', 'SeverityNumber');
  // A joined stack trace keeps every frame in `raw`; its row shows the first
  // line, or the error line of a Node crash block rather than its `path:line`.
  const multiline = value === undefined && trimmed.includes('\n');
  const headline = multiline ? plainHeadline(trimmed) : trimmed;
  const level =
    severity === undefined && typeof severityNumber === 'number' && severityNumber >= 1 && severityNumber <= 24
      ? LEVELS[Math.floor((severityNumber - 1) / 4)]
      : normalizeLevel(
          severity as string | number | undefined,
          stream,
          stream === 'terminal' || stream === 'file'
            ? plainLevel(headline, multiline ? trimmed : undefined)
            : undefined,
        );
  const message = getMessage(object, value, headline);
  const timestampInfo = getTimestamp(object, receivedAt);
  const fields = object ? extractFields(object) : {};
  return {
    id,
    timestamp: timestampInfo.text,
    timestampMs: timestampInfo.ms,
    level,
    message: message.slice(0, 512),
    stream,
    isJson: value !== undefined,
    raw: trimmed,
    fields,
  };
}

// A leading severity wins. Without one, a joined stack trace headed by an
// exception (`TypeError: x` plus frames) or a Node crash block is an error;
// a single unlabelled line stays unclassified.
function plainLevel(headline: string, joined: string | undefined): string {
  const level = terminalLevel(headline);
  return level === 'unclassified' && joined !== undefined && isPlainCrash(joined) ? 'error' : level;
}

// Accept both literal dotted keys (ECS) and the equivalent nested objects.
function readValue(object: JsonObject | undefined, ...names: string[]): unknown {
  if (!object) return undefined;
  for (const name of names) {
    if (object?.[name] !== undefined) return object[name];
    if (!name.includes('.')) continue;
    let value: unknown = object;
    for (const part of name.split('.'))
      value = value && typeof value === 'object' ? (value as JsonObject)[part] : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

export function normalizeLevel(level: string | number | undefined, stream: string, terminalFallback?: string): string {
  if (typeof level === 'number') {
    return LEVEL_BY_CODE[level] ?? (stream === 'stderr' ? 'error' : 'info');
  }
  const normalized = typeof level === 'string' ? level.toLowerCase() : '';
  if (LEVELS.includes(normalized)) return normalized;
  if (normalized === 'warning') return 'warn';
  if (normalized === 'critical') return 'fatal';
  return terminalFallback ?? (stream === 'stderr' ? 'error' : 'info');
}

function getMessage(object: JsonObject | undefined, value: unknown, fallback: string): string {
  const candidate =
    object?.message ??
    object?.msg ??
    object?.event ??
    object?.name ??
    readValue(object, 'body.stringValue', 'Body.stringValue', 'body', 'Body');
  if (candidate === null || isPrimitive(candidate)) return String(candidate);
  if (value === undefined || typeof value === 'string') return String(value ?? fallback);
  if (Array.isArray(value)) return `Array (${value.length} items)`;
  return 'JSON event';
}

function getTimestamp(object: JsonObject | undefined, receivedAt: Date): { text: string; ms: number } {
  // timeMillis is Log4j2 JsonLayout's event time (epoch ms); Date() accepts it directly.
  const candidate = (object?.timestamp ??
    object?.time ??
    object?.ts ??
    object?.datetime ??
    object?.timeMillis ??
    object?.['@timestamp']) as string | number | undefined;
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return { text: formatTime(parsed), ms: parsed.getTime() };
  }
  const nanos = readValue(object, 'timeUnixNano', 'observedTimeUnixNano');
  if ((typeof nanos === 'string' || typeof nanos === 'number') && /^\d+$/.test(String(nanos))) {
    const parsed = new Date(Number(BigInt(nanos) / 1000000n));
    if (!Number.isNaN(parsed.getTime())) return { text: formatTime(parsed), ms: parsed.getTime() };
  }
  return { text: formatTime(receivedAt), ms: receivedAt.getTime() };
}

// Two- and three-digit text for every value, so formatting a time builds no padded strings.
const TWO_DIGITS = Array.from({ length: 100 }, (_, value) => String(value).padStart(2, '0'));
const THREE_DIGITS = Array.from({ length: 1000 }, (_, value) => String(value).padStart(3, '0'));

function formatTime(date: Date): string {
  return `${TWO_DIGITS[date.getHours()]}:${TWO_DIGITS[date.getMinutes()]}:${TWO_DIGITS[date.getSeconds()]}.${THREE_DIGITS[date.getMilliseconds()]}`;
}

export function stripAnsi(value: string): string {
  return value.includes('\x1b') ? value.replace(/\[[0-?]*[ -/]*[@-~]/g, '') : value;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// Fields are collected into one accumulator by plain functions rather than closures and
// Object.entries arrays: this runs for every captured line.
interface FieldSink {
  fields: Record<string, string | number | boolean>;
  count: number;
}

function addField(sink: FieldSink, key: string, value: unknown): void {
  if (sink.count < MAX_FIELDS && isPrimitive(value) && !Object.hasOwn(sink.fields, key)) {
    if (key === '__proto__')
      Object.defineProperty(sink.fields, key, { value, enumerable: true, writable: true, configurable: true });
    else sink.fields[key] = value;
    sink.count++;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A nested object's values under dotted paths, with bare aliases for its primitives, to four levels. */
function addChildren(sink: FieldSink, key: string, object: JsonObject, depth: number): void {
  for (const child in object) {
    if (sink.count >= MAX_FIELDS) break;
    const value = object[child];
    const path = `${key}.${child}`;
    if (isPrimitive(value)) {
      addField(sink, path, value);
      // Bare aliases make nested payloads easy to search while the dotted
      // path preserves an unambiguous column name.
      addField(sink, child, value);
    } else if (depth < 4 && isPlainObject(value)) addChildren(sink, path, value, depth + 1);
  }
}

function extractFields(object: JsonObject): Record<string, string | number | boolean> {
  const sink: FieldSink = { fields: {}, count: 0 };
  // Explicit top-level values win over convenience aliases from nested objects.
  for (const key in object) {
    if (sink.count >= MAX_FIELDS) break;
    const value = object[key];
    if (!IGNORED_FIELDS.has(key) && isPrimitive(value)) addField(sink, key, value);
  }
  for (const key in object) {
    if (sink.count >= MAX_FIELDS) break;
    const value = object[key];
    if (!IGNORED_FIELDS.has(key) && isPlainObject(value)) addChildren(sink, key, value, 2);
  }
  // Log4j2 JsonLayout nests MDC (ThreadContext) values under contextMap instead
  // of at the top level; flatten them so they're searchable like any other field.
  const context = object.contextMap;
  if (isPlainObject(context)) {
    for (const key in context) {
      if (sink.count >= MAX_FIELDS) break;
      addField(sink, key, context[key]);
    }
  }
  // OTLP JSON encodes attributes as key/value entries containing typed values.
  // Decode only recognized attribute containers, with the same field budget.
  for (const [prefix, attributes] of [
    ['attributes', object.attributes],
    ['resource.attributes', readValue(object, 'resource.attributes')],
  ] as const) {
    if (!Array.isArray(attributes)) continue;
    for (const entry of attributes) {
      if (sink.count >= MAX_FIELDS) break;
      if (!entry || typeof entry.key !== 'string' || !entry.value || typeof entry.value !== 'object') continue;
      const value = entry.value.stringValue ?? entry.value.intValue ?? entry.value.doubleValue ?? entry.value.boolValue;
      addField(sink, `${prefix}.${entry.key}`, value);
      addField(sink, entry.key, value);
    }
  }
  return sink.fields;
}

// Skips JSON.parse (and its exception overhead) for the common case of a plain
// text line, without changing behavior for any line JSON.parse would accept.
function looksLikeJson(text: string): boolean {
  if (!text) return false;
  const code = text.charCodeAt(0);
  if (code === 123 /* { */ || code === 91 /* [ */ || code === 34 /* " */ || code === 45 /* - */) return true;
  if (code >= 48 && code <= 57 /* 0-9 */) return true;
  return text === 'true' || text === 'false' || text === 'null';
}
