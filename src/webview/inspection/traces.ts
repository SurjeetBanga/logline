import type { TraceSummary } from '../../core/traces';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';
import type { TabRailItem } from '../tab-rail';
import { serviceColor } from './service-color';
import { formatDuration } from './trace';

/** Slower than this is a slow request, for the rail's filter. */
const SLOW_MS = 1000;
const REFRESH_MS = 5000;

/**
 * The Traces tab: recent requests across services, from OpenTelemetry
 * spans and from logs that carry a trace id. Choosing one opens its waterfall.
 */
export function createTraceList(
  elements: Elements,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    showTrace(traceId: string): void;
    formatTime(ms: number): string;
    startReceiver(): void;
    receiver(): { running: boolean; endpoint?: string };
    /** Shows the list in place of the table. */
    reveal(): void;
    visible(): boolean;
    /** The rail beside the list: its services and filters. */
    rail?(title: string, items: TabRailItem[]): void;
  },
) {
  let traces: TraceSummary[] = [];
  // Services left out of the list; new services show by default.
  const hidden = new Set<string>();
  let errorsOnly = false;
  let slowOnly = false;
  let opened: string | undefined;
  /** What the retained spans and logs were when the host last described them; a change means the list is behind. */
  let basis: string | undefined;
  let pending = false;
  let failed = false;
  /** Whether the rows on screen were drawn from `traces`. */
  let drawn = false;
  let loadedAt = -Infinity;
  let refresh: ReturnType<typeof setTimeout> | undefined;

  function load() {
    if (pending) return;
    pending = true;
    loadedAt = Date.now();
    api.postMessage({ type: 'traces' });
  }

  // Spans arrive in bursts, so a shown list refreshes at most once per interval.
  function refreshSoon() {
    if (refresh) return;
    refresh = setTimeout(
      () => {
        refresh = undefined;
        if (actions.visible()) load();
      },
      Math.max(0, loadedAt + REFRESH_MS - Date.now()),
    );
  }

  function show() {
    drawn = false;
    elements.tracesStatus.textContent = 'Loading…';
    elements.tracesRows.replaceChildren();
    actions.reveal();
    load();
  }

  /** Stops refreshing once another view is shown. */
  function hide() {
    clearTimeout(refresh);
    refresh = undefined;
  }

  scope.track(hide);

  /** Follows the retained spans and logs: a shown list loads again once they change. */
  function update(next: string) {
    const changed = basis !== undefined && next !== basis;
    basis = next;
    if (changed && actions.visible()) refreshSoon();
  }

  /** The host could not list the traces: say so in place of a list that would never load. */
  function fail(message: string) {
    pending = false;
    failed = true;
    if (actions.visible()) elements.tracesStatus.textContent = `Could not load traces: ${message}`;
  }

  scope.listen(elements.tracesStartReceiver, 'click', () => actions.startReceiver());
  scope.listen(elements.tracesRows, 'click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-trace-id]');
    if (!row?.dataset.traceId) return;
    open(row.dataset.traceId);
  });
  scope.listen(elements.tracesRows, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-trace-id]');
    if (!row?.dataset.traceId) return;
    event.preventDefault();
    open(row.dataset.traceId);
  });

  function open(traceId: string) {
    mark(traceId);
    actions.showTrace(traceId);
  }

  /** Marks the trace whose waterfall is open, however it was opened; a list still loading marks it once it renders. */
  function mark(traceId: string) {
    opened = traceId;
    for (const row of elements.tracesRows.querySelectorAll<HTMLElement>('.traces-row'))
      row.classList[row.dataset.traceId === traceId ? 'add' : 'remove']('selected');
  }

  /** The waterfall closed: no trace is marked in the list. */
  function closed() {
    opened = undefined;
    for (const row of elements.tracesRows.querySelectorAll<HTMLElement>('.traces-row.selected'))
      row.classList.remove('selected');
  }

  /** Services, with how many traces each is in, and the filters, for the rail. */
  function railItems(): TabRailItem[] {
    const counts = new Map<string, number>();
    for (const trace of traces)
      for (const service of trace.services) counts.set(service, (counts.get(service) ?? 0) + 1);
    const toggle = (change: () => void) => () => {
      change();
      render();
    };
    return [
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([service, count]): TabRailItem => ({
          kind: 'item',
          key: `service:${service}`,
          label: service,
          meta: count.toLocaleString(),
          color: serviceColor(service),
          checked: !hidden.has(service),
          title: `${hidden.has(service) ? 'Show' : 'Hide'} traces through ${service}`,
          onSelect: toggle(() => (hidden.has(service) ? hidden.delete(service) : hidden.add(service))),
        })),
      { kind: 'group', label: 'Show' },
      {
        kind: 'item',
        key: 'errors',
        label: 'Only traces with errors',
        meta: traces.filter((trace) => trace.errors).length.toLocaleString(),
        checked: errorsOnly,
        onSelect: toggle(() => (errorsOnly = !errorsOnly)),
      },
      {
        kind: 'item',
        key: 'slow',
        label: 'Slower than 1 s',
        meta: traces.filter((trace) => trace.durationMs >= SLOW_MS).length.toLocaleString(),
        checked: slowOnly,
        onSelect: toggle(() => (slowOnly = !slowOnly)),
      },
    ];
  }

  // The receiver can start or stop while the list is shown.
  function receiverChanged() {
    if (actions.visible() && !failed) render();
  }

  function receive(list: TraceSummary[]) {
    pending = false;
    // Most refreshes find the list as it was; leaving the rows alone keeps focus and scroll steady.
    const unchanged = !failed && drawn && JSON.stringify(list) === JSON.stringify(traces);
    failed = false;
    traces = list;
    if (actions.visible() && !unchanged) render();
  }

  function render() {
    drawn = true;
    actions.rail?.('Services', railItems());
    const shown = traces.filter(
      (trace) =>
        (!errorsOnly || trace.errors) &&
        (!slowOnly || trace.durationMs >= SLOW_MS) &&
        // A trace through no listed service, such as one from logs alone, stays.
        (!trace.services.length || trace.services.some((service) => !hidden.has(service))),
    );
    const withSpans = traces.filter((trace) => trace.spans).length;
    const receiver = actions.receiver();
    // Offer to start the receiver only when it is not already running.
    elements.tracesStartReceiver.hidden = receiver.running || withSpans > 0;
    if (!traces.length) {
      elements.tracesStatus.textContent = receiver.running
        ? `No traces yet. The OpenTelemetry receiver is listening on ${receiver.endpoint ?? 'localhost'}: run an app with OTEL_EXPORTER_OTLP_ENDPOINT=${receiver.endpoint ?? 'http://127.0.0.1:4318'}, or log JSON with a traceId field.`
        : 'No traces yet. Start the OpenTelemetry receiver and run an instrumented app, or log JSON with a traceId field.';
      elements.tracesRows.replaceChildren();
      return;
    }
    const failed = traces.filter((trace) => trace.errors).length;
    elements.tracesStatus.textContent =
      `${traces.length.toLocaleString()} recent ${traces.length === 1 ? 'trace' : 'traces'} · ${failed.toLocaleString()} with errors` +
      (withSpans < traces.length ? ` · ${(traces.length - withSpans).toLocaleString()} from logs only` : '') +
      (shown.length < traces.length ? ` · ${shown.length.toLocaleString()} shown` : '') +
      ' · Choose one to see its waterfall';
    const longest = Math.max(1, ...shown.map((trace) => trace.durationMs));
    // A refresh replaces the rows, so the one holding focus is found again afterwards.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.traces-row');
    const focusedId = focused && elements.tracesRows.contains(focused) ? focused.dataset.traceId : undefined;
    elements.tracesRows.replaceChildren(
      ...shown.map((trace) => {
        const row = document.createElement('tr');
        row.className = `traces-row${trace.errors ? ' trace-error' : ''}${trace.traceId === opened ? ' selected' : ''}`;
        row.dataset.traceId = trace.traceId;
        row.tabIndex = 0;
        row.setAttribute(
          'aria-label',
          `${trace.name}, ${formatDuration(trace.durationMs)}${trace.errors ? `, ${trace.errors} errors` : ''}`,
        );
        const name = cell('', 'trace-name');
        // The operation is often long, such as a full request path: it wraps to two lines, and the tooltip has all of it.
        const nameText = document.createElement('span');
        nameText.className = 'trace-name-text';
        nameText.textContent = `${trace.errors ? '⚠ ' : ''}${trace.name || trace.traceId}`;
        name.append(nameText);
        name.title = `${trace.name || trace.traceId}\nTrace ${trace.traceId}`;
        // The service that starts the trace, and how many others it reaches; the title names them all.
        const services = cell('', 'traces-services');
        const [first, ...others] = trace.services;
        if (first) {
          const chip = document.createElement('span');
          chip.className = 'service-chip';
          const dot = document.createElement('span');
          dot.className = 'service-dot';
          dot.style.background = serviceColor(first);
          chip.append(dot, document.createTextNode(first));
          services.append(chip);
          if (others.length) {
            const more = document.createElement('span');
            more.className = 'traces-more-services';
            more.textContent = `+${others.length}`;
            services.append(more);
          }
          services.title = trace.services.join(', ');
        }
        const duration = cell('', 'traces-duration');
        // Flex layout goes inside the cell; a flex table cell stops lining up with its row.
        const durationContent = document.createElement('div');
        durationContent.className = 'traces-duration-content';
        const track = document.createElement('div');
        track.className = 'trace-track';
        const bar = document.createElement('div');
        bar.className = 'trace-bar';
        bar.style.left = '0';
        bar.style.width = `${Math.max(1, (trace.durationMs / longest) * 100)}%`;
        track.append(bar);
        const label = document.createElement('span');
        label.className = 'traces-duration-label';
        label.textContent = formatDuration(trace.durationMs);
        durationContent.append(track, label);
        duration.append(durationContent);
        const counts = [trace.spans ? `${trace.spans} spans` : '', trace.logs ? `${trace.logs} logs` : '']
          .filter(Boolean)
          .join(' · ');
        row.append(
          cell(trace.startMs === undefined ? '' : actions.formatTime(trace.startMs), 'time'),
          name,
          services,
          duration,
          cell(counts, 'traces-counts'),
        );
        return row;
      }),
    );
    if (focusedId)
      [...elements.tracesRows.querySelectorAll<HTMLElement>('.traces-row')]
        .find((row) => row.dataset.traceId === focusedId)
        ?.focus();
  }

  return { show, hide, update, fail, receive, receiverChanged, mark, closed };
}
