import type { TraceLog, TraceRow, TraceView } from '../../core/traces';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';

export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** The trace waterfall dialog: spans across services with their logs interleaved. */
export function createTraceView(elements: Elements, api: WebviewApi, scope: EventScope,
  actions: { showContext(id: number): void; applyQuery(query: string): void; showList(): void }) {
  let current: string | undefined;

  /** @param fromList Opened from the Traces list, which the dialog offers to return to. */
  function show(traceId: string, fromList = false) {
    current = traceId.toLowerCase();
    elements.traceBack.hidden = !fromList;
    elements.traceTitle.textContent = `Trace ${current.length > 12 ? `${current.slice(0, 8)}…${current.slice(-4)}` : current}`;
    elements.traceTitle.title = current;
    elements.traceStatus.textContent = 'Loading…';
    elements.traceRows.replaceChildren();
    if (!elements.traceDialog.open) elements.traceDialog.showModal();
    api.postMessage({ type: 'trace', traceId: current });
  }

  scope.listen(elements.traceClose, 'click', () => elements.traceDialog.close());
  scope.listen(elements.traceBack, 'click', () => { elements.traceDialog.close(); actions.showList(); });
  scope.listen(elements.traceDialog, 'close', () => { current = undefined; elements.traceRows.replaceChildren(); });
  scope.listen(elements.traceFilter, 'click', () => {
    if (!current) return;
    const query = `traceId:${current}`;
    elements.traceDialog.close();
    actions.applyQuery(query);
  });
  scope.listen(elements.traceRows, 'click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('.trace-log-button');
    if (!button) return;
    elements.traceDialog.close();
    actions.showContext(Number(button.dataset.id));
  });

  function receive(trace: TraceView) {
    if (!elements.traceDialog.open || trace.traceId !== current) return;
    elements.traceStatus.textContent = summary(trace);
    const total = Math.max(trace.durationMs, 0.001);
    const logsBySpan = new Map<string, TraceLog[]>();
    const unattached: TraceLog[] = [];
    const spanIds = new Set(trace.spans.map(span => span.spanId));
    for (const log of trace.logs) {
      if (log.spanId && spanIds.has(log.spanId)) logsBySpan.set(log.spanId, [...(logsBySpan.get(log.spanId) ?? []), log]);
      else unattached.push(log);
    }
    const rows: HTMLTableRowElement[] = [];
    for (const span of trace.spans) {
      rows.push(spanRow(span, total));
      for (const log of logsBySpan.get(span.spanId) ?? []) rows.push(logRow(log, total, span.depth + 1));
    }
    if (unattached.length) {
      if (trace.spans.length) {
        const heading = document.createElement('tr');
        heading.className = 'trace-section';
        const label = cell('Logs not linked to a received span');
        label.colSpan = 4;
        heading.append(label);
        rows.push(heading);
      }
      for (const log of unattached) rows.push(logRow(log, total, 0));
    }
    elements.traceRows.replaceChildren(...rows);
  }

  return { show, receive, get open() { return elements.traceDialog.open; } };
}

function summary(trace: TraceView): string {
  if (!trace.spans.length && !trace.logs.length) {
    return 'No spans or retained logs have this trace id. Turn on the OpenTelemetry receiver in More actions to collect spans from instrumented apps.';
  }
  if (!trace.spans.length) {
    return `${trace.logs.length} retained log${trace.logs.length === 1 ? '' : 's'} with this trace id over ${formatDuration(trace.durationMs)}. No spans were received for it.`;
  }
  const spans = trace.spans.length + trace.omitted;
  const parts = [
    `${trace.services.length} service${trace.services.length === 1 ? '' : 's'}`, `${spans} span${spans === 1 ? '' : 's'}`, formatDuration(trace.durationMs),
    trace.errors ? `${trace.errors} error${trace.errors === 1 ? '' : 's'}` : 'no errors', `${trace.logs.length} log${trace.logs.length === 1 ? '' : 's'}`
  ];
  return `${parts.join(' · ')} · Highlighted spans are the critical path${trace.omitted ? ` · First ${trace.spans.length} spans shown` : ''}`;
}

function timeline(offset: number, duration: number | undefined, total: number, className: string): HTMLTableCellElement {
  const container = cell('', 'trace-timeline');
  const track = document.createElement('div');
  track.className = 'trace-track';
  const mark = document.createElement('div');
  mark.className = className;
  // Positions are set through the CSSOM, which the webview's style policy allows.
  mark.style.left = `${Math.min(100, Math.max(0, offset / total * 100))}%`;
  if (duration !== undefined) mark.style.width = `${Math.max(0.4, Math.min(100, duration / total * 100))}%`;
  track.append(mark);
  container.append(track);
  return container;
}

function spanRow(span: TraceRow, total: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = `trace-span${span.error ? ' trace-error' : ''}${span.critical ? ' trace-critical' : ''}`;
  const name = cell('', 'trace-name');
  const label = document.createElement('span');
  label.className = 'trace-indent';
  label.style.paddingInlineStart = `${Math.min(span.depth, 24) * 14}px`;
  label.textContent = `${span.error ? '⚠ ' : ''}${span.name}`;
  name.append(label);
  name.title = [
    `${span.name} (${span.kind})`, span.statusMessage ? `Error: ${span.statusMessage}` : undefined,
    ...Object.entries(span.attributes).map(([key, value]) => `${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}`),
    ...span.events.map(event => `event: ${event.name} at +${formatDuration(event.offsetMs)}`)
  ].filter(Boolean).join('\n');
  const bar = timeline(span.offsetMs, span.durationMs, total, 'trace-bar');
  bar.setAttribute('aria-label', `Starts at +${formatDuration(span.offsetMs)}`);
  row.append(name, cell(span.service, 'trace-service'), bar, cell(formatDuration(span.durationMs), 'trace-duration'));
  return row;
}

function logRow(log: TraceLog, total: number, depth: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'trace-log';
  const name = cell('', 'trace-name');
  const button = document.createElement('button');
  button.className = 'trace-log-button';
  button.dataset.id = String(log.id);
  button.style.marginInlineStart = `${Math.min(depth, 24) * 14}px`;
  button.title = 'Show surrounding logs';
  const level = document.createElement('span');
  level.className = `level ${log.level}`;
  level.textContent = log.level;
  button.append(level, document.createTextNode(` ${log.message}`));
  name.append(button);
  row.append(name, cell(log.server ?? '', 'trace-service'),
    timeline(log.offsetMs ?? 0, undefined, total, 'trace-log-mark'), cell(log.offsetMs === undefined ? '' : `${log.offsetMs < 0 ? '−' : '+'}${formatDuration(Math.abs(log.offsetMs))}`, 'trace-duration'));
  return row;
}
