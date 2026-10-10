// Normalizes OTLP metrics requests (OTLP/JSON, or protobuf decoded into the
// same shape by otlp-proto.ts) and keeps a short recent history per series.
import { attributes, nanosToMs, type Attributes } from './otlp';

export type MetricKind = 'gauge' | 'sum' | 'histogram' | 'exponentialHistogram' | 'summary';

/** One data point of one metric, as received. */
export interface MetricPoint {
  name: string;
  description?: string;
  unit?: string;
  kind: MetricKind;
  /** Sums only: whether the value only increases, like a request counter. */
  monotonic?: boolean;
  /** OTLP AggregationTemporality: 1 delta, 2 cumulative. */
  temporality?: number;
  service: string;
  attributes: Attributes;
  startMs?: number;
  timeMs: number;
  value?: number;
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  /** Explicit histogram bounds and the count in each bucket (one more than the bounds). */
  bounds?: number[];
  buckets?: number[];
  quantiles?: { quantile: number; value: number }[];
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value ? value.slice(0, max) : undefined;
const finite = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
};
const MAX_BUCKETS = 256;
const KINDS: MetricKind[] = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'];
const TEMPORALITY: Record<string, number> = { AGGREGATION_TEMPORALITY_DELTA: 1, AGGREGATION_TEMPORALITY_CUMULATIVE: 2 };

export function readMetrics(request: unknown): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const group of list(object(request)?.resourceMetrics)) {
    const resource = attributes(object(object(group)?.resource)?.attributes);
    const name = resource['service.name'];
    const service = typeof name === 'string' && name ? name.slice(0, 200) : 'unknown_service';
    for (const scoped of list(object(group)?.scopeMetrics)) {
      for (const item of list(object(scoped)?.metrics)) {
        const metric = object(item);
        const metricName = text(metric?.name, 256);
        const kind = KINDS.find(candidate => object(metric?.[candidate]));
        if (!metric || !metricName || !kind) continue;
        const data = object(metric[kind])!;
        const temporality = TEMPORALITY[String(data.aggregationTemporality)] ?? finite(data.aggregationTemporality);
        const base = {
          name: metricName, description: text(metric.description, 1024), unit: text(metric.unit, 64), kind, service,
          ...(kind === 'sum' ? { monotonic: data.isMonotonic === true } : {}),
          ...(temporality === 1 || temporality === 2 ? { temporality } : {})
        };
        for (const entry of list(data.dataPoints)) {
          const raw = object(entry);
          const timeMs = nanosToMs(raw?.timeUnixNano);
          if (!raw || timeMs === undefined) continue;
          const point: MetricPoint = { ...base, attributes: attributes(raw.attributes), timeMs, startMs: nanosToMs(raw.startTimeUnixNano) };
          if (kind === 'gauge' || kind === 'sum') {
            point.value = finite(raw.asDouble) ?? finite(raw.asInt);
            if (point.value === undefined) continue;
          } else {
            point.count = finite(raw.count) ?? 0;
            point.sum = finite(raw.sum);
            point.min = finite(raw.min);
            point.max = finite(raw.max);
            if (kind === 'histogram') {
              const bounds = list(raw.explicitBounds).map(finite);
              const buckets = list(raw.bucketCounts).map(finite);
              if (bounds.every(bound => bound !== undefined) && buckets.every(bucket => bucket !== undefined)
                && buckets.length === bounds.length + 1 && buckets.length <= MAX_BUCKETS) {
                point.bounds = bounds as number[];
                point.buckets = buckets as number[];
              }
            }
            if (kind === 'summary') point.quantiles = list(raw.quantileValues).map(object)
              .map(value => ({ quantile: finite(value?.quantile), value: finite(value?.value) }))
              .filter((value): value is { quantile: number; value: number } => value.quantile !== undefined && value.value !== undefined);
          }
          points.push(point);
        }
      }
    }
  }
  return points;
}

/**
 * A percentile from explicit histogram buckets, interpolated within the
 * bucket that holds it. The first and last buckets are open, so the minimum
 * and maximum (when sent) close them.
 */
export function histogramPercentile(bounds: readonly number[], buckets: readonly number[], fraction: number, min?: number, max?: number): number | undefined {
  return percentileBucket(bounds, buckets, fraction, min, max)?.value;
}

/** The interpolated percentile and the range of the bucket that holds it, narrowed to the minimum and maximum. */
export function percentileBucket(bounds: readonly number[], buckets: readonly number[], fraction: number, min?: number, max?: number): { value: number; lower: number; upper: number } | undefined {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return undefined;
  const rank = fraction * total;
  let seen = 0;
  for (let index = 0; index < buckets.length; index++) {
    const count = buckets[index];
    if (!count || seen + count < rank) { seen += count; continue; }
    let lower = index === 0 ? Math.min(min ?? Math.min(0, bounds[0] ?? 0), bounds[0] ?? 0) : bounds[index - 1];
    let upper = index === bounds.length ? Math.max(max ?? bounds[index - 1] ?? 0, lower) : bounds[index];
    // Values recorded never go beyond the minimum and maximum, so neither does the bucket.
    if (min !== undefined) lower = Math.max(lower, Math.min(min, upper));
    if (max !== undefined) upper = Math.min(upper, Math.max(max, lower));
    return { value: lower + (upper - lower) * ((rank - seen) / count), lower, upper };
  }
  return max === undefined ? undefined : { value: max, lower: max, upper: max };
}

/**
 * Whether a bucket is too wide to place a value in it: wider than the value
 * itself, as when buckets sized for milliseconds hold values in seconds.
 */
function coarse(bucket: { value: number; lower: number; upper: number }): boolean { return bucket.upper - bucket.lower > Math.abs(bucket.value); }

/** What a series is plotted as: its value, a rate per second for counters, or a percentile for distributions. */
export type MetricMeasure = 'value' | 'rate' | 'p95' | 'average';

/** A series as the Metrics view shows it. */
export interface MetricSeriesView {
  key: string;
  name: string;
  description?: string;
  unit?: string;
  kind: MetricKind;
  measure: MetricMeasure;
  service: string;
  attributes: [string, string][];
  /** The newest plotted value, and when it was received. */
  latest?: number;
  timeMs: number;
  /** The latest p95 is an upper bound: the histogram's buckets are too wide to estimate it. */
  bound?: boolean;
  /** Counters: the latest total. Distributions: values in the latest interval. */
  total?: number;
  count?: number;
  average?: number;
  p50?: number;
  min?: number;
  max?: number;
  points: { timeMs: number; value: number }[];
}

interface Series {
  view: MetricSeriesView;
  /** The previous cumulative point, to turn running totals into per-interval values. */
  previous?: MetricPoint;
}

/** Recent metric series, bounded by series and points per series; the least recently updated series go first. */
export class MetricStore {
  private readonly series = new Map<string, Series>();
  /** Bumps whenever a point is added or the store is cleared, for change detection. */
  revision = 0;

  constructor(public maxSeries = 2000, public maxPoints = 120) { }

  get size(): number { return this.series.size; }

  add(point: MetricPoint): boolean {
    const pairs = Object.entries(point.attributes).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)] as [string, string])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const key = JSON.stringify([point.service, point.name, pairs]);
    let series = this.series.get(key);
    // Exporters retry failed batches; a point no newer than the last one is a repeat.
    if (series && point.timeMs <= series.view.timeMs) return false;
    if (series) this.series.delete(key);
    else series = { view: { key, name: point.name, kind: point.kind, measure: measureOf(point), service: point.service, attributes: pairs, timeMs: point.timeMs, points: [] } };
    // Least recently updated first, so the first entry is the one to evict.
    this.series.set(key, series);
    while (this.series.size > this.maxSeries) this.series.delete(this.series.keys().next().value!);
    Object.assign(series.view, { description: point.description, unit: point.unit, timeMs: point.timeMs });
    const plotted = this.measure(series, point);
    if (plotted !== undefined && Number.isFinite(plotted)) {
      series.view.latest = plotted;
      series.view.points.push({ timeMs: point.timeMs, value: plotted });
      if (series.view.points.length > this.maxPoints) series.view.points.splice(0, series.view.points.length - this.maxPoints);
    }
    if (point.temporality === 2) series.previous = point;
    this.revision++;
    return true;
  }

  /** Every series, most recently updated first. */
  list(maxPoints = this.maxPoints): MetricSeriesView[] {
    return [...this.series.values()].reverse().map(series => ({ ...series.view, points: sample(series.view.points, maxPoints) }));
  }

  /** Every series without its points, for checks that only need names and attributes. */
  names(): Pick<MetricSeriesView, 'service' | 'name' | 'unit' | 'attributes'>[] {
    return [...this.series.values()].map(({ view }) => ({ service: view.service, name: view.name, unit: view.unit, attributes: view.attributes }));
  }

  clear(): void { this.series.clear(); this.revision++; }

  private measure(series: Series, point: MetricPoint): number | undefined {
    const view = series.view;
    // A cumulative point that started after the previous one, or went down, is a restart.
    const previous = point.temporality === 2 && series.previous && series.previous.startMs === point.startMs ? series.previous : undefined;
    if (point.kind === 'gauge' || (point.kind === 'sum' && !point.monotonic)) return point.value;
    if (point.kind === 'sum') {
      const value = point.value!;
      if (point.temporality === 2) {
        view.total = value;
        if (previous && value >= previous.value!) return perSecond(value - previous.value!, point.timeMs - previous.timeMs);
        return point.startMs !== undefined ? perSecond(value, point.timeMs - point.startMs) : undefined;
      }
      view.total = (view.total ?? 0) + value;
      return point.startMs !== undefined ? perSecond(value, point.timeMs - point.startMs) : undefined;
    }
    // Distributions: the values recorded since the previous point.
    const reset = previous && (previous.count! > point.count! || (previous.sum !== undefined && point.sum !== undefined && previous.sum > point.sum));
    const since = previous && !reset ? previous : undefined;
    const count = point.count! - (since?.count ?? 0);
    const sum = point.sum === undefined ? undefined : point.sum - (since?.sum ?? 0);
    Object.assign(view, { count, average: count && sum !== undefined ? sum / count : undefined, p50: undefined, bound: undefined, min: point.min, max: point.max });
    if (!count) return undefined;
    if (point.kind === 'histogram' && point.bounds?.length && point.buckets) {
      const buckets = since?.buckets?.length === point.buckets.length ? point.buckets.map((bucket, index) => bucket - since.buckets![index]) : point.buckets;
      // Minimum and maximum cover the whole cumulative run, which contains every interval in it.
      const p50 = percentileBucket(point.bounds, buckets, .5, point.min, point.max);
      const p95 = percentileBucket(point.bounds, buckets, .95, point.min, point.max);
      view.p50 = p50 && !coarse(p50) ? p50.value : undefined;
      if (p95) {
        // A bucket too wide to interpolate in only says the p95 is at most its upper edge.
        view.bound = coarse(p95);
        return view.bound ? p95.upper : p95.value;
      }
    }
    if (point.kind === 'summary') {
      const quantile = (target: number) => point.quantiles?.find(value => Math.abs(value.quantile - target) < 1e-9)?.value;
      view.p50 = quantile(.5);
      const p95 = quantile(.95);
      if (p95 !== undefined) return p95;
    }
    return view.average;
  }
}

function measureOf(point: MetricPoint): MetricMeasure {
  if (point.kind === 'sum' && point.monotonic) return 'rate';
  if (point.kind === 'histogram' && point.bounds?.length) return 'p95';
  if (point.kind === 'summary' && point.quantiles?.some(value => Math.abs(value.quantile - .95) < 1e-9)) return 'p95';
  if (point.kind === 'histogram' || point.kind === 'exponentialHistogram' || point.kind === 'summary') return 'average';
  return 'value';
}

/** At most `max` points spread evenly over the series, always ending with the newest. */
function sample<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  if (max <= 1) return max === 1 ? [points[points.length - 1]] : [];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]);
}

function perSecond(amount: number, ms: number): number | undefined { return ms > 0 ? amount / (ms / 1000) : undefined; }
