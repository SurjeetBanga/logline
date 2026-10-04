import type { TraceSummary } from '../../core/traces';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';
import { formatDuration } from './trace';

/**
 * The Traces dialog: recent requests across services, from OpenTelemetry
 * spans and from logs that carry a trace id. Choosing one opens its waterfall.
 */
export function createTraceList(elements: Elements, api: WebviewApi, scope: EventScope,
  actions: { showTrace(traceId: string): void; formatTime(ms: number): string; startReceiver(): void }) {
  let traces: TraceSummary[] = [];

  function show() {
    elements.tracesStatus.textContent = 'Loading…';
    elements.tracesRows.replaceChildren();
    if (!elements.tracesDialog.open) elements.tracesDialog.showModal();
    api.postMessage({ type: 'traces' });
  }

  scope.listen(elements.traces, 'click', show);
  scope.listen(elements.tracesClose, 'click', () => elements.tracesDialog.close());
  scope.listen(elements.tracesErrorsOnly, 'change', render);
  scope.listen(elements.tracesStartReceiver, 'click', () => { actions.startReceiver(); elements.tracesDialog.close(); });
  scope.listen(elements.tracesRows, 'click', event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-trace-id]');
    if (!row?.dataset.traceId) return;
    elements.tracesDialog.close();
    actions.showTrace(row.dataset.traceId);
  });
  scope.listen(elements.tracesRows, 'keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-trace-id]');
    if (!row?.dataset.traceId) return;
    event.preventDefault();
    elements.tracesDialog.close();
    actions.showTrace(row.dataset.traceId);
  });

  function receive(list: TraceSummary[]) {
    traces = list;
    if (elements.tracesDialog.open) render();
  }

  function render() {
    const errorsOnly = elements.tracesErrorsOnly.checked;
    const shown = errorsOnly ? traces.filter(trace => trace.errors) : traces;
    const withSpans = traces.filter(trace => trace.spans).length;
    elements.tracesStartReceiver.hidden = withSpans > 0;
    if (!traces.length) {
      elements.tracesStatus.textContent = 'No traces yet. Start the OpenTelemetry receiver and run an instrumented app, or log JSON with a traceId field.';
      elements.tracesRows.replaceChildren();
      return;
    }
    const failed = traces.filter(trace => trace.errors).length;
    elements.tracesStatus.textContent = `${traces.length.toLocaleString()} recent ${traces.length === 1 ? 'trace' : 'traces'} · ${failed.toLocaleString()} with errors`
      + (withSpans < traces.length ? ` · ${(traces.length - withSpans).toLocaleString()} from logs only` : '') + ' · Choose one to see its waterfall';
    const longest = Math.max(1, ...shown.map(trace => trace.durationMs));
    elements.tracesRows.replaceChildren(...shown.map(trace => {
      const row = document.createElement('tr');
      row.className = `traces-row${trace.errors ? ' trace-error' : ''}`;
      row.dataset.traceId = trace.traceId;
      row.tabIndex = 0;
      row.setAttribute('aria-label', `${trace.name}, ${formatDuration(trace.durationMs)}${trace.errors ? `, ${trace.errors} errors` : ''}`);
      const name = cell(`${trace.errors ? '⚠ ' : ''}${trace.name || trace.traceId}`, 'trace-name');
      name.title = `Trace ${trace.traceId}`;
      const services = cell('', 'traces-services');
      for (const service of trace.services.slice(0, 4)) {
        const chip = document.createElement('span');
        chip.className = 'service-chip';
        chip.textContent = service;
        services.append(chip);
      }
      if (trace.services.length > 4) services.append(document.createTextNode(` +${trace.services.length - 4}`));
      const duration = cell('', 'traces-duration');
      const track = document.createElement('div');
      track.className = 'trace-track';
      const bar = document.createElement('div');
      bar.className = 'trace-bar';
      bar.style.left = '0';
      bar.style.width = `${Math.max(1, trace.durationMs / longest * 100)}%`;
      track.append(bar);
      const label = document.createElement('span');
      label.className = 'traces-duration-label';
      label.textContent = formatDuration(trace.durationMs);
      duration.append(track, label);
      const counts = [trace.spans ? `${trace.spans} spans` : '', trace.logs ? `${trace.logs} logs` : ''].filter(Boolean).join(' · ');
      row.append(cell(trace.startMs === undefined ? '' : actions.formatTime(trace.startMs), 'time'), name, services, duration, cell(counts, 'traces-counts'));
      return row;
    }));
  }

  return { show, receive };
}
