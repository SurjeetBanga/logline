// Metric time series fetched from a connection, for the Metrics tab's chart
// and for watched queries that feed the Metrics list.
import { rowRoles, timeValueMs } from './remote-query';

/** One series: its points are [epoch milliseconds, value], oldest first. */
export interface MetricSeriesData {
  name: string;
  /** What tells it apart from the query's other series, such as `env:prod,service:api`. */
  scope: string;
  unit?: string;
  points: [number, number][];
}

const MAX_SERIES = 20;
const MAX_POINTS = 300;

/** At most `maxPoints` points, spread over the series, always keeping the newest. */
export function downsample(points: [number, number][], maxPoints = MAX_POINTS): [number, number][] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
}

/** The series a chart can show: the busiest first, each with a bounded number of points. */
export function boundSeries(series: MetricSeriesData[], maxSeries = MAX_SERIES): MetricSeriesData[] {
  return [...series]
    .sort((a, b) => b.points.length - a.points.length || a.scope.localeCompare(b.scope))
    .slice(0, maxSeries)
    .map((one) => ({ ...one, points: downsample(one.points) }));
}

/**
 * Rows from a metric SELECT as series: a time column (named like a time, else
 * the first), a value column (`value`, else the first other numeric one), and
 * any other text columns, which name the series.
 */
export function rowsToSeries(rows: Record<string, unknown>[], name: string): MetricSeriesData[] {
  if (!rows.length) return [];
  const columns = Object.keys(rows[0]);
  const time = rowRoles(columns).timestamp ?? columns[0];
  const numeric = (column: string) =>
    rows.some((row) => Number.isFinite(Number(row[column])) && row[column] !== null && row[column] !== '');
  const value = columns.includes('value') ? 'value' : columns.find((column) => column !== time && numeric(column));
  if (!value) throw new Error('The query needs a numeric value column, such as value.');
  const labels = columns.filter((column) => column !== time && column !== value);
  const series = new Map<string, MetricSeriesData>();
  for (const row of rows) {
    const at = timeValueMs(row[time], 'auto');
    const number = Number(row[value]);
    if (at === undefined || !Number.isFinite(number) || row[value] === null) continue;
    const scope = labels.map((label) => `${label}:${String(row[label] ?? '')}`).join(',');
    const entry = series.get(scope) ?? { name, scope, points: [] };
    entry.points.push([at, number]);
    series.set(scope, entry);
  }
  for (const entry of series.values()) entry.points.sort((a, b) => a[0] - b[0]);
  return [...series.values()];
}

/** A series' scope as attributes: `env:prod,service:api` becomes `{ env: 'prod', service: 'api' }`. */
export function scopeAttributes(scope: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const part of scope.split(',')) {
    const pair = part.trim();
    if (!pair || pair === '*') continue;
    const separator = pair.indexOf(':');
    if (separator > 0) attributes[pair.slice(0, separator)] = pair.slice(separator + 1);
    else attributes[pair] = '';
  }
  return attributes;
}

/** Datadog's timeseries response as series. */
export function datadogSeries(response: unknown): MetricSeriesData[] {
  const body = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const list = Array.isArray(body.series) ? body.series : [];
  return list.flatMap((item: unknown) => {
    const series = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const points = (Array.isArray(series.pointlist) ? series.pointlist : [])
      .filter(
        (point: unknown): point is [number, number] =>
          Array.isArray(point) &&
          Number.isFinite(point[0]) &&
          typeof point[1] === 'number' &&
          Number.isFinite(point[1]),
      )
      .map(([time, value]) => [time, value] as [number, number]);
    const unit = Array.isArray(series.unit)
      ? (series.unit[0] as { short_name?: unknown } | null)?.short_name
      : undefined;
    return [
      {
        name: String(series.metric ?? series.display_name ?? 'metric'),
        scope: String(series.scope ?? '*'),
        ...(typeof unit === 'string' && unit ? { unit } : {}),
        points,
      },
    ];
  });
}
