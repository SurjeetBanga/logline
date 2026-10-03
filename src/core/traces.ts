import { spanDurationMs, SPAN_KINDS, type AttrValue, type Span } from './otlp';
import { getField } from './query';
import type { LogEvent } from './types';

// Approximate retained size of a span: its strings and attribute JSON, plus overhead.
function spanBytes(span: Span): number {
  let bytes = 256 + (span.name.length + span.service.length) * 2 + JSON.stringify(span.attributes).length * 2;
  for (const event of span.events) bytes += 64 + event.name.length * 2 + JSON.stringify(event.attributes).length * 2;
  return bytes;
}

/** Spans grouped by trace, bounded by count and approximate size; the oldest received spans go first. */
export class SpanStore {
  // Span ids per trace make duplicate checks constant time in traces with many spans.
  private readonly traces = new Map<string, { spans: Span[]; ids: Set<string> }>();
  private queue: ({ span: Span; bytes: number } | undefined)[] = [];
  private head = 0;
  private count = 0;
  private bytes = 0;
  /** Bumps whenever spans are added or removed, for change detection. */
  revision = 0;

  constructor(public maxSpans = 20000, public maxBytes = 64 * 1024 * 1024) { }

  get size(): number { return this.count; }

  add(span: Span): boolean {
    let trace = this.traces.get(span.traceId);
    // Exporters retry failed batches, which can resend spans already stored.
    if (trace?.ids.has(span.spanId)) return false;
    const bytes = spanBytes(span);
    if (bytes > this.maxBytes) return false;
    if (!trace) { trace = { spans: [], ids: new Set() }; this.traces.set(span.traceId, trace); }
    trace.spans.push(span);
    trace.ids.add(span.spanId);
    this.queue.push({ span, bytes });
    this.count++;
    this.bytes += bytes;
    while (this.count > this.maxSpans || this.bytes > this.maxBytes) this.evict();
    this.revision++;
    return true;
  }

  trace(traceId: string): readonly Span[] { return this.traces.get(traceId.toLowerCase())?.spans ?? []; }

  /** Every retained trace with its spans. */
  *entries(): IterableIterator<[string, readonly Span[]]> {
    for (const [traceId, trace] of this.traces) yield [traceId, trace.spans];
  }

  get traceCount(): number { return this.traces.size; }

  clear(): void {
    this.traces.clear();
    this.queue = [];
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
    this.revision++;
  }

  private evict(): void {
    const entry = this.queue[this.head];
    this.queue[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
    if (!entry) return;
    const { span } = entry;
    this.count--;
    this.bytes -= entry.bytes;
    const trace = this.traces.get(span.traceId);
    if (!trace) return;
    // Spans leave in arrival order, so the evicted span is normally first.
    const index = trace.spans.indexOf(span);
    if (index !== -1) trace.spans.splice(index, 1);
    trace.ids.delete(span.spanId);
    if (!trace.spans.length) this.traces.delete(span.traceId);
  }
}

export interface TraceRow {
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: string;
  kind: string;
  /** Milliseconds from the start of the trace. */
  offsetMs: number;
  durationMs: number;
  depth: number;
  error: boolean;
  statusMessage?: string;
  /** On the chain of spans that determined when the trace finished. */
  critical: boolean;
  attributes: Record<string, AttrValue>;
  events: { offsetMs: number; name: string }[];
}

export interface TraceLogInput { id: number; level: string; message: string; timeMs?: number; spanId?: string; server?: string; }
export interface TraceLog { id: number; level: string; message: string; offsetMs?: number; spanId?: string; server?: string; }

export interface TraceView {
  traceId: string;
  startMs?: number;
  durationMs: number;
  services: string[];
  spans: TraceRow[];
  errors: number;
  /** Spans beyond the display limit. */
  omitted: number;
  logs: TraceLog[];
}

const MAX_ROW_ATTRIBUTES = 24;

/**
 * Log entries for a trace view, oldest first, from events matching a trace
 * id. A span's own table row is left out when its span is drawn anyway.
 */
export function traceLogs(events: readonly LogEvent[], traceId: string, hasSpans: boolean,
  message: (event: LogEvent) => string = event => event.message ?? ''): TraceLogInput[] {
  return events
    .filter(event => String(getField(event, 'traceId') ?? '').toLowerCase() === traceId && !(hasSpans && getField(event, 'kind') === 'span'))
    .sort((a, b) => a.id - b.id)
    .map(event => {
      const spanId = getField(event, 'spanId');
      return { id: event.id, level: event.level, message: message(event), timeMs: event.timestampMs,
        spanId: typeof spanId === 'string' ? spanId.toLowerCase() : undefined, server: event.server };
    });
}

/**
 * Arrange a trace's spans as a depth-first waterfall. Spans whose parent was
 * not received become roots. The critical path follows, from the root that
 * ends last, the child that ends last at each level.
 */
export function buildTrace(traceId: string, spans: readonly Span[], logs: TraceLogInput[] = [], limit = 2000): TraceView {
  const byId = new Map(spans.map(span => [span.spanId, span]));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    if (span.parentSpanId && span.parentSpanId !== span.spanId && byId.has(span.parentSpanId)) {
      const list = children.get(span.parentSpanId) ?? [];
      list.push(span);
      children.set(span.parentSpanId, list);
    } else roots.push(span);
  }
  const byStart = (a: Span, b: Span) => a.startMs - b.startMs || a.endMs - b.endMs;
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);

  const critical = new Set<string>();
  let node = roots.reduce<Span | undefined>((latest, span) => !latest || span.endMs > latest.endMs ? span : latest, undefined);
  while (node && !critical.has(node.spanId)) {
    critical.add(node.spanId);
    node = (children.get(node.spanId) ?? []).reduce<Span | undefined>((latest, span) => !latest || span.endMs >= latest.endMs ? span : latest, undefined);
  }

  let startMs: number | undefined, endMs: number | undefined;
  for (const span of spans) {
    if (startMs === undefined || span.startMs < startMs) startMs = span.startMs;
    if (endMs === undefined || span.endMs > endMs) endMs = span.endMs;
  }
  // Without spans, the trace's logs alone set its time range.
  if (!spans.length) for (const log of logs) {
    if (log.timeMs === undefined) continue;
    if (startMs === undefined || log.timeMs < startMs) startMs = log.timeMs;
    if (endMs === undefined || log.timeMs > endMs) endMs = log.timeMs;
  }
  const rows: TraceRow[] = [];
  const visited = new Set<string>();
  // An explicit stack keeps malformed, deeply nested traces from overflowing the call stack.
  const stack: { span: Span; depth: number }[] = roots.slice().reverse().map(span => ({ span, depth: 0 }));
  while (stack.length) {
    const { span, depth } = stack.pop()!;
    if (visited.has(span.spanId)) continue;
    visited.add(span.spanId);
    if (rows.length < limit) rows.push({
      spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, service: span.service, kind: SPAN_KINDS[span.kind] ?? 'unspecified',
      offsetMs: span.startMs - (startMs ?? span.startMs), durationMs: spanDurationMs(span), depth, error: span.status.code === 2,
      statusMessage: span.status.message, critical: critical.has(span.spanId),
      attributes: Object.fromEntries(Object.entries(span.attributes).slice(0, MAX_ROW_ATTRIBUTES)),
      events: span.events.slice(0, 16).map(event => ({ offsetMs: event.timeMs - (startMs ?? event.timeMs), name: event.name }))
    });
    for (const child of (children.get(span.spanId) ?? []).slice().reverse()) stack.push({ span: child, depth: depth + 1 });
  }
  return {
    traceId, startMs, durationMs: startMs === undefined || endMs === undefined ? 0 : Math.round((endMs - startMs) * 1000) / 1000,
    services: [...new Set(spans.map(span => span.service))].sort(),
    spans: rows, errors: spans.filter(span => span.status.code === 2).length, omitted: Math.max(0, visited.size - rows.length),
    logs: logs.map(({ timeMs, ...log }) => ({ ...log, offsetMs: timeMs === undefined || startMs === undefined ? undefined : timeMs - startMs }))
  };
}

/** One row of the trace list: a request across services, from its spans or its logs. */
export interface TraceSummary {
  traceId: string;
  /** The root operation, or the first log message when the trace has no spans. */
  name: string;
  /** The service of the root span, or the source of the first log. */
  service?: string;
  services: string[];
  startMs?: number;
  durationMs: number;
  spans: number;
  logs: number;
  errors: number;
}

/**
 * Recent traces, newest first: every retained trace with spans, plus trace
 * ids that only appear in logs (JSON logs that carry a trace id).
 *
 * @param events Retained events that have a trace id, in any order.
 */
export function summarizeTraces(traces: Iterable<[string, readonly Span[]]>, events: readonly LogEvent[], limit = 200): TraceSummary[] {
  const summaries = new Map<string, TraceSummary>();
  for (const [traceId, spans] of traces) {
    if (!spans.length) continue;
    let root: Span | undefined;
    let start = Infinity, end = -Infinity, errors = 0;
    const ids = new Set(spans.map(span => span.spanId));
    for (const span of spans) {
      if (span.startMs < start) start = span.startMs;
      if (span.endMs > end) end = span.endMs;
      if (span.status.code === 2) errors++;
      const isRoot = !span.parentSpanId || !ids.has(span.parentSpanId);
      if (isRoot && (!root || span.startMs < root.startMs)) root = span;
    }
    summaries.set(traceId, {
      traceId, name: root?.name ?? spans[0].name, service: root?.service, services: [...new Set(spans.map(span => span.service))].sort(),
      startMs: start, durationMs: Math.round((end - start) * 1000) / 1000, spans: spans.length, logs: 0, errors
    });
  }
  const logOnly = new Map<string, { first: LogEvent; start: number; end: number; services: Set<string> }>();
  for (const event of events) {
    const value = getField(event, 'traceId');
    if (typeof value !== 'string' || !value || getField(event, 'kind') === 'span') continue;
    const traceId = value.toLowerCase();
    const known = summaries.get(traceId);
    const failed = event.level === 'error' || event.level === 'fatal';
    // Errors of a trace with spans come from span status; its logs are only counted.
    if (known?.spans) { known.logs++; continue; }
    const time = event.timestampMs ?? NaN;
    const entry = logOnly.get(traceId);
    if (!entry) {
      logOnly.set(traceId, { first: event, start: time, end: time, services: new Set(event.server ? [event.server] : []) });
      summaries.set(traceId, { traceId, name: event.message ?? '', service: event.server, services: [], startMs: undefined, durationMs: 0, spans: 0, logs: 1, errors: failed ? 1 : 0 });
      continue;
    }
    const summary = summaries.get(traceId)!;
    summary.logs++;
    if (failed) summary.errors++;
    if (event.server) entry.services.add(event.server);
    if (time < entry.start || Number.isNaN(entry.start)) entry.start = time;
    if (time > entry.end || Number.isNaN(entry.end)) entry.end = time;
    if (event.id < entry.first.id) { entry.first = event; summary.name = event.message ?? ''; summary.service = event.server; }
  }
  for (const [traceId, entry] of logOnly) {
    const summary = summaries.get(traceId)!;
    summary.services = [...entry.services].sort();
    if (Number.isFinite(entry.start)) { summary.startMs = entry.start; summary.durationMs = Math.max(0, entry.end - entry.start); }
  }
  return [...summaries.values()]
    .sort((a, b) => (b.startMs ?? -Infinity) - (a.startMs ?? -Infinity) || a.traceId.localeCompare(b.traceId))
    .slice(0, limit);
}
