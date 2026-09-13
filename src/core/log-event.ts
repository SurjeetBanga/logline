import type { LogEvent } from './types';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const IGNORED_FIELDS = new Set(['level', 'severity', 'message', 'msg', 'event', 'name', 'timestamp', 'time', 'ts', 'datetime', 'timeMillis', 'contextMap']);
const MAX_FIELDS = 120;
type JsonObject = Record<string, unknown>;

export function parseLogLine(line: string, stream: string, id: number, receivedAt: Date): LogEvent {
  const trimmed = stripAnsi(line).trim();
  let value: unknown;
  if (looksLikeJson(trimmed)) {
    try { value = JSON.parse(trimmed); } catch { value = undefined; }
  }
  const object: JsonObject | undefined = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
  const severity = readValue(object, 'level', 'severity', 'log.level', 'severityText', 'SeverityText');
  const severityNumber = readValue(object, 'severityNumber', 'SeverityNumber');
  const level = severity === undefined && typeof severityNumber === 'number' && severityNumber >= 1 && severityNumber <= 24
    ? LEVELS[Math.floor((severityNumber - 1) / 4)] : normalizeLevel(severity as string | number | undefined, stream);
  const message = getMessage(object, value, trimmed);
  const timestampInfo = getTimestamp(object, receivedAt);
  const fields = object ? extractFields(object) : {};
  return {
    id, timestamp: timestampInfo.text, timestampMs: timestampInfo.ms, level, message: message.slice(0, 512), stream,
    isJson: value !== undefined, raw: trimmed, fields
  };
}

// Accept both literal dotted keys (ECS) and the equivalent nested objects.
function readValue(object: JsonObject | undefined, ...names: string[]): unknown {
  if (!object) return undefined;
  for (const name of names) {
    if (object?.[name] !== undefined) return object[name];
    if (!name.includes('.')) continue;
    let value: unknown = object;
    for (const part of name.split('.')) value = value && typeof value === 'object' ? (value as JsonObject)[part] : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

export function normalizeLevel(level: string | number | undefined, stream: string): string {
  if (typeof level === 'number') {
    const byCode: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
    return byCode[level] ?? (stream === 'stderr' ? 'error' : 'info');
  }
  const normalized = String(level ?? '').toLowerCase();
  if (LEVELS.includes(normalized)) return normalized;
  if (normalized === 'warning') return 'warn';
  if (normalized === 'critical') return 'fatal';
  return stream === 'stderr' ? 'error' : 'info';
}

function getMessage(object: JsonObject | undefined, value: unknown, fallback: string): string {
  const candidate = object?.message ?? object?.msg ?? object?.event ?? object?.name
    ?? readValue(object, 'body.stringValue', 'Body.stringValue', 'body', 'Body');
  if (candidate !== undefined) return String(candidate);
  if (value === undefined || typeof value === 'string') return String(value ?? fallback);
  if (Array.isArray(value)) return `Array (${value.length} items)`;
  return 'JSON event';
}

function getTimestamp(object: JsonObject | undefined, receivedAt: Date): { text: string; ms: number } {
  // timeMillis is Log4j2 JsonLayout's event time (epoch ms); Date() accepts it directly.
  const candidate = (object?.timestamp ?? object?.time ?? object?.ts ?? object?.datetime ?? object?.timeMillis ?? object?.['@timestamp']) as string | number | undefined;
  if (candidate !== undefined) {
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

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\[[0-?]*[ -/]*[@-~]/g, '');
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function extractFields(object: JsonObject): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  const entries = Object.entries(object);
  let fieldCount = 0;
  const add = (key: string, value: unknown) => {
    if (fieldCount < MAX_FIELDS && isPrimitive(value) && fields[key] === undefined) {
      fields[key] = value;
      fieldCount++;
    }
  };
  // Explicit top-level values win over convenience aliases from nested objects.
  for (const [key, value] of entries) {
    if (fieldCount >= MAX_FIELDS) break;
    if (!IGNORED_FIELDS.has(key) && isPrimitive(value)) add(key, value);
  }
  const walk = (key: string, value: unknown, depth: number) => {
    if (isPrimitive(value)) { add(key, value); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 4) return;
    for (const [child, childValue] of Object.entries(value as JsonObject)) {
      if (fieldCount >= MAX_FIELDS) break;
      add(`${key}.${child}`, childValue);
      if (isPrimitive(childValue)) add(child, childValue);
      else walk(`${key}.${child}`, childValue, depth + 1);
    }
  };
  for (const [key, value] of entries) {
    if (fieldCount >= MAX_FIELDS) break;
    if (IGNORED_FIELDS.has(key) || isPrimitive(value)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [child, childValue] of Object.entries(value as JsonObject)) {
        if (fieldCount >= MAX_FIELDS) break;
        add(`${key}.${child}`, childValue);
        // Bare aliases make nested payloads easy to search while the dotted
        // path preserves an unambiguous column name.
        if (isPrimitive(childValue)) add(child, childValue);
        else walk(`${key}.${child}`, childValue, 2);
      }
    }
  }
  // Log4j2 JsonLayout nests MDC (ThreadContext) values under contextMap instead
  // of at the top level; flatten them so they're searchable like any other field.
  const context = object.contextMap;
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    for (const [key, value] of Object.entries(context as JsonObject)) {
      if (fieldCount >= MAX_FIELDS) break;
      add(key, value);
    }
  }
  // OTLP JSON encodes attributes as key/value entries containing typed values.
  // Decode only recognized attribute containers, with the same field budget.
  for (const [prefix, attributes] of [
    ['attributes', object.attributes], ['resource.attributes', readValue(object, 'resource.attributes')]
  ] as const) {
    if (!Array.isArray(attributes)) continue;
    for (const entry of attributes) {
      if (fieldCount >= MAX_FIELDS) break;
      if (!entry || typeof entry.key !== 'string' || !entry.value || typeof entry.value !== 'object') continue;
      const value = entry.value.stringValue ?? entry.value.intValue ?? entry.value.doubleValue ?? entry.value.boolValue;
      add(`${prefix}.${entry.key}`, value);
      add(entry.key, value);
    }
  }
  return fields;
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
