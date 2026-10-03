import { spanDurationMs, SPAN_KINDS, type AttrValue, type Span } from './otlp';

/** Spans grouped by trace, bounded by count; the oldest received spans go first. */
export class SpanStore {
  private readonly traces = new Map<string, Span[]>();
  private queue: (Span | undefined)[] = [];
  private head = 0;
  private count = 0;
  /** Bumps whenever spans are added or removed, for change detection. */
  revision = 0;

  constructor(public maxSpans = 20000) { }

  get size(): number { return this.count; }

  add(span: Span): boolean {
    const spans = this.traces.get(span.traceId) ?? [];
    // Exporters retry failed batches, which can resend spans already stored.
    if (spans.some(existing => existing.spanId === span.spanId)) return false;
    spans.push(span);
    this.traces.set(span.traceId, spans);
    this.queue.push(span);
    this.count++;
    while (this.count > this.maxSpans) this.evict();
    this.revision++;
    return true;
  }

  trace(traceId: string): readonly Span[] { return this.traces.get(traceId.toLowerCase()) ?? []; }

  clear(): void {
    this.traces.clear();
    this.queue = [];
    this.head = 0;
    this.count = 0;
    this.revision++;
  }

  private evict(): void {
    const span = this.queue[this.head];
    this.queue[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
    if (!span) return;
    this.count--;
    const spans = this.traces.get(span.traceId);
    if (!spans) return;
    const index = spans.indexOf(span);
    if (index !== -1) spans.splice(index, 1);
    if (!spans.length) this.traces.delete(span.traceId);
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
