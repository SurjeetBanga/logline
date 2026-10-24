import type { MetricSeriesData } from '../../core/metric-query';
import type { ConnectionView, HostMessage } from '../../protocol/messages';
import type { Elements } from '../dom';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';
import { formatMetric } from './metrics';

type Result = NonNullable<Extract<HostMessage, { type: 'metricQuery' }>['result']>;

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 220;
const MARGIN = { left: 64, right: 12, top: 10, bottom: 22 };
/** Distinct series colors, from the theme's chart palette. */
const COLORS = 6;
const SUGGEST_DELAY_MS = 250;

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** Tidy axis steps: 1, 2, or 5 times a power of ten. */
function ticks(low: number, high: number, count: number): number[] {
  const span = high - low || Math.abs(high) || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw)!;
  const values: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + step / 1e6; value += step) values.push(value);
  return values;
}

/**
 * The Metrics tab's metric query: a connection's time series over a range,
 * drawn as a chart. Hovering shows each series' value at that time; dragging
 * across the chart selects a window to show the logs of.
 */
export function createMetricQuery(
  elements: Elements,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    formatTime(ms: number): string;
    /** Fetch the logs of a connection from a window, with the Logs tab's filter. */
    showLogs(connectionId: string, fromMs: number, toMs: number): void;
    /** Show the local logs from a window. */
    showLocal(fromMs: number, toMs: number): void;
  },
) {
  let connections: ConnectionView[] = [];
  let signature = '';
  let result: Result | undefined;
  let selection: [number, number] | undefined;
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  const selected = () => connections.find((connection) => connection.id === elements.metricConnection.value);
  // The last hour, like a connection's log searches, rather than the first option.
  elements.metricRange.value = '1h';

  function placeholder(): void {
    const connection = selected();
    elements.metricInput.placeholder =
      connection?.type === 'datadog'
        ? 'avg:trace.http.request.duration{service:checkout} by {env}'
        : 'SELECT minute AS time, avg(duration_ms) AS value, service FROM requests GROUP BY 1, 3';
    elements.metricInput.title =
      connection?.type === 'datadog'
        ? 'A Datadog metric query'
        : 'A SELECT that returns a time, a value, and optionally columns that name series';
  }

  function updateWatch(): void {
    const query = elements.metricInput.value.trim();
    const watched = !!query && !!selected()?.watching?.includes(query);
    elements.metricWatch.setAttribute('aria-pressed', String(watched));
    elements.metricWatch.textContent = watched ? 'Stop watching' : 'Watch';
    elements.metricWatch.disabled = !query;
  }

  /** The snapshot's connections: the query bar shows while there is one to query. */
  function update(list: ConnectionView[] | undefined): void {
    connections = list ?? [];
    elements.metricQuery.hidden = !connections.length;
    const next = JSON.stringify(connections.map((connection) => [connection.id, connection.label]));
    if (next !== signature) {
      signature = next;
      const keep = elements.metricConnection.value;
      elements.metricConnection.replaceChildren(
        ...connections.map((connection) => {
          const option = document.createElement('option');
          option.value = connection.id;
          option.textContent = connection.label;
          return option;
        }),
      );
      elements.metricConnection.value = connections.some((connection) => connection.id === keep)
        ? keep
        : ((connections.find((connection) => connection.type === 'datadog') ?? connections[0])?.id ?? '');
      placeholder();
    }
    updateWatch();
  }

  function run(): void {
    const connection = selected();
    const query = elements.metricInput.value.trim();
    if (!connection || !query) return;
    selection = undefined;
    elements.metricSelection.hidden = true;
    elements.metricQueryStatus.textContent = 'Querying…';
    api.postMessage({ type: 'metricQuery', connectionId: connection.id, query, range: elements.metricRange.value });
  }

  function receive(message: Extract<HostMessage, { type: 'metricQuery' }>): void {
    if (message.connectionId !== elements.metricConnection.value || message.query !== elements.metricInput.value.trim())
      return;
    if (message.error || !message.result) {
      result = undefined;
      elements.metricQueryStatus.textContent = `Could not query: ${message.error ?? 'no result'}`;
      elements.metricChart.hidden = true;
      return;
    }
    result = message.result;
    const points = result.series.reduce((sum, series) => sum + series.points.length, 0);
    elements.metricQueryStatus.textContent = result.series.length
      ? `${result.series.length} series · ${points.toLocaleString()} points · ${result.elapsedMs.toLocaleString()} ms. Drag across the chart to show the logs from that time.`
      : 'No data for this query in the range.';
    draw();
  }

  function receiveNames(message: Extract<HostMessage, { type: 'metricNames' }>): void {
    if (message.connectionId !== elements.metricConnection.value) return;
    elements.metricSuggestions.replaceChildren(
      ...message.names.map((name) => {
        const option = document.createElement('option');
        option.value = name;
        return option;
      }),
    );
  }

  function draw(): void {
    const chart = elements.metricChart;
    const data = result;
    chart.hidden = !data?.series.length;
    if (!data?.series.length) return chart.replaceChildren();
    const width = Math.max(320, chart.clientWidth || 800);
    const unit = data.series.find((series) => series.unit)?.unit;
    const values = data.series.flatMap((series) => series.points.map(([, value]) => value));
    const low = Math.min(0, ...values);
    const high = Math.max(...values, low + 1);
    const yTicks = ticks(low, high * 1.05, 4);
    const top = yTicks.at(-1)!;
    const bottom = Math.min(low, yTicks[0]);
    const x = (time: number) =>
      MARGIN.left +
      ((time - data.fromMs) / Math.max(1, data.toMs - data.fromMs)) * (width - MARGIN.left - MARGIN.right);
    const y = (value: number) =>
      MARGIN.top + (1 - (value - bottom) / Math.max(1e-9, top - bottom)) * (HEIGHT - MARGIN.top - MARGIN.bottom);
    const time = (px: number) =>
      data.fromMs + ((px - MARGIN.left) / Math.max(1, width - MARGIN.left - MARGIN.right)) * (data.toMs - data.fromMs);
    const root = svg('svg', {
      class: 'metric-chart-svg',
      viewBox: `0 0 ${width} ${HEIGHT}`,
      width,
      height: HEIGHT,
      role: 'img',
    });
    root.setAttribute(
      'aria-label',
      `${data.series.length} series from ${actions.formatTime(data.fromMs)} to ${actions.formatTime(data.toMs)}`,
    );
    for (const value of yTicks) {
      root.append(
        svg('line', { class: 'metric-grid', x1: MARGIN.left, x2: width - MARGIN.right, y1: y(value), y2: y(value) }),
      );
      const label = svg('text', { class: 'metric-axis', x: MARGIN.left - 6, y: y(value) + 4, 'text-anchor': 'end' });
      label.textContent = formatMetric(value, unit);
      root.append(label);
    }
    for (let index = 0; index <= 4; index++) {
      const at = data.fromMs + ((data.toMs - data.fromMs) * index) / 4;
      const label = svg('text', {
        class: 'metric-axis',
        x: x(at),
        y: HEIGHT - 6,
        'text-anchor': index === 0 ? 'start' : index === 4 ? 'end' : 'middle',
      });
      label.textContent = actions.formatTime(at);
      root.append(label);
    }
    data.series.forEach((series, index) => {
      root.append(
        svg('polyline', {
          class: `metric-line metric-color-${index % COLORS}`,
          points: series.points.map(([at, value]) => `${x(at).toFixed(1)},${y(value).toFixed(1)}`).join(' '),
        }),
      );
    });
    const brush = svg('rect', {
      class: 'metric-brush',
      x: 0,
      y: MARGIN.top,
      width: 0,
      height: HEIGHT - MARGIN.top - MARGIN.bottom,
    });
    brush.setAttribute('visibility', 'hidden');
    const cursor = svg('line', { class: 'metric-cursor', x1: 0, x2: 0, y1: MARGIN.top, y2: HEIGHT - MARGIN.bottom });
    cursor.setAttribute('visibility', 'hidden');
    root.append(brush, cursor);
    const tooltip = document.createElement('div');
    tooltip.className = 'metric-tooltip';
    tooltip.hidden = true;
    const legend = document.createElement('ul');
    legend.className = 'metric-legend';
    legend.append(
      ...data.series.map((series, index) => {
        const item = document.createElement('li');
        const swatch = document.createElement('span');
        swatch.className = `metric-swatch metric-color-${index % COLORS}`;
        const latest = series.points.at(-1);
        const text = document.createElement('span');
        text.textContent = `${seriesName(series)}${latest ? ` · ${formatMetric(latest[1], series.unit)}` : ''}`;
        item.append(swatch, text);
        return item;
      }),
    );
    // Pointer position in chart units, whatever the chart's size on screen.
    const at = (event: PointerEvent) => {
      const box = root.getBoundingClientRect();
      const px = ((event.clientX - box.left) / Math.max(1, box.width)) * width;
      return Math.min(width - MARGIN.right, Math.max(MARGIN.left, px));
    };
    let start: number | undefined;
    scope.listen(root, 'pointerdown', (event) => {
      start = at(event as PointerEvent);
      brush.setAttribute('visibility', 'visible');
      brush.setAttribute('x', String(start));
      brush.setAttribute('width', '0');
    });
    scope.listen(root, 'pointermove', (event) => {
      const px = at(event as PointerEvent);
      if (start !== undefined) {
        brush.setAttribute('x', String(Math.min(start, px)));
        brush.setAttribute('width', String(Math.abs(px - start)));
      }
      const moment = time(px);
      cursor.setAttribute('x1', String(px));
      cursor.setAttribute('x2', String(px));
      cursor.setAttribute('visibility', 'visible');
      tooltip.hidden = false;
      tooltip.textContent = [
        actions.formatTime(moment),
        ...data.series.map((series) => {
          const nearest = series.points.reduce(
            (best, point) => (Math.abs(point[0] - moment) < Math.abs(best[0] - moment) ? point : best),
            series.points[0],
          );
          return `${seriesName(series)}: ${nearest ? formatMetric(nearest[1], series.unit) : '–'}`;
        }),
      ].join('\n');
    });
    scope.listen(root, 'pointerleave', () => {
      cursor.setAttribute('visibility', 'hidden');
      tooltip.hidden = true;
    });
    scope.listen(root, 'pointerup', (event) => {
      if (start === undefined) return;
      const end = at(event as PointerEvent);
      const [from, to] = [Math.min(start, end), Math.max(start, end)];
      start = undefined;
      // A click without a drag clears the selection.
      if (to - from < 4) {
        brush.setAttribute('visibility', 'hidden');
        select(undefined);
        return;
      }
      select([Math.floor(time(from)), Math.ceil(time(to))]);
    });
    chart.replaceChildren(root, tooltip, legend);
  }

  function seriesName(series: MetricSeriesData): string {
    return series.scope && series.scope !== '*' ? series.scope : series.name;
  }

  function select(window: [number, number] | undefined): void {
    selection = window;
    elements.metricSelection.hidden = !window;
    if (!window) return;
    elements.metricSelectionText.textContent = `${actions.formatTime(window[0])} – ${actions.formatTime(window[1])} selected`;
    elements.metricShowLogs.textContent = `Show logs from ${selected()?.label ?? 'the connection'}`;
  }

  scope.listen(elements.metricRun, 'click', run);
  scope.listen(elements.metricInput, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') run();
  });
  scope.listen(elements.metricInput, 'input', () => {
    updateWatch();
    clearTimeout(suggestTimer);
    const connection = selected();
    const search = elements.metricInput.value.trim();
    // Names are suggested while the first word of a query is typed.
    if (!connection || connection.type !== 'datadog' || !search || /[\s{(]/.test(search)) return;
    suggestTimer = setTimeout(
      () =>
        api.postMessage({ type: 'metricNames', connectionId: connection.id, search: search.replace(/^[a-z]+:/, '') }),
      SUGGEST_DELAY_MS,
    );
  });
  scope.listen(elements.metricConnection, 'change', () => {
    placeholder();
    updateWatch();
  });
  scope.listen(elements.metricWatch, 'click', () => {
    const connection = selected();
    const query = elements.metricInput.value.trim();
    if (!connection || !query) return;
    api.postMessage({
      type: 'metricWatch',
      connectionId: connection.id,
      query,
      enabled: !connection.watching?.includes(query),
    });
  });
  scope.listen(elements.metricShowLogs, 'click', () => {
    const connection = selected();
    if (connection && selection) actions.showLogs(connection.id, selection[0], selection[1]);
  });
  scope.listen(elements.metricShowLocal, 'click', () => {
    if (selection) actions.showLocal(selection[0], selection[1]);
  });
  scope.track(() => clearTimeout(suggestTimer));

  return { update, receive, receiveNames, run, redraw: draw };
}
