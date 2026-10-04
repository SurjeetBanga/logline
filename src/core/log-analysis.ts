import { extractExceptions } from './exceptions';
import { canonicalField, getField } from './query';
import type { LogEvent } from './types';

interface AnalysisOptions { from?: number; to?: number; }

export interface ErrorGroup {
  /** `message` is the first occurrence; `pattern` shows its variable parts as `*`. */
  key: string; message: string; pattern?: string; count: number; first?: number; last?: number; sampleIds: number[]; location?: string;
  /** Occurrences over the analysed range, in equal buckets. */
  trend?: number[];
  /** First seen in the last quarter of the range. */
  isNew?: boolean;
  /** A search that finds this group's events, when its message has enough literal text. */
  query?: string;
}
export interface LogPattern {
  key: string; message: string; pattern?: string; level: string; count: number; first?: number; last?: number; sampleIds: number[]; trend: number[];
  isNew?: boolean; query?: string;
}
/** The most common values of one field, like a facet in Datadog or Kibana. */
export interface FieldValues { field: string; label: string; total: number; values: { value: string; label?: string; count: number }[]; }
export interface AnalysisSummary {
  events: number; errors: number; sources: number;
  latency?: { p50: number; p95: number; p99: number; count: number };
  /** Events whose timestamps lie far outside the rest, left out of the time charts. */
  outside: number;
}
export interface AnalysisResult {
  rate: { bucket: number; count: number; anomalous: boolean }[];
  errors: { bucket: number; count: number; anomalous: boolean }[];
  latency: { bucket: number; average: number; p95: number; count: number; anomalous: boolean }[];
  statusCodes: { code: string; count: number }[];
  errorGroups: ErrorGroup[];
  patterns: LogPattern[];
  range: { from?: number; to?: number };
  summary?: AnalysisSummary;
  topValues?: FieldValues[];
}

const TREND_BUCKETS = 10;

// A handful of events with a wildly different clock (a plain line stamped on
// arrival among replayed logs, an epoch-zero field) would otherwise stretch
// the time axis until every real event lands in one bar. Trim them when they
// alone account for most of the span.
function timeRange(events: LogEvent[], options: AnalysisOptions): { from?: number; to?: number } {
  if (options.from !== undefined && options.to !== undefined) return { from: options.from, to: options.to };
  const times: number[] = [];
  for (const event of events) {
    const time = event.timestampMs;
    if (time !== undefined && Number.isFinite(time)) times.push(time);
  }
  if (!times.length) return { from: options.from, to: options.to };
  times.sort((a, b) => a - b);
  let low = times[0];
  let high = times[times.length - 1];
  const trim = Math.floor(times.length * 0.005);
  if (trim > 0) {
    const trimmedLow = times[trim];
    const trimmedHigh = times[times.length - 1 - trim];
    if (trimmedHigh - trimmedLow < (high - low) / 2) {
      // Keep the real edges of the range; only far-away times are left out.
      const margin = Math.max(1000, (trimmedHigh - trimmedLow) * 0.1);
      low = times.find(time => time >= trimmedLow - margin)!;
      let last = times.length - 1;
      while (times[last] > trimmedHigh + margin) last--;
      high = times[last];
    }
  }
  return { from: options.from ?? low, to: options.to ?? high };
}

// Strips volatile substrings (ids, numbers, paths) so structurally identical log lines
// collapse to the same template regardless of the specific values they carry.
export function normalizeMessage(message: string): string {
  return maskVariables(message, '<id>', '<n>', '<path>').toLowerCase();
}

/** A pattern as people read it, `POST * completed`: the message with its variable parts starred. */
export function patternText(message: string): string {
  return maskVariables(message, '*', '*', '*').replace(/\*(?:\s*\*)+/g, '*');
}

function maskVariables(message: string, id: string, number: string, path: string): string {
  let text = message.trim();
  // Each replace rescans the whole string, so skip the ones whose pattern
  // cannot possibly fire. Most log lines carry no path and no hex id at all.
  if (HAS_HEX.test(text)) text = text.replace(/[0-9a-f]{8,}(?:-[0-9a-f]{4,})*/gi, id);
  // Numbers with units (`48ms`, `1.5s`, `200KB`) vary as much as bare ones.
  if (HAS_DIGIT.test(text)) text = text.replace(/\d+(?:[.,:]\d+)*(?:[a-zµ]{1,3}\b|%)?/gi, number);
  if (text.includes('/') || text.includes('\\')) text = text.replace(/([A-Za-z]:)?[\\/]?[^\s:]+[\\/][^\s:]+/g, path);
  return text.replace(/\s+/g, ' ');
}
const HAS_HEX = /[0-9a-f]{8}/i;
const HAS_DIGIT = /\d/;

/** A search for a normalized template: each literal run between its placeholders, in the message. */
export function templateQuery(template: string): string | undefined {
  const literals = template.split(/<(?:n|id|path)>/)
    .map(part => part.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(part => part.length >= 3)
    .sort((a, b) => b.length - a.length).slice(0, 4);
  if (literals.join('').length < 4) return undefined;
  // In template order, so the search reads like the message.
  return literals.sort((a, b) => template.indexOf(a) - template.indexOf(b)).map(part => `message:${JSON.stringify(part)}`).join(' ');
}

// Groups errors by exception type + originating stack frame when a stack trace is
// available, so the same exception thrown from different call sites doesn't collapse
// into one bucket, and interpolated data in the message text doesn't split one bucket
// into many. Falls back to the normalized message when there's no stack to anchor on.
function errorFingerprint(event: LogEvent, message: string): { key: string; location?: string } {
  const block = extractExceptions(event)[0];
  const frame = block?.lines.find(line => line.source)?.source;
  if (block && frame) {
    const type = normalizeMessage(block.title.split(':', 1)[0] || block.title);
    const location = `${frame.file}:${frame.line}`;
    return { key: `${type}@${location}`, location };
  }
  return { key: normalizeMessage(message) };
}

// Flags buckets whose value is a clear outlier against the series' own mean/stddev.
// Deliberately only flags spikes (not dips) and requires a minimum absolute count,
// so quiet or near-constant series don't get flagged on statistical noise.
function flagAnomalies(values: number[]): boolean[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length || 1);
  const stddev = Math.sqrt(variance);
  const threshold = mean + Math.max(stddev * 2.5, mean * 0.5, 1);
  return values.map(value => value >= 3 && value > threshold);
}

function numericField(event: LogEvent, names: string[]): number | undefined {
  for (const name of names) {
    const value = getField(event, name);
    if (value === undefined || value === null || value === '') continue;
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function isErrorEvent(event: LogEvent, status?: number): boolean {
  if (['error', 'fatal'].includes(String(event.level).toLowerCase())) return true;
  status ??= numericField(event, ['statusCode', 'status']);
  return status !== undefined && status >= 500;
}

/** Which of `buckets` equal parts of the range a time falls in, or -1 outside it. */
function bucketOf(time: number | undefined, from: number | undefined, to: number | undefined, buckets: number): number {
  if (from === undefined || to === undefined) return 0;
  if (time === undefined || !Number.isFinite(time)) return 0;
  if (time < from || time > to) return -1;
  return Math.min(buckets - 1, Math.floor((time - from) / Math.max(1, (to - from) / buckets)));
}

// Recent enough to be news: first seen in the last quarter of a range long
// enough for "earlier" to mean something.
function firstSeenLate(first: number | undefined, from: number | undefined, to: number | undefined): boolean {
  return first !== undefined && from !== undefined && to !== undefined && to - from >= 60000 && first >= from + (to - from) * 0.75;
}

function track(group: { first?: number; last?: number; sampleIds: number[]; count: number }, event: LogEvent): void {
  group.count++;
  if (group.sampleIds.length < 5) group.sampleIds.push(event.id);
  if (event.timestampMs !== undefined) {
    group.first = group.first === undefined ? event.timestampMs : Math.min(group.first, event.timestampMs);
    group.last = Math.max(group.last ?? event.timestampMs, event.timestampMs);
  }
}

export function groupErrors(events: LogEvent[], options: AnalysisOptions = {}): ErrorGroup[] {
  const { from, to } = timeRange(events, options);
  const groups = new Map<string, ErrorGroup>();
  // The same error is often logged both with and without its stack. Plain
  // occurrences join the stack group with the same message when exactly one exists.
  const byMessage = new Map<string, Set<string>>();
  for (const event of events) {
    const message = String(event.message ?? event.raw ?? '').split(/\r?\n/, 1)[0];
    if (!message || !isErrorEvent(event)) continue;
    const { key, location } = errorFingerprint(event, message);
    const group = groups.get(key) ?? { key, message, count: 0, sampleIds: [], location, trend: new Array(TREND_BUCKETS).fill(0) };
    track(group, event);
    const bucket = bucketOf(event.timestampMs, from, to, TREND_BUCKETS);
    if (bucket >= 0) group.trend![bucket]++;
    groups.set(key, group);
    const normalized = normalizeMessage(message);
    if (location) {
      const keys = byMessage.get(normalized) ?? new Set();
      keys.add(key);
      byMessage.set(normalized, keys);
    }
  }
  for (const [key, group] of groups) {
    if (group.location) continue;
    const owners = byMessage.get(key);
    if (owners?.size !== 1) continue;
    const owner = groups.get([...owners][0])!;
    owner.count += group.count;
    owner.sampleIds = [...owner.sampleIds, ...group.sampleIds].sort((a, b) => a - b).slice(0, 5);
    if (group.first !== undefined) owner.first = Math.min(owner.first ?? group.first, group.first);
    if (group.last !== undefined) owner.last = Math.max(owner.last ?? group.last, group.last);
    owner.trend = owner.trend!.map((value, index) => value + group.trend![index]);
    groups.delete(key);
  }
  return [...groups.values()]
    .map(group => ({ ...group, pattern: patternText(group.message), isNew: firstSeenLate(group.first, from, to), query: templateQuery(normalizeMessage(group.message)) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 100);
}

// Groups every retained event (any level) by its normalized message template, with a
// coarse volume trend per template, so recurring shapes stand out without requiring a
// query - the same idea as Grafana's log-pattern view or Splunk's Patterns tab.
export function findPatterns(events: LogEvent[], options: AnalysisOptions = {}, trendBuckets = TREND_BUCKETS, limit = 20): LogPattern[] {
  const { from, to } = timeRange(events, options);
  const groups = new Map<string, LogPattern>();
  for (const event of events) {
    const message = String(event.message ?? event.raw ?? '').split(/\r?\n/, 1)[0];
    if (!message) continue;
    const key = normalizeMessage(message);
    const pattern: LogPattern = groups.get(key) ?? { key, message, level: String(event.level ?? ''), count: 0, sampleIds: [], trend: new Array(trendBuckets).fill(0) };
    track(pattern, event);
    const bucket = bucketOf(event.timestampMs, from, to, trendBuckets);
    if (bucket >= 0) pattern.trend[bucket]++;
    groups.set(key, pattern);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, limit)
    .map(pattern => ({ ...pattern, pattern: patternText(pattern.message), isNew: firstSeenLate(pattern.first, from, to), query: templateQuery(pattern.key) }));
}

const FACET_PREFERRED = ['service', 'path', 'method', 'host', 'logger', 'environment', 'region', 'version', 'container', 'pod'];
const FACET_SKIPPED = new Set(['level', 'message', 'timestamp', 'status', 'durationms', 'traceid', 'spanid', 'parentspanid', 'requestid']);

// Fields worth breaking the results down by: present on enough events, with
// a few repeated values rather than one value per event (ids) or prose.
function facetFields(events: LogEvent[]): string[] {
  const step = Math.max(1, Math.floor(events.length / 2000));
  const seen = new Map<string, { present: number; values: Set<string>; long: boolean }>();
  let sampled = 0;
  for (let index = 0; index < events.length; index += step) {
    sampled++;
    const fields = events[index].fields;
    for (const key in fields) {
      if (!Object.hasOwn(fields, key)) continue;
      const value = fields[key];
      const entry = seen.get(key) ?? { present: 0, values: new Set(), long: false };
      entry.present++;
      if (entry.values.size <= 200) entry.values.add(String(value));
      if (typeof value === 'string' && value.length > 80) entry.long = true;
      seen.set(key, entry);
    }
  }
  const keys = [...seen.keys()];
  const candidates = keys.filter(key => {
    const entry = seen.get(key)!;
    const canonical = canonicalField(key).toLowerCase();
    if (FACET_SKIPPED.has(canonical) || canonical.endsWith('.time') || entry.long) return false;
    if (entry.present < sampled * 0.2 || entry.values.size < 2) return false;
    // Mostly distinct values are identifiers, not categories.
    if (entry.values.size > 50 && entry.values.size > entry.present * 0.2) return false;
    // A nested value also appears under its bare name; keep one of the two.
    return !(key.includes('.') && keys.includes(key.slice(key.lastIndexOf('.') + 1)));
  });
  const rank = (key: string) => {
    const preferred = FACET_PREFERRED.indexOf(canonicalField(key).toLowerCase());
    return preferred >= 0 ? preferred : FACET_PREFERRED.length;
  };
  const chosen: string[] = [];
  const canonicals = new Set<string>();
  for (const key of candidates.sort((a, b) => rank(a) - rank(b) || seen.get(b)!.present - seen.get(a)!.present || a.localeCompare(b))) {
    if (canonicals.has(canonicalField(key))) continue;
    canonicals.add(canonicalField(key));
    chosen.push(key);
    if (chosen.length === 4) break;
  }
  return chosen;
}

function topValues(events: LogEvent[]): FieldValues[] {
  const facets: FieldValues[] = [];
  const sources = new Map<string, { label: string; count: number }>();
  for (const event of events) {
    if (event.serverId === undefined) continue;
    const entry = sources.get(event.serverId) ?? { label: event.server ?? event.serverId, count: 0 };
    entry.count++;
    sources.set(event.serverId, entry);
  }
  if (sources.size > 1) {
    facets.push({ field: 'serverId', label: 'Source', total: [...sources.values()].reduce((sum, item) => sum + item.count, 0),
      values: [...sources].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([value, { label, count }]) => ({ value, label, count })) });
  }
  for (const field of facetFields(events)) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const event of events) {
      const fields = event.fields;
      if (!fields || !Object.hasOwn(fields, field)) continue;
      const value = String(fields[field]);
      total++;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    facets.push({ field, label: field, total, values: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([value, count]) => ({ value, count })) });
  }
  return facets;
}

function percentile(sorted: number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

export function analyzeEvents(events: LogEvent[], options: AnalysisOptions = {}): AnalysisResult {
  const { from, to } = timeRange(events, options);
  const rate = Array.from({ length: 30 }, (_, bucket) => ({ bucket, count: 0 }));
  const errors = Array.from({ length: 30 }, (_, bucket) => ({ bucket, count: 0 }));
  const latencyBuckets = Array.from({ length: 30 }, () => [] as number[]);
  const latencies: number[] = [];
  const status = new Map<string, number>();
  const sources = new Set<string>();
  let errorCount = 0;
  let outside = 0;
  for (const event of events) {
    const code = numericField(event, ['statusCode', 'status']);
    const error = isErrorEvent(event, code);
    const latency = numericField(event, ['durationMs', 'duration']);
    if (error) errorCount++;
    if (latency !== undefined) latencies.push(latency);
    if (code !== undefined) { const key = String(code); status.set(key, (status.get(key) ?? 0) + 1); }
    if (event.serverId !== undefined) sources.add(event.serverId);
    const index = bucketOf(event.timestampMs, from, to, 30);
    if (index < 0) { outside++; continue; }
    rate[index].count++;
    if (error) errors[index].count++;
    if (latency !== undefined) latencyBuckets[index].push(latency);
  }
  const latency = latencyBuckets.map((values, bucket) => {
    values.sort((a, b) => a - b); const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return { bucket, average, p95: values.length ? percentile(values, .95) : 0, count: values.length };
  });
  latencies.sort((a, b) => a - b);
  const rateAnomalies = flagAnomalies(rate.map(item => item.count));
  const errorAnomalies = flagAnomalies(errors.map(item => item.count));
  const latencyAnomalies = flagAnomalies(latency.map(item => item.average));
  return {
    rate: rate.map((item, index) => ({ ...item, anomalous: rateAnomalies[index] })),
    errors: errors.map((item, index) => ({ ...item, anomalous: errorAnomalies[index] })),
    latency: latency.map((item, index) => ({ ...item, anomalous: latencyAnomalies[index] })),
    statusCodes: [...status.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    errorGroups: groupErrors(events, { from, to }), patterns: findPatterns(events, { from, to }), range: { from, to },
    summary: {
      events: events.length, errors: errorCount, sources: sources.size, outside,
      ...(latencies.length ? { latency: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), p99: percentile(latencies, .99), count: latencies.length } } : {})
    },
    topValues: topValues(events)
  };
}
