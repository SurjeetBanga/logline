import type { MetricSeriesView } from '../../core/metrics';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';
import { formatDuration } from './trace';

const MEASURE_LABELS: Record<MetricSeriesView['measure'], string> = { value: '', rate: 'rate', p95: 'p95', average: 'avg' };
const DURATION_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'μs': 1e-3, ms: 1, s: 1000, min: 60000, h: 3600000 };

function number(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4) return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  if (magnitude >= 100 || Number.isInteger(value)) return Math.round(value).toLocaleString();
  return value.toPrecision(magnitude >= 1 ? 3 : 2).replace(/\.?0+$/, '').replace(/^-?0$/, '0');
}

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  while (Math.abs(value) >= 1024 && index < units.length - 1) { value /= 1024; index++; }
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

function sparkline(points: MetricSeriesView['points']): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', 'metric-spark');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  if (points.length < 2) return svg;
  const values = points.map(point => point.value);
  const low = Math.min(...values), high = Math.max(...values);
  const first = points[0].timeMs, span = Math.max(1, points[points.length - 1].timeMs - first);
  const line = document.createElementNS(namespace, 'polyline');
  line.setAttribute('points', points.map(point => {
    const x = (point.timeMs - first) / span * 100;
    // A flat series sits mid-height instead of on the bottom edge.
    const y = high === low ? 12 : 22 - (point.value - low) / (high - low) * 20;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' '));
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
    rate ? 'Rate per second between the latest two points'
      : series.bound ? 'At most this: the histogram\'s buckets are too wide to estimate the p95 more closely. Set bucket boundaries that suit the unit.'
        : series.measure === 'p95' ? 'p95 of the values recorded in the latest interval' : '',
    `${series.kind}${series.unit ? ` · unit ${series.unit}` : ''}`
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * The Metrics dialog: OpenTelemetry metric series received by Logline's
 * receiver, with their latest value and a trend of recent points. Counters
 * show a rate, histograms their p95, and gauges their value.
 */
export function createMetricList(elements: Elements, api: WebviewApi, scope: EventScope) {
  let metrics: MetricSeriesView[] = [];
  let revision: number | undefined;
  let pending = false;

  function load() {
    if (pending) return;
    pending = true;
    api.postMessage({ type: 'metrics' });
  }

  function show() {
    elements.metricsStatus.textContent = 'Loading…';
    elements.metricsRows.replaceChildren();
    if (!elements.metricsDialog.open) elements.metricsDialog.showModal();
    load();
  }

  scope.listen(elements.metrics, 'click', show);
  scope.listen(elements.metricsClose, 'click', () => elements.metricsDialog.close());
  scope.listen(elements.metricsFilter, 'input', render);

  function receive(list: MetricSeriesView[]) {
    pending = false;
    metrics = list;
    if (elements.metricsDialog.open) render();
  }

  /** The snapshot's metric counts: shows the toolbar button and keeps an open list current. */
  function update(summary: { series: number; revision: number } | undefined) {
    elements.metrics.hidden = !summary;
    elements.metricCount.textContent = summary ? summary.series.toLocaleString() : '';
    elements.metrics.title = summary
      ? `${summary.series.toLocaleString()} OpenTelemetry metric series. Show their latest values and trends.`
      : '';
    const changed = summary?.revision !== revision;
    revision = summary?.revision;
    if (changed && elements.metricsDialog.open) load();
  }

  function render() {
    const terms = elements.metricsFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = terms.length ? metrics.filter(series => {
      const text = `${series.name} ${series.service} ${series.attributes.map(([key, value]) => `${key}=${value}`).join(' ')}`.toLowerCase();
      return terms.every(term => text.includes(term));
    }) : metrics;
    if (!metrics.length) {
      elements.metricsStatus.textContent = 'No metrics yet. Apps started while the OpenTelemetry receiver runs send metrics every 5 seconds.';
      elements.metricsRows.replaceChildren();
      return;
    }
    const services = new Set(metrics.map(series => series.service)).size;
    elements.metricsStatus.textContent = `${metrics.length.toLocaleString()} series from ${services.toLocaleString()} ${services === 1 ? 'service' : 'services'}`
      + (shown.length < metrics.length ? ` · ${shown.length.toLocaleString()} match` : '');
    elements.metricsRows.replaceChildren(...shown.map(series => {
      const row = document.createElement('tr');
      row.className = 'metrics-row';
      const name = cell(series.name, 'metric-name');
      name.title = details(series);
      const service = cell('', 'traces-services');
      const chip = document.createElement('span');
      chip.className = 'service-chip';
      chip.textContent = chip.title = series.service;
      service.append(chip);
      const pairs = series.attributes.map(([key, value]) => `${key}=${value}`).join(' ');
      const attributes = cell(pairs, 'metric-attributes');
      attributes.title = series.attributes.map(([key, value]) => `${key}: ${value}`).join('\n');
      const label = MEASURE_LABELS[series.measure];
      const latest = cell(series.latest === undefined ? '–' : `${label ? `${label} ` : ''}${series.bound ? '≤ ' : ''}${formatMetric(series.latest, series.unit, series.measure === 'rate')}`, 'metric-latest');
      latest.title = details(series);
      const trend = cell('', 'metric-trend');
      trend.append(sparkline(series.points));
      row.append(name, service, attributes, latest, trend);
      return row;
    }));
  }

  return { show, receive, update };
}
