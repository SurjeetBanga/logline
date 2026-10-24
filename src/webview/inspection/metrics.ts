import type { MetricSeriesView } from '../../core/metrics';
import type { ConnectionView } from '../../protocol/messages';
import type { Elements } from '../dom';
import type { EventScope } from '../event-scope';
import type { TabRailItem } from '../tab-rail';
import type { WebviewApi } from '../types';
import { serviceColor } from './service-color';
import { formatDuration } from './trace';

const REFRESH_MS = 5000;
const MEASURE_LABELS: Record<MetricSeriesView['measure'], string> = {
  value: '',
  rate: 'rate',
  p95: 'p95',
  average: 'avg',
};
const DURATION_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, μs: 1e-3, ms: 1, s: 1000, min: 60000, h: 3600000 };

function number(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4)
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  if (magnitude >= 100 || Number.isInteger(value)) return Math.round(value).toLocaleString();
  return value
    .toPrecision(magnitude >= 1 ? 3 : 2)
    .replace(/\.?0+$/, '')
    .replace(/^-?0$/, '0');
}

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  while (Math.abs(value) >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${number(value)} ${units[index]}`;
}

/** A metric value in its OpenTelemetry unit (UCUM, such as `ms`, `By`, or `{request}`). */
export function formatMetric(value: number, unit = '', rate = false): string {
  const suffix = rate ? '/s' : '';
  if (DURATION_MS[unit] !== undefined && !rate) return formatDuration(value * DURATION_MS[unit]);
  if (unit === 'By') return `${bytes(value)}${suffix}`;
  if (unit === '%') return `${number(value)}%${suffix}`;
  // `1` is a dimensionless count; braces annotate what is counted.
  const label = unit === '1' ? '' : unit.replace(/^\{(.*)\}$/, '$1');
  return `${number(value)}${label ? ` ${label}` : ''}${suffix}`;
}

function sparkline(points: MetricSeriesView['points'], className = 'metric-spark'): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  if (points.length < 2) return svg;
  const values = points.map((point) => point.value);
  const low = Math.min(...values),
    high = Math.max(...values);
  const first = points[0].timeMs,
    span = Math.max(1, points[points.length - 1].timeMs - first);
  const line = document.createElementNS(namespace, 'polyline');
  line.setAttribute(
    'points',
    points
      .map((point) => {
        const x = ((point.timeMs - first) / span) * 100;
        // A flat series sits mid-height instead of on the bottom edge.
        const y = high === low ? 12 : 22 - ((point.value - low) / (high - low)) * 20;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' '),
  );
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  return svg;
}

/** Everything known about a series' latest point, for its tooltip. */
function details(series: MetricSeriesView): string {
  const rate = series.measure === 'rate';
  const format = (value: number) => formatMetric(value, series.unit);
  const parts = [
    series.description,
    series.total !== undefined ? `Total ${formatMetric(series.total, series.unit)}` : '',
    series.count !== undefined ? `${series.count.toLocaleString()} recorded in the latest interval` : '',
    series.average !== undefined && series.measure !== 'average' ? `avg ${format(series.average)}` : '',
    series.p50 !== undefined ? `p50 ${format(series.p50)}` : '',
    series.min !== undefined ? `min ${format(series.min)}` : '',
    series.max !== undefined ? `max ${format(series.max)}` : '',
    rate
      ? 'Rate per second between the latest two points'
      : series.bound
        ? "At most this: the histogram's buckets are too wide to estimate the p95 more closely. Set bucket boundaries that suit the unit."
        : series.measure === 'p95'
          ? 'p95 of the values recorded in the latest interval'
          : '',
    `${series.kind}${series.unit ? ` · unit ${series.unit}` : ''}`,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * The Metrics tab: OpenTelemetry metric series received by Logline's
 * receiver, with their latest value and a trend of recent points. Counters
 * show a rate, histograms their p95, and gauges their value.
 */
export function createMetricList(
  elements: Elements,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    /** Shows the list in place of the table. */
    reveal(): void;
    visible(): boolean;
    /** The rail beside the cards: services, and connections to query. */
    rail?(title: string, items: TabRailItem[]): void;
    /** Choose a connection in the metric query bar. */
    queryConnection?(id: string): void;
  },
) {
  let metrics: MetricSeriesView[] = [];
  let connections: ConnectionView[] = [];
  let service: string | undefined;
  let selected: string | undefined;
  let revision: number | undefined;
  let pending = false;
  let loadedAt = -Infinity;
  let refresh: ReturnType<typeof setTimeout> | undefined;

  function load() {
    if (pending) return;
    pending = true;
    loadedAt = Date.now();
    api.postMessage({ type: 'metrics' });
  }

  // Apps export every few seconds, each series on its own, so an open list
  // refreshes at most once per interval instead of once per data point.
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
    elements.metricsStatus.textContent = 'Loading…';
    elements.metricsCards.replaceChildren();
    actions.reveal();
    load();
  }

  /** Stops refreshing once another view is shown. */
  function hide() {
    clearTimeout(refresh);
    refresh = undefined;
  }

  scope.listen(elements.metricsFilter, 'input', render);

  function receive(list: MetricSeriesView[]) {
    pending = false;
    metrics = list;
    if (actions.visible()) render();
  }

  /** The snapshot's metric counts: shows the tab and keeps the shown list current. */
  /** Shows the tab once metrics arrive or while the receiver runs, so the view can be found before any do. */
  function update(summary: { series: number; revision: number } | undefined, receiverRunning = false) {
    elements.metrics.hidden = !summary && !receiverRunning;
    elements.metricCount.hidden = !summary;
    elements.metricCount.textContent = summary ? summary.series.toLocaleString() : '';
    elements.metrics.title = summary
      ? `${summary.series.toLocaleString()} OpenTelemetry metric series. Show their latest values and trends.`
      : 'Metrics from apps that send OpenTelemetry metrics to the receiver.';
    const changed = summary?.revision !== revision;
    revision = summary?.revision;
    if (changed && actions.visible()) refreshSoon();
  }

  /** Where metrics come from, for the rail: every service, and the connections that can be queried. */
  function railItems(): TabRailItem[] {
    const counts = new Map<string, number>();
    for (const series of metrics) counts.set(series.service, (counts.get(series.service) ?? 0) + 1);
    const choose = (next: string | undefined) => () => {
      service = next;
      render();
    };
    return [
      {
        kind: 'item',
        key: 'all',
        label: 'Everything',
        meta: metrics.length.toLocaleString(),
        selected: service === undefined,
        onSelect: choose(undefined),
      },
      ...(counts.size ? [{ kind: 'group', label: 'OpenTelemetry' } as TabRailItem] : []),
      ...[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]): TabRailItem => ({
          kind: 'item',
          key: `service:${name}`,
          label: name,
          meta: count.toLocaleString(),
          color: serviceColor(name),
          selected: service === name,
          onSelect: choose(name),
        })),
      ...(connections.length ? [{ kind: 'group', label: 'Connections' } as TabRailItem] : []),
      ...connections.map((connection): TabRailItem => ({
        kind: 'item',
        key: `connection:${connection.id}`,
        label: connection.label,
        meta: connection.watching.length ? `${connection.watching.length} watched` : undefined,
        title: `Query metrics from ${connection.label}`,
        onSelect: () => actions.queryConnection?.(connection.id),
      })),
    ];
  }

  function latestText(series: MetricSeriesView): string {
    if (series.latest === undefined) return '–';
    const label = MEASURE_LABELS[series.measure];
    return `${label ? `${label} ` : ''}${series.bound ? '≤ ' : ''}${formatMetric(series.latest, series.unit, series.measure === 'rate')}`;
  }

  /** The chosen series, charted larger above the cards with everything known about its latest point. */
  function renderDetail(series: MetricSeriesView | undefined): void {
    elements.metricDetail.hidden = !series;
    if (!series) {
      elements.metricDetail.replaceChildren();
      return;
    }
    const header = document.createElement('div');
    header.className = 'metric-detail-header';
    const title = document.createElement('h3');
    title.textContent = series.name;
    const value = document.createElement('strong');
    value.className = 'metric-detail-value';
    value.textContent = latestText(series);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close the chart');
    close.title = 'Close the chart';
    scope.listen(close, 'click', () => {
      selected = undefined;
      render();
    });
    header.append(title, value, close);
    const about = document.createElement('p');
    about.className = 'metric-detail-about';
    about.textContent = details(series).split('\n').join(' · ');
    elements.metricDetail.replaceChildren(header, sparkline(series.points, 'metric-spark metric-chart-large'), about);
  }

  function card(series: MetricSeriesView): HTMLElement {
    const item = document.createElement('div');
    item.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `metric-card${series.key === selected ? ' selected' : ''}`;
    button.dataset.key = series.key;
    button.title = details(series);
    button.setAttribute('aria-pressed', String(series.key === selected));
    const name = document.createElement('span');
    name.className = 'metric-name';
    name.textContent = series.name;
    const source = document.createElement('span');
    source.className = 'metric-service';
    const dot = document.createElement('span');
    dot.className = 'service-dot';
    dot.style.background = serviceColor(series.service);
    source.append(dot, document.createTextNode(series.service));
    const attributes = document.createElement('span');
    attributes.className = 'metric-attributes';
    attributes.textContent = series.attributes.map(([key, value]) => `${key}=${value}`).join(' ');
    const bottom = document.createElement('span');
    bottom.className = 'metric-card-bottom';
    const latest = document.createElement('span');
    latest.className = 'metric-latest';
    latest.textContent = latestText(series);
    bottom.append(latest, sparkline(series.points));
    button.append(name, source);
    if (attributes.textContent) button.append(attributes);
    button.append(bottom);
    scope.listen(button, 'click', () => {
      selected = selected === series.key ? undefined : series.key;
      render();
    });
    item.append(button);
    return item;
  }

  function render() {
    actions.rail?.('Metrics from', railItems());
    const terms = elements.metricsFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = metrics.filter((series) => {
      if (service !== undefined && series.service !== service) return false;
      if (!terms.length) return true;
      const text =
        `${series.name} ${series.service} ${series.attributes.map(([key, value]) => `${key}=${value}`).join(' ')}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    if (!metrics.length) {
      elements.metricsStatus.textContent =
        'No metrics yet. Apps started while the OpenTelemetry receiver runs send metrics every 5 seconds.';
      elements.metricsCards.replaceChildren();
      renderDetail(undefined);
      return;
    }
    const services = new Set(metrics.map((series) => series.service)).size;
    elements.metricsStatus.textContent =
      `${metrics.length.toLocaleString()} series from ${services.toLocaleString()} ${services === 1 ? 'service' : 'services'}` +
      (shown.length < metrics.length ? ` · ${shown.length.toLocaleString()} match` : '');
    elements.metricsCards.replaceChildren(...shown.map(card));
    renderDetail(metrics.find((series) => series.key === selected));
  }

  /** The saved connections, which the rail offers for metric queries. */
  function setConnections(list: ConnectionView[] | undefined) {
    const next = list ?? [];
    if (
      JSON.stringify(next.map((item) => [item.id, item.label, item.watching])) ===
      JSON.stringify(connections.map((item) => [item.id, item.label, item.watching]))
    )
      return;
    connections = next;
    if (actions.visible()) actions.rail?.('Metrics from', railItems());
  }

  return { show, hide, receive, update, setConnections };
}
