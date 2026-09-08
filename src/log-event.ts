import type { LogEvent } from './types';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
type JsonObject = Record<string, unknown>;

export function parseLogLine(line: string, stream: string, id: number, receivedAt: Date): LogEvent {
  const trimmed = stripAnsi(line).trim();
  let value: unknown;
  if (looksLikeJson(trimmed)) {
    try { value = JSON.parse(trimmed); } catch { value = undefined; }
  }
  const object: JsonObject | undefined = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
  const level = normalizeLevel((object?.level ?? object?.severity) as string | number | undefined, stream);
  const message = getMessage(object, value, trimmed);
  const timestampInfo = getTimestamp(object, receivedAt);
  const fields = object ? extractFields(object) : {};
  return {
    id, timestamp: timestampInfo.text, timestampMs: timestampInfo.ms, level, message: message.slice(0, 512), stream,
    isJson: value !== undefined, raw: trimmed, fields
  };
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
  const candidate = object?.message ?? object?.msg ?? object?.event ?? object?.name;
  if (candidate !== undefined) return String(candidate);
  if (value === undefined || typeof value === 'string') return String(value ?? fallback);
  if (Array.isArray(value)) return `Array (${value.length} items)`;
  return 'JSON event';
}

function getTimestamp(object: JsonObject | undefined, receivedAt: Date): { text: string; ms: number } {
  // timeMillis is Log4j2 JsonLayout's event time (epoch ms); Date() accepts it directly.
  const candidate = (object?.timestamp ?? object?.time ?? object?.ts ?? object?.datetime ?? object?.timeMillis) as string | number | undefined;
  if (candidate !== undefined) {
    const parsed = new Date(candidate);
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
  const ignored = new Set(['level', 'severity', 'message', 'msg', 'event', 'name', 'timestamp', 'time', 'ts', 'datetime', 'timeMillis', 'contextMap']);
  const add = (key: string, value: unknown) => { if (isPrimitive(value) && fields[key] === undefined && Object.keys(fields).length < 120) fields[key] = value; };
  const walk = (key: string, value: unknown, depth: number) => {
    if (isPrimitive(value)) { add(key, value); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 4) return;
    for (const [child, childValue] of Object.entries(value as JsonObject)) {
      add(`${key}.${child}`, childValue);
      if (isPrimitive(childValue)) add(child, childValue);
      else walk(`${key}.${child}`, childValue, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(object)) {
    if (ignored.has(key)) continue;
    if (isPrimitive(value)) add(key, value);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [child, childValue] of Object.entries(value as JsonObject)) {
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
      if (fields[key] === undefined && isPrimitive(value)) fields[key] = value;
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
