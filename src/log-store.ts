import { StringDecoder } from 'node:string_decoder';
import { getField, matchesQuery, parseQuery, type ParsedQuery } from './query';
import { extractExceptions } from './exceptions';
import type { LogEvent } from './types';

const PAGE_SIZE = 1000;

interface Slot {
  event: LogEvent;
  bytes: number;
}

const pickFields = ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields,
  taskName, taskType, taskState, dependencies, dependencyState, exitReason }: LogEvent): LogEvent =>
  ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields,
    taskName, taskType, taskState, dependencies, dependencyState, exitReason });

// A small append-only deque of slot refs for one server, oldest first. Eviction
// from the main ring always removes the globally oldest surviving event, which
// is always that event's own server's oldest surviving entry too, so `shift()`
// here stays correct without re-scanning anything.
class ServerIndex {
  items: (Slot | undefined)[] = [];
  start = 0;
  push(item: Slot) { this.items.push(item); }
  shift() {
    this.items[this.start] = undefined;
    this.start++;
    if (this.start > 1024 && this.start * 2 > this.items.length) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
  }
  get length() { return this.items.length - this.start; }
  *iterateFromEnd(): Generator<Slot> {
    for (let i = this.items.length - 1; i >= this.start; i--) yield this.items[i]!;
  }
}

function findServerKey(index: Map<string, ServerIndex>, value: string): string | undefined {
  // Field searches use case-insensitive substring matching. Only use one
  // server's index when it contains every match; otherwise scan the ring.
  let match: string | undefined;
  for (const key of index.keys()) {
    if (!key.toLowerCase().includes(value)) continue;
    if (match !== undefined) return undefined;
    match = key;
  }
  return match;
}

export interface Stats {
  total: number;
  retained: number;
  discarded: number;
  truncated: number;
  bytes: number;
  maxBytes: number;
  maxRows: number;
}

export interface PageOptions {
  query?: string;
  // A server selected in the UI is an exact identity filter. This stays
  // separate from query text, where serverId:foo intentionally remains a
  // substring search for compatibility with the search language.
  serverId?: string;
  // Omitted = no filter (all levels). An empty array deliberately matches
  // nothing — that's a real, distinct choice from "not filtering at all".
  levels?: string[];
  page?: number;
  before?: number;
  /** Sort by a field; omitted keeps capture order. */
  sort?: string;
  sortDirection?: 'asc' | 'desc';
  /** Restrict analysis/export helpers to one capture session. */
  sessionId?: string;
  from?: number;
  to?: number;
}

export interface PageResult extends Stats {
  events: LogEvent[];
  page: number;
  pages: number;
  matched: number;
}

export interface FacetValue { value: string; count: number; }
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
const BUILTIN_FIELDS = ['id', 'level', 'message', 'timestamp', 'timestampMs', 'stream', 'server', 'serverId', 'sessionId',
  'taskName', 'taskType', 'taskState', 'dependencies', 'dependencyState', 'exitReason', 'traceId', 'spanId', 'parentSpanId',
  'requestId', 'status', 'statusCode', 'durationMs'];

function fieldValue(event: LogEvent, field: string): unknown {
  if (field === 'id') return event.id;
  if (field === 'timestampMs') return event.timestampMs;
  return getField(event, field);
}

function sortEvents(events: LogEvent[], field: string, direction: 'asc' | 'desc' = 'asc'): LogEvent[] {
  const sign = direction === 'desc' ? -1 : 1;
  return events.sort((a, b) => {
    const av = fieldValue(a, field); const bv = fieldValue(b, field);
    if (av === undefined || av === null || av === '') return bv === undefined || bv === null || bv === '' ? a.id - b.id : 1;
    if (bv === undefined || bv === null || bv === '') return -1;
    const an = typeof av === 'number' ? av : Number(av); const bn = typeof bv === 'number' ? bv : Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sign * (an - bn || a.id - b.id);
    return sign * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) || a.id - b.id;
  });
}

// Strips volatile substrings (ids, numbers, paths) so structurally identical log lines
// collapse to the same template regardless of the specific values they carry.
function normalizeMessage(message: string): string {
  return message.trim().replace(/[0-9a-f]{8,}/gi, '<id>').replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/([A-Za-z]:)?[\\/]?[^\s:]+[\\/][^\s:]+/g, '<path>').replace(/\s+/g, ' ').toLowerCase();
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
    const value = fieldValue(event, name);
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

// Approximate UTF-16 storage plus per-record overhead, not total process RSS.
export class LogStore {
  maxRows: number;
  maxBytes: number;
  slots!: (Slot | undefined)[];
  head!: number;
  size!: number;
  bytes!: number;
  total!: number;
  discarded!: number;
  truncated!: number;
  columnCache!: Set<string>;
  serverIndex!: Map<string, ServerIndex>;

  constructor(maxRows = 100000, maxBytes = 100 * 1024 * 1024) {
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
    this.clear();
  }

  clear(): void {
    this.slots = new Array(this.maxRows);
    this.head = 0;
    this.size = 0;
    this.bytes = 0;
    this.total = 0;
    this.discarded = 0;
    this.truncated = 0;
    this.columnCache = new Set();
    this.serverIndex = new Map();
  }

  private evictOldest(): void {
    const evicted = this.slots[this.head]!;
    this.bytes -= evicted.bytes;
    const serverId = evicted.event.serverId;
    if (serverId !== undefined) {
      const index = this.serverIndex.get(serverId);
      index?.shift();
      if (index?.length === 0) this.serverIndex.delete(serverId);
    }
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.maxRows;
    this.size--;
    this.discarded++;
  }

  private insertSlot(slot: Slot): void {
    this.slots[(this.head + this.size) % this.maxRows] = slot;
    Object.keys(slot.event.fields ?? {}).forEach(key => this.columnCache.add(key));
    const serverId = slot.event.serverId;
    if (serverId !== undefined) {
      let index = this.serverIndex.get(serverId);
      if (!index) { index = new ServerIndex(); this.serverIndex.set(serverId, index); }
      index.push(slot);
    }
    this.size++;
    this.bytes += slot.bytes;
  }

  add(event: LogEvent): void {
    this.total++;
    if (event.truncated) this.truncated++;
    const bytes = 256 + Object.values(event).reduce(
      (sum: number, value) => sum + (typeof value === 'string' ? value.length * 2 : 0), 0
    );
    if (bytes > this.maxBytes) { this.discarded++; return; }
    while (this.size && (this.size === this.maxRows || this.bytes + bytes > this.maxBytes)) this.evictOldest();
    this.insertSlot({ event, bytes });
  }

  // Ids increase monotonically along the ring, so the newest page can be found
  // without scanning every retained event.
  find(id: number): LogEvent | undefined {
    let low = 0;
    let high = this.size - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const event = this.slots[(this.head + middle) % this.maxRows]!.event;
      if (event.id === id) return event;
      if (event.id < id) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  // Neighbours are in capture order within the same process session, including
  // both streams and every level. Query filters intentionally do not apply.
  context(id: number): { events: LogEvent[]; server?: string; missing: boolean } {
    const anchor = this.find(id);
    if (!anchor) return { events: [], missing: true };
    const earlier: LogEvent[] = [];
    const later: LogEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const event = this.slots[(this.head + i) % this.maxRows]!.event;
      // An absent session id is an unknown boundary, not a shared session.
      // Refuse to join two legacy/ad-hoc events unless both have a stamped id.
      if (anchor.sessionId === undefined || event.sessionId === undefined
        || event.serverId !== anchor.serverId || event.sessionId !== anchor.sessionId) continue;
      if (event.id < id) {
        earlier.push(event);
        if (earlier.length > 25) earlier.shift();
      } else if (event.id > id) {
        later.push(event);
        if (later.length === 25) break;
      }
    }
    return { events: [...earlier, anchor, ...later].map(pickFields), server: anchor.server, missing: false };
  }

  // Re-home retained events into a new ring, dropping the oldest that no longer
  // fit. Used when the retention settings change without a window reload.
  resize(maxRows: number, maxBytes: number): void {
    const kept: Slot[] = [];
    for (let i = 0; i < this.size; i++) kept.push(this.slots[(this.head + i) % this.maxRows]!);
    const { total, discarded, truncated } = this;
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
    this.clear();
    this.total = total;
    this.discarded = discarded;
    this.truncated = truncated;
    for (const slot of kept) {
      if (slot.bytes > this.maxBytes) { this.discarded++; continue; }
      while (this.size && (this.size === this.maxRows || this.bytes + slot.bytes > this.maxBytes)) this.evictOldest();
      this.insertSlot(slot);
    }
  }

  page({ query = '', serverId, levels, page = 0, before = Infinity, sort, sortDirection = 'asc', sessionId, from, to }: PageOptions = {}): PageResult {
    if (!Number.isFinite(before)) before = Infinity;
    // `levels` omitted means no filter (every level shown, the default —
    // matches the fast path below); an empty array is a deliberate "nothing
    // checked", which matches nothing.
    const levelSet = levels ? new Set(levels) : undefined;
    const levelMatches = (eventLevel: string) => !levelSet || levelSet.has(eventLevel);
    query = query.slice(0, 256);
    const parsedQuery: ParsedQuery = parseQuery(query);
    const exactServer = serverId === undefined ? undefined
      : [...this.serverIndex.keys()].find(key => key.toLowerCase() === serverId.toLowerCase());
    const wantsLatestPage = !sort && !sessionId && from === undefined && to === undefined && !levelSet && before === Infinity && page === 0 && this.size > 10000;
    if (!parsedQuery.length && serverId === undefined && wantsLatestPage) {
      const events: LogEvent[] = [];
      for (let i = this.size - 1; i >= 0 && events.length < PAGE_SIZE; i--) {
        const event = this.slots[(this.head + i) % this.maxRows]!.event;
        if (levelMatches(event.level)) events.push(event);
      }
      return { events: events.reverse().map(pickFields), page: 0, pages: Math.max(1, Math.ceil(this.size / PAGE_SIZE)), matched: this.size, ...this.stats() };
    }
    if (!parsedQuery.length && serverId !== undefined && wantsLatestPage) {
      const index = exactServer === undefined ? undefined : this.serverIndex.get(exactServer);
      if (index) {
        const events: LogEvent[] = [];
        for (const slot of index.iterateFromEnd()) {
          if (events.length >= PAGE_SIZE) break;
          events.push(slot.event);
        }
        return { events: events.reverse().map(pickFields), page: 0, pages: Math.max(1, Math.ceil(index.length / PAGE_SIZE)), matched: index.length, ...this.stats() };
      }
      return { events: [], page: 0, pages: 1, matched: 0, ...this.stats() };
    }
    // Selecting a server in the UI sends a lone `serverId:` term. That's common
    // enough (and otherwise falls off the fast path above) to warrant its own
    // index instead of a full scan of every retained event.
    const soleToken = parsedQuery.length === 1 && parsedQuery[0].length === 1 ? parsedQuery[0][0] : undefined;
    if (soleToken?.field === 'serverId' && !soleToken.negate && soleToken.regex === undefined && wantsLatestPage) {
      const key = findServerKey(this.serverIndex, soleToken.value);
      const index = key !== undefined ? this.serverIndex.get(key) : undefined;
      if (index) {
        const events: LogEvent[] = [];
        for (const slot of index.iterateFromEnd()) {
          if (events.length >= PAGE_SIZE) break;
          events.push(slot.event);
        }
        return { events: events.reverse().map(pickFields), page: 0, pages: Math.max(1, Math.ceil(index.length / PAGE_SIZE)), matched: index.length, ...this.stats() };
      }
    }
    const matches: LogEvent[] = [];
    for (let i = this.size - 1; i >= 0; i--) {
      const event = this.slots[(this.head + i) % this.maxRows]!.event;
      if (event.id <= before && (sessionId === undefined || event.sessionId === sessionId) && (from === undefined || (event.timestampMs ?? 0) >= from) && (to === undefined || (event.timestampMs ?? 0) <= to) && (serverId === undefined || event.serverId?.toLowerCase() === serverId.toLowerCase()) && levelMatches(event.level)
        && matchesQuery(event, parsedQuery)) matches.push(event);
    }
    if (sort) {
      const sorted = sortEvents(matches, sort, sortDirection);
      const sortedPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
      page = Math.max(0, Math.min(sortedPages - 1, Number.isInteger(page) ? page : 0));
      return { events: sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(pickFields), page, pages: sortedPages,
        matched: sorted.length, ...this.stats() };
    }
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
    // Each page is chronological; page zero is the newest page.
    const events = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).reverse().map(pickFields);
    return { events, page, pages, matched: matches.length, ...this.stats() };
  }

  // Return every retained event in chronological order for explicit exports.
  // The normal viewer uses page() so a large store never crosses the webview
  // boundary in one message; exports are user initiated and intentionally
  // operate on the bounded retained set.
  all({ query = '', serverId, levels, before = Infinity, sort, sortDirection = 'asc', sessionId, from, to }: PageOptions = {}): LogEvent[] {
    if (!Number.isFinite(before)) before = Infinity;
    const levelSet = levels ? new Set(levels) : undefined;
    const parsedQuery: ParsedQuery = parseQuery(query.slice(0, 256));
    const events: LogEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const event = this.slots[(this.head + i) % this.maxRows]!.event;
      if (event.id <= before && (sessionId === undefined || event.sessionId === sessionId) && (from === undefined || (event.timestampMs ?? 0) >= from) && (to === undefined || (event.timestampMs ?? 0) <= to) && (serverId === undefined || event.serverId?.toLowerCase() === serverId.toLowerCase())
        && (!levelSet || levelSet.has(event.level)) && matchesQuery(event, parsedQuery)) {
        events.push({ ...event, fields: event.fields ? { ...event.fields } : event.fields });
      }
    }
    return sort ? sortEvents(events, sort, sortDirection) : events;
  }

  private filtered(options: PageOptions = {}): LogEvent[] {
    return this.all(options);
  }

  /** Field names and the most common values for the current search input. */
  fieldSuggestions(input = '', serverId?: string): { fields: string[]; values: FacetValue[] } {
    const fields = new Set(BUILTIN_FIELDS);
    const values = new Map<string, number>();
    const match = input.match(/(?:^|\s)(?:@?([A-Za-z_][A-Za-z0-9_.]*):)?([^\s]*)$/);
    const fieldPrefix = (match?.[1] ?? match?.[2] ?? '').toLowerCase();
    const valuePrefix = match?.[1] ? (match[2] ?? '').toLowerCase() : '';
    for (let i = 0; i < this.size; i++) {
      const event = this.slots[(this.head + i) % this.maxRows]!.event;
      if (serverId && event.serverId?.toLowerCase() !== serverId.toLowerCase()) continue;
      for (const key of Object.keys(event.fields ?? {})) fields.add(key);
      if (match?.[1]) {
        const value = fieldValue(event, match[1]);
        if (value !== undefined && String(value).toLowerCase().startsWith(valuePrefix)) {
          const text = String(value); values.set(text, (values.get(text) ?? 0) + 1);
        }
      }
    }
    return { fields: [...fields].filter(field => field.toLowerCase().startsWith(fieldPrefix)).sort().slice(0, 40),
      values: [...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count })) };
  }

  facets(field: string, options: PageOptions = {}): FacetValue[] {
    const counts = new Map<string, number>();
    for (const event of this.filtered(options)) {
      const value = fieldValue(event, field);
      if (value === undefined || value === null || value === '') continue;
      const text = String(value).slice(0, 160);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([value, count]) => ({ value, count }));
  }

  errorGroups(options: PageOptions = {}, events?: LogEvent[]): ErrorGroup[] {
    const groups = new Map<string, ErrorGroup>();
    for (const event of events ?? this.filtered(options)) {
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
  patterns(options: PageOptions = {}, events?: LogEvent[], trendBuckets = 10): LogPattern[] {
    const list = events ?? this.filtered(options);
    const timestamps = list.map(event => event.timestampMs).filter((value): value is number => Number.isFinite(value));
    const from = options.from ?? (timestamps.length ? Math.min(...timestamps) : undefined);
    const to = options.to ?? (timestamps.length ? Math.max(...timestamps) : undefined);
    const bucketSize = from !== undefined && to !== undefined ? Math.max(1, (to - from) / trendBuckets) : 1;
    const groups = new Map<string, LogPattern>();
    for (const event of list) {
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

  analysis(options: PageOptions = {}): AnalysisResult {
    const events = this.filtered(options);
    const timestamps = events.map(event => event.timestampMs).filter((value): value is number => Number.isFinite(value));
    const from = options.from ?? (timestamps.length ? Math.min(...timestamps) : undefined);
    const to = options.to ?? (timestamps.length ? Math.max(...timestamps) : undefined);
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
      errorGroups: this.errorGroups(options, events), patterns: this.patterns(options, events), range: { from, to }
    };
  }

  serverIds(): string[] { return [...this.serverIndex.keys()]; }

  serverLabel(serverId: string): string | undefined {
    const index = this.serverIndex.get(serverId);
    for (const slot of index?.iterateFromEnd() ?? []) return slot.event.server;
    return undefined;
  }

  stats(): Stats {
    return { total: this.total, retained: this.size, discarded: this.discarded,
      truncated: this.truncated, bytes: this.bytes, maxBytes: this.maxBytes, maxRows: this.maxRows };
  }

  columns(): string[] {
    const preferred = ['service', 'logger', 'requestId', 'traceId', 'method', 'path', 'status', 'statusCode', 'durationMs', 'host', 'environment'];
    return preferred.filter(key => this.columnCache.has(key)).slice(0, 6);
  }

  /** Every field observed in retained payloads, for sort/facet controls. */
  fieldNames(): string[] {
    const extra = [...this.columnCache].filter(field => !BUILTIN_FIELDS.includes(field)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return [...BUILTIN_FIELDS, ...extra.slice(0, 200)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
}

export class LineReader {
  onLine: (line: string, truncated: boolean) => void;
  limit: number;
  pending: string;
  truncated: boolean;
  decoder: StringDecoder;

  constructor(onLine: (line: string, truncated: boolean) => void, limit = 64 * 1024) {
    this.onLine = onLine;
    this.limit = limit;
    this.pending = '';
    this.truncated = false;
    this.decoder = new StringDecoder('utf8');
  }

  write(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }

  consume(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      const room = this.limit - this.pending.length;
      this.pending += text.slice(start, Math.min(end, start + room));
      if (end - start > room) this.truncated = true;
      if (newline === -1) break;
      this.emit();
      start = newline + 1;
    }
  }

  emit(): void {
    const line = this.pending.replace(/\r$/, '');
    if (line || this.truncated) this.onLine(line, this.truncated);
    this.pending = '';
    this.truncated = false;
  }

  end(): void { this.consume(this.decoder.end()); this.emit(); }
}
