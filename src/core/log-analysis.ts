import { extractExceptions } from './exceptions';
import { getField } from './query';
import type { LogEvent } from './types';

interface AnalysisOptions { from?: number; to?: number; }

export interface ErrorGroup { key: string; message: string; count: number; first?: number; last?: number; sampleIds: number[]; location?: string; }
export interface LogPattern { key: string; message: string; level: string; count: number; first?: number; last?: number; sampleIds: number[]; trend: number[]; }
export interface AnalysisResult {
  rate: { bucket: number; count: number; anomalous: boolean }[];
  errors: { bucket: number; count: number; anomalous: boolean }[];
  latency: { bucket: number; average: number; p95: number; count: number; anomalous: boolean }[];
  statusCodes: { code: string; count: number }[];
  errorGroups: ErrorGroup[];
  patterns: LogPattern[];
  range: { from?: number; to?: number };
}

function timeRange(events: LogEvent[], options: AnalysisOptions): { from?: number; to?: number } {
  let minimum = Infinity;
  let maximum = -Infinity;
  if (options.from === undefined || options.to === undefined) {
    for (const event of events) {
      const time = event.timestampMs;
      if (time === undefined || !Number.isFinite(time)) continue;
      if (time < minimum) minimum = time;
      if (time > maximum) maximum = time;
    }
  }
  return { from: options.from ?? (minimum === Infinity ? undefined : minimum),
    to: options.to ?? (maximum === -Infinity ? undefined : maximum) };
}

// Strips volatile substrings (ids, numbers, paths) so structurally identical log lines
// collapse to the same template regardless of the specific values they carry.
function normalizeMessage(message: string): string {
  let text = message.trim();
  // Each replace rescans the whole string, so skip the ones whose pattern
  // cannot possibly fire. Most log lines carry no path and no hex id at all.
  if (HAS_HEX.test(text)) text = text.replace(/[0-9a-f]{8,}/gi, '<id>');
  if (HAS_DIGIT.test(text)) text = text.replace(/\b\d+(?:\.\d+)?\b/g, '<n>');
  if (text.includes('/') || text.includes('\\')) text = text.replace(/([A-Za-z]:)?[\\/]?[^\s:]+[\\/][^\s:]+/g, '<path>');
  return text.replace(/\s+/g, ' ').toLowerCase();
}
const HAS_HEX = /[0-9a-f]{8}/i;
const HAS_DIGIT = /\d/;

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

export function groupErrors(events: LogEvent[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const event of events) {
    const message = String(event.message ?? event.raw ?? '').split(/\r?\n/, 1)[0];
    if (!message || !isErrorEvent(event)) continue;
    const { key, location } = errorFingerprint(event, message);
    const group = groups.get(key) ?? { key, message, count: 0, sampleIds: [], location };
    group.count++;
    if (group.sampleIds.length < 5) group.sampleIds.push(event.id);
    if (event.timestampMs !== undefined) { group.first = group.first === undefined ? event.timestampMs : Math.min(group.first, event.timestampMs); group.last = Math.max(group.last ?? event.timestampMs, event.timestampMs); }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 100);
}

// Groups every retained event (any level) by its normalized message template, with a
// coarse volume trend per template, so recurring shapes stand out without requiring a
// query - the same idea as Grafana's log-pattern view or Splunk's Patterns tab.
export function findPatterns(events: LogEvent[], options: AnalysisOptions = {}, trendBuckets = 10): LogPattern[] {
  const { from, to } = timeRange(events, options);
  const bucketSize = from !== undefined && to !== undefined ? Math.max(1, (to - from) / trendBuckets) : 1;
  const groups = new Map<string, LogPattern>();
  for (const event of events) {
    const message = String(event.message ?? event.raw ?? '').split(/\r?\n/, 1)[0];
    if (!message) continue;
    const key = normalizeMessage(message);
    const pattern: LogPattern = groups.get(key) ?? { key, message, level: String(event.level ?? ''), count: 0, sampleIds: [], trend: new Array(trendBuckets).fill(0) };
    pattern.count++;
    if (pattern.sampleIds.length < 5) pattern.sampleIds.push(event.id);
    if (event.timestampMs !== undefined) { pattern.first = pattern.first === undefined ? event.timestampMs : Math.min(pattern.first, event.timestampMs); pattern.last = Math.max(pattern.last ?? event.timestampMs, event.timestampMs); }
    const index = from === undefined ? 0 : Math.min(trendBuckets - 1, Math.max(0, Math.floor(((event.timestampMs ?? from) - from) / bucketSize)));
    pattern.trend[index]++;
    groups.set(key, pattern);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 10);
}

export function analyzeEvents(events: LogEvent[], options: AnalysisOptions = {}): AnalysisResult {
  const { from, to } = timeRange(events, options);
  const bucketSize = from !== undefined && to !== undefined ? Math.max(1, (to - from) / 30) : 1;
  const rate = Array.from({ length: 30 }, (_, bucket) => ({ bucket, count: 0 }));
  const errors = Array.from({ length: 30 }, (_, bucket) => ({ bucket, count: 0 }));
  const latencyBuckets = Array.from({ length: 30 }, () => [] as number[]);
  const status = new Map<string, number>();
  for (const event of events) {
    const index = from === undefined ? 0 : Math.min(29, Math.max(0, Math.floor(((event.timestampMs ?? from) - from) / bucketSize)));
    rate[index].count++;
    const code = numericField(event, ['statusCode', 'status']);
    if (isErrorEvent(event, code)) errors[index].count++;
    const latency = numericField(event, ['durationMs', 'duration']);
    if (latency !== undefined) latencyBuckets[index].push(latency);
    if (code !== undefined) { const key = String(code); status.set(key, (status.get(key) ?? 0) + 1); }
  }
  const latency = latencyBuckets.map((values, bucket) => {
    values.sort((a, b) => a - b); const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return { bucket, average, p95: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * .95))] : 0, count: values.length };
  });
  const rateAnomalies = flagAnomalies(rate.map(item => item.count));
  const errorAnomalies = flagAnomalies(errors.map(item => item.count));
  const latencyAnomalies = flagAnomalies(latency.map(item => item.average));
  return {
    rate: rate.map((item, index) => ({ ...item, anomalous: rateAnomalies[index] })),
    errors: errors.map((item, index) => ({ ...item, anomalous: errorAnomalies[index] })),
    latency: latency.map((item, index) => ({ ...item, anomalous: latencyAnomalies[index] })),
    statusCodes: [...status.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    errorGroups: groupErrors(events), patterns: findPatterns(events, { ...options, from, to }), range: { from, to }
  };
}
