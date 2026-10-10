// Normalizes OTLP export requests (OTLP/JSON, or protobuf decoded into the
// same shape by otlp-proto.ts) into bounded log records and spans.

export type AttrValue = string | number | boolean | null | AttrValue[] | { [key: string]: AttrValue };
export type Attributes = Record<string, AttrValue>;

export interface OtlpLog {
  timeMs: number;
  service: string;
  severityNumber?: number;
  severityText?: string;
  body: AttrValue;
  attributes: Attributes;
  resource: Attributes;
  scope?: string;
  traceId?: string;
  spanId?: string;
  eventName?: string;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** OTLP SpanKind: 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
  kind: number;
  startMs: number;
  endMs: number;
  service: string;
  attributes: Attributes;
  events: { timeMs: number; name: string; attributes: Attributes }[];
  /** OTLP StatusCode: 0 unset, 1 ok, 2 error. */
  status: { code: number; message?: string };
  scope?: string;
  /** The receiver run that accepted the span, so sharing a run shares only its spans. */
  sessionId?: string;
}

const MAX_ATTRIBUTES = 128;
const MAX_STRING = 4096;
const MAX_ARRAY = 64;
const MAX_DEPTH = 6;
const MAX_EVENTS = 128;
export const SPAN_KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const SEVERITY_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max = MAX_STRING): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

/** Decode one OTLP AnyValue into plain JSON, bounded in size and depth. */
export function anyValue(value: unknown, depth = 0): AttrValue {
  const v = object(value);
  if (!v) return null;
  if (typeof v.stringValue === 'string') return v.stringValue.slice(0, MAX_STRING);
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (v.intValue !== undefined) {
    const number = Number(v.intValue);
    return Number.isSafeInteger(number) ? number : String(v.intValue).slice(0, 32);
  }
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (typeof v.doubleValue === 'string' && Number.isFinite(Number(v.doubleValue))) return Number(v.doubleValue);
  if (typeof v.bytesValue === 'string') return v.bytesValue.slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return '[nested value]';
  const array = object(v.arrayValue);
  if (array)
    return list(array.values)
      .slice(0, MAX_ARRAY)
      .map((item) => anyValue(item, depth + 1));
  const kvlist = object(v.kvlistValue);
  if (kvlist) return attributes(kvlist.values, depth + 1);
  return null;
}

export function attributes(values: unknown, depth = 0): Attributes {
  const result: Attributes = Object.create(null);
  let count = 0;
  for (const entry of list(values)) {
    const kv = object(entry);
    const key = text(kv?.key, 256);
    if (!kv || !key || count >= MAX_ATTRIBUTES) continue;
    result[key] = anyValue(kv.value, depth);
    count++;
  }
  return result;
}

/** Trace and span IDs are hex in OTLP/JSON; some exporters send base64. */
export function normalizeId(value: unknown, bytes: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const hexLength = bytes * 2;
  let id = value.toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${hexLength}}$`).test(id)) {
    const decoded = /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : undefined;
    if (decoded?.length !== bytes) return undefined;
    id = decoded.toString('hex');
  }
  return /^0+$/.test(id) ? undefined : id;
}

// The largest time a JavaScript Date can represent.
const MAX_TIME_MS = 8.64e15;

/** Unix nanoseconds (string or number) to fractional milliseconds; undefined outside the range a Date can hold. */
export function nanosToMs(value: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) ms = value / 1e6;
  else if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    const nanos = BigInt(value);
    if (nanos > 0n) ms = Number(nanos / 1000n) / 1000;
  }
  return ms !== undefined && ms <= MAX_TIME_MS ? ms : undefined;
}

function serviceOf(resource: Attributes): string {
  const name = resource['service.name'];
  return typeof name === 'string' && name ? name.slice(0, 200) : 'unknown_service';
}

export function readLogs(request: unknown, now = Date.now()): OtlpLog[] {
  const logs: OtlpLog[] = [];
  for (const group of list(object(request)?.resourceLogs)) {
    const resource = attributes(object(object(group)?.resource)?.attributes);
    const service = serviceOf(resource);
    for (const scoped of list(object(group)?.scopeLogs)) {
      const scope = text(object(object(scoped)?.scope)?.name, 256);
      for (const item of list(object(scoped)?.logRecords)) {
        const record = object(item);
        if (!record) continue;
        const severityNumber = Number(record.severityNumber);
        logs.push({
          timeMs: nanosToMs(record.timeUnixNano) ?? nanosToMs(record.observedTimeUnixNano) ?? now,
          service,
          resource,
          scope,
          severityNumber: Number.isInteger(severityNumber) && severityNumber > 0 ? severityNumber : undefined,
          severityText: text(record.severityText, 64) || undefined,
          body: anyValue(record.body),
          attributes: attributes(record.attributes),
          traceId: normalizeId(record.traceId, 16),
          spanId: normalizeId(record.spanId, 8),
          eventName: text(record.eventName, 256) || undefined,
        });
      }
    }
  }
  return logs;
}

export function readSpans(request: unknown): Span[] {
  const spans: Span[] = [];
  for (const group of list(object(request)?.resourceSpans)) {
    const resource = attributes(object(object(group)?.resource)?.attributes);
    const service = serviceOf(resource);
    for (const scoped of list(object(group)?.scopeSpans)) {
      const scope = text(object(object(scoped)?.scope)?.name, 256);
      for (const item of list(object(scoped)?.spans)) {
        const record = object(item);
        const traceId = normalizeId(record?.traceId, 16),
          spanId = normalizeId(record?.spanId, 8);
        const startMs = nanosToMs(record?.startTimeUnixNano);
        if (!record || !traceId || !spanId || startMs === undefined) continue;
        const endMs = Math.max(startMs, nanosToMs(record.endTimeUnixNano) ?? startMs);
        const status = object(record.status);
        const kind = Number(record.kind);
        spans.push({
          traceId,
          spanId,
          parentSpanId: normalizeId(record.parentSpanId, 8),
          name: text(record.name, 512) || '(unnamed span)',
          kind: Number.isInteger(kind) && kind >= 0 && kind <= 5 ? kind : 0,
          startMs,
          endMs,
          service,
          scope,
          attributes: attributes(record.attributes),
          events: list(record.events)
            .slice(0, MAX_EVENTS)
            .map((event) => ({
              timeMs: nanosToMs(object(event)?.timeUnixNano) ?? startMs,
              name: text(object(event)?.name, 512) ?? '',
              attributes: attributes(object(event)?.attributes),
            })),
          status: {
            code: Number(status?.code) === 2 ? 2 : Number(status?.code) === 1 ? 1 : 0,
            message: text(status?.message, 1024) || undefined,
          },
        });
      }
    }
  }
  return spans;
}

// Logline's own keys come first; an attribute with the same name is kept
// under `attributes.<name>` instead of replacing it.
function assign(target: Json, values: Attributes): void {
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(target, key)) target[`attributes.${key}`] = value;
    else if (key === '__proto__')
      Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    else target[key] = value;
  }
}

function withoutService(resource: Attributes): Attributes | undefined {
  const rest = Object.fromEntries(Object.entries(resource).filter(([key]) => key !== 'service.name'));
  return Object.keys(rest).length ? rest : undefined;
}

/** One JSON log line for a log record, in the shape Logline's JSON parser recognizes. */
export function logLine(log: OtlpLog): string {
  const line: Json = { timestamp: new Date(log.timeMs).toISOString() };
  // The severity number is standardized; the text is whatever the logging
  // library calls the level ("E", "Information", "err"), so it is kept as a field.
  const level =
    log.severityNumber !== undefined && log.severityNumber <= 24
      ? SEVERITY_LEVELS[Math.floor((log.severityNumber - 1) / 4)]
      : undefined;
  line.level = level ?? log.severityText;
  if (log.severityText && level) line.severityText = log.severityText;
  if (log.severityNumber !== undefined) line.severityNumber = log.severityNumber;
  if (typeof log.body === 'string' || typeof log.body === 'number' || typeof log.body === 'boolean')
    line.message = String(log.body);
  else {
    line.message = log.eventName ?? (log.body === null ? 'log record' : 'structured log record');
    if (log.body !== null) line.body = log.body;
  }
  line.service = log.service;
  if (log.traceId) line.traceId = log.traceId;
  if (log.spanId) line.spanId = log.spanId;
  if (log.eventName) line.eventName = log.eventName;
  if (log.scope) line.scope = log.scope;
  const resource = withoutService(log.resource);
  if (resource) line.resource = resource;
  assign(line, log.attributes);
  return JSON.stringify(line);
}

export function spanDurationMs(span: Span): number {
  return Math.round((span.endMs - span.startMs) * 1000) / 1000;
}

/** Entry spans begin work in a service: trace roots and incoming server or consumer spans. */
export function isEntrySpan(span: Span): boolean {
  return !span.parentSpanId || span.kind === 2 || span.kind === 5;
}

/** One JSON log line summarizing a span, so requests appear in the table and Analyze. */
export function spanLine(span: Span): string {
  const duration = spanDurationMs(span);
  const line: Json = {
    timestamp: new Date(span.startMs).toISOString(),
    level: span.status.code === 2 ? 'error' : 'info',
    message: `${span.name} (${duration < 10 ? duration.toFixed(2) : Math.round(duration)} ms)`,
    service: span.service,
    kind: 'span',
    spanKind: SPAN_KINDS[span.kind] ?? 'unspecified',
    traceId: span.traceId,
    spanId: span.spanId,
    durationMs: duration,
    spanStatus: span.status.code === 2 ? 'error' : span.status.code === 1 ? 'ok' : 'unset',
  };
  if (span.parentSpanId) line.parentSpanId = span.parentSpanId;
  if (span.status.message) line.statusMessage = span.status.message;
  assign(line, span.attributes);
  // Instrumentation records exceptions as span events; their stack traces
  // feed Logline's exception view and error grouping.
  const exception = span.events.find((event) => event.name === 'exception');
  if (exception) assign(line, exception.attributes);
  return JSON.stringify(line);
}
