import { fieldValue, sortEvents } from './event-order';
import { analyzeEvents, findPatterns, groupErrors, type AnalysisResult, type ErrorGroup, type LogPattern } from './log-analysis';
import { canonicalField, matchesQuery, parseQuery, type ParsedQuery } from './query';
import type { LogEvent } from './types';

export type { AnalysisResult, ErrorGroup, LogPattern } from './log-analysis';

const PAGE_SIZE = 1000;

interface Slot {
  event: LogEvent;
  bytes: number;
}

const pickFields = ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields,
  taskName, taskType, taskState, dependencies, dependencyState, exitReason }: LogEvent): LogEvent =>
({
  id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields,
  taskName, taskType, taskState, dependencies, dependencyState, exitReason
});

// A small append-only deque of slot refs for one server, oldest first. Eviction
// from the main ring always removes the globally oldest surviving event, which
// is always that event's own server's oldest surviving entry too, so `shift()`
// here stays correct without re-scanning anything.
class ServerIndex {
  items: (Slot | undefined)[] = [];
  start = 0;
  // Reference counts let eviction release field names without scanning the ring.
  fields = new Map<string, number>();
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

// First event after an id boundary in any chronological, randomly accessible
// sequence (the ring or a server's deque). IDs can have gaps after dropped lines.
function upperBound(length: number, eventAt: (offset: number) => LogEvent, id: number): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (eventAt(middle).id <= id) low = middle + 1;
    else high = middle;
  }
  return low;
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

// One filter's match set, kept between refreshes. `matches` is oldest-first;
// `start` skips the prefix that has since been evicted from the ring.
interface PageCache {
  key: string;
  matches: (LogEvent | undefined)[];
  start: number;
  lastId: number;
}

export interface PageResult extends Stats {
  events: LogEvent[];
  page: number;
  pages: number;
  matched: number;
}

export interface SuggestedValue { value: string; count: number; }
const BUILTIN_FIELDS = ['id', 'level', 'message', 'timestamp', 'timestampMs', 'stream', 'server', 'serverId', 'sessionId',
  'taskName', 'taskType', 'taskState', 'dependencies', 'dependencyState', 'exitReason', 'traceId', 'spanId', 'parentSpanId',
  'requestId', 'status', 'statusCode', 'durationMs'];

const fieldCollator = new Intl.Collator(undefined, { numeric: true });

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
  private fieldCounts!: Map<string, number>;
  private fieldNamesCache?: string[];
  serverIndex!: Map<string, ServerIndex>;
  private pageCache: PageCache | undefined;
  private sortedCache?: { key: string; events: LogEvent[]; };

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
    this.fieldCounts = new Map();
    this.fieldNamesCache = undefined;
    this.serverIndex = new Map();
    this.pageCache = undefined;
    this.sortedCache = undefined;
  }

  private evictOldest(): void {
    const evicted = this.slots[this.head]!;
    this.bytes -= evicted.bytes;
    const serverId = evicted.event.serverId;
    const index = serverId === undefined ? undefined : this.serverIndex.get(serverId);
    for (const key in evicted.event.fields) {
      const count = this.fieldCounts.get(key)! - 1;
      if (count) this.fieldCounts.set(key, count);
      else { this.fieldCounts.delete(key); this.columnCache.delete(key); this.fieldNamesCache = undefined; }
      if (index) {
        const serverCount = index.fields.get(key)! - 1;
        if (serverCount) index.fields.set(key, serverCount); else index.fields.delete(key);
      }
    }
    // Release cached event references immediately, even while the viewer is hidden.
    const cache = this.pageCache;
    if (cache?.matches[cache.start]?.id === evicted.event.id) cache.matches[cache.start++] = undefined;
    this.sortedCache = undefined;
    if (serverId !== undefined) {
      index?.shift();
      if (index?.length === 0) this.serverIndex.delete(serverId);
    }
    this.slots[this.head] = undefined;
    this.head = (this.head + 1) % this.maxRows;
    this.size--;
    this.discarded++;
  }

  private insertSlot(slot: Slot): void {
    this.sortedCache = undefined;
    this.slots[(this.head + this.size) % this.maxRows] = slot;
    const serverId = slot.event.serverId;
    let index: ServerIndex | undefined;
    if (serverId !== undefined) {
      index = this.serverIndex.get(serverId);
      if (!index) { index = new ServerIndex(); this.serverIndex.set(serverId, index); }
      index.push(slot);
    }
    // A plain for-in avoids allocating a key array per ingested line, which at
    // flood rates is the difference between steady state and constant GC.
    const fields = slot.event.fields;
    if (fields) for (const key in fields) {
      if (!this.fieldCounts.has(key)) { this.columnCache.add(key); this.fieldNamesCache = undefined; }
      this.fieldCounts.set(key, (this.fieldCounts.get(key) ?? 0) + 1);
      if (index) index.fields.set(key, (index.fields.get(key) ?? 0) + 1);
    }
    this.size++;
    this.bytes += slot.bytes;
  }

  add(event: LogEvent): void {
    this.total++;
    if (event.truncated) this.truncated++;
    let bytes = 256;
    for (const key in event) {
      const value = (event as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string') bytes += value.length * 2;
    }
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
  context(id: number): { events: LogEvent[]; server?: string; missing: boolean; } {
    const anchor = this.find(id);
    if (!anchor) return { events: [], missing: true };
    const earlier: LogEvent[] = [];
    const later: LogEvent[] = [];
    // Unknown session boundaries cannot safely include neighbouring events.
    if (anchor.sessionId !== undefined) {
      const index = anchor.serverId === undefined ? undefined : this.serverIndex.get(anchor.serverId);
      const length = index?.length ?? this.size;
      const eventAt = index ? (offset: number) => index.items[index.start + offset]!.event
        : (offset: number) => this.slots[(this.head + offset) % this.maxRows]!.event;
      const after = upperBound(length, eventAt, id);
      // Seek to the anchor and stop as soon as each side has enough context.
      for (let i = after - 2; i >= 0 && earlier.length < 25; i--) {
        const event = eventAt(i);
        if (event.serverId === anchor.serverId && event.sessionId === anchor.sessionId) earlier.push(event);
      }
      for (let i = after; i < length && later.length < 25; i++) {
        const event = eventAt(i);
        if (event.serverId === anchor.serverId && event.sessionId === anchor.sessionId) later.push(event);
      }
    }
    return { events: [...earlier.reverse(), anchor, ...later].map(pickFields), server: anchor.server, missing: false };
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
    const canUseIndex = !sort && sessionId === undefined && from === undefined && to === undefined && !levelSet;
    if (!parsedQuery.length && canUseIndex) {
      if (serverId === undefined) {
        return this.indexedPage(this.size, offset => this.slots[(this.head + offset) % this.maxRows]!.event, page, before);
      }
      const wantedServer = serverId.toLowerCase();
      const keys = [...this.serverIndex.keys()].filter(key => key.toLowerCase() === wantedServer);
      // The filter is case-insensitive: multiple differently cased IDs must
      // use the general path so no matching server is silently omitted.
      if (keys.length <= 1) {
        const index = this.serverIndex.get(keys[0]);
        return this.indexedPage(index?.length ?? 0, offset => index!.items[index!.start + offset]!.event, page, before);
      }
    }
    const soleToken = parsedQuery.length === 1 && parsedQuery[0].length === 1 ? parsedQuery[0][0] : undefined;
    if (serverId === undefined && soleToken?.field === 'serverId' && !soleToken.negate
      && !soleToken.compare && soleToken.regex === undefined && soleToken.value && canUseIndex) {
      const key = findServerKey(this.serverIndex, soleToken.value);
      const index = key !== undefined ? this.serverIndex.get(key) : undefined;
      if (index) return this.indexedPage(index.length, offset => index.items[index.start + offset]!.event, page, before);
    }
    // A `last:5m` window slides with the wall clock, so its match set cannot be
    // carried between refreshes; every other filter is a pure function of the
    // retained events and is safe to keep.
    const relative = parsedQuery.some(group => group.some(token => token.canonical === 'last'));
    const key = JSON.stringify([query, serverId?.toLowerCase() ?? null, levels ? [...levels].sort() : null,
      sessionId ?? null, from ?? null, to ?? null, Number.isFinite(before) ? before : null]);
    const { matches, start } = this.matchingEvents(key, !relative,
      this.filterFor({ before, sessionId, from, to, serverId, levelMatches, parsedQuery }));
    const matched = matches.length - start;
    if (sort) {
      const sortKey = JSON.stringify([key, sort, sortDirection]);
      const sorted = !relative && this.sortedCache?.key === sortKey ? this.sortedCache.events
        : sortEvents(matches.slice(start) as LogEvent[], sort, sortDirection);
      this.sortedCache = relative ? undefined : { key: sortKey, events: sorted };
      const sortedPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
      page = Math.max(0, Math.min(sortedPages - 1, Number.isInteger(page) ? page : 0));
      return {
        events: sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(pickFields), page, pages: sortedPages,
        matched: sorted.length, ...this.stats()
      };
    }
    const pages = Math.max(1, Math.ceil(matched / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
    // Each page is chronological; page zero is the newest page. `matches` is
    // oldest-first, so page N counts back from its end.
    const end = matched - page * PAGE_SIZE;
    const events = (matches.slice(start + Math.max(0, end - PAGE_SIZE), start + end) as LogEvent[]).map(pickFields);
    return { events, page, pages, matched, ...this.stats() };
  }

  // Unfiltered pages only read their own rows. A frozen boundary is found
  // by binary search, so browsing history does not allocate a full match set.
  private indexedPage(length: number, eventAt: (offset: number) => LogEvent, page: number, before: number): PageResult {
    const matched = before === Infinity ? length : upperBound(length, eventAt, before);
    const pages = Math.max(1, Math.ceil(matched / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
    const end = matched - page * PAGE_SIZE;
    const events: LogEvent[] = [];
    for (let i = Math.max(0, end - PAGE_SIZE); i < end; i++) events.push(pickFields(eventAt(i)));
    return { events, page, pages, matched, ...this.stats() };
  }

  // Builds the row predicate once per query rather than re-deriving the
  // lowercased server id and level lookup for every event in the ring.
  private filterFor({ before, sessionId, from, to, serverId, levelMatches, parsedQuery }: {
    before: number; sessionId?: string; from?: number; to?: number; serverId?: string;
    levelMatches: (level: string) => boolean; parsedQuery: ParsedQuery;
  }): (event: LogEvent) => boolean {
    const wantedServer = serverId?.toLowerCase();
    return event => event.id <= before
      && (sessionId === undefined || event.sessionId === sessionId)
      && (from === undefined || (event.timestampMs ?? 0) >= from)
      && (to === undefined || (event.timestampMs ?? 0) <= to)
      && (wantedServer === undefined || event.serverId?.toLowerCase() === wantedServer)
      && levelMatches(event.level) && matchesQuery(event, parsedQuery);
  }

  // The retained set only ever changes at its two ends: new events are appended
  // and the oldest are evicted. So when the same filter is re-run — which is
  // what every refresh tick does while logs stream — only the events that
  // arrived since the last run need testing, instead of the whole ring.
  private matchingEvents(key: string, cacheable: boolean, test: (event: LogEvent) => boolean): Pick<PageCache, 'matches' | 'start'> {
    const newestId = this.size ? this.slots[(this.head + this.size - 1) % this.maxRows]!.event.id : -1;
    const cache = cacheable && this.pageCache?.key === key ? this.pageCache : undefined;
    if (cache) {
      const oldestId = this.size ? this.slots[this.head]!.event.id : Infinity;
      while (cache.start < cache.matches.length && cache.matches[cache.start]!.id < oldestId) cache.matches[cache.start++] = undefined;
      if (cache.start > 1024 && cache.start * 2 > cache.matches.length) {
        cache.matches = cache.matches.slice(cache.start);
        cache.start = 0;
      }
      let fresh = 0;
      while (fresh < this.size && this.slots[(this.head + this.size - 1 - fresh) % this.maxRows]!.event.id > cache.lastId) fresh++;
      for (let i = this.size - fresh; i < this.size; i++) {
        const event = this.slots[(this.head + i) % this.maxRows]!.event;
        if (test(event)) cache.matches.push(event);
      }
      cache.lastId = newestId;
      return { matches: cache.matches, start: cache.start };
    }
    const matches: LogEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const event = this.slots[(this.head + i) % this.maxRows]!.event;
      if (test(event)) matches.push(event);
    }
    if (cacheable) this.pageCache = { key, matches, start: 0, lastId: newestId };
    return { matches, start: 0 };
  }

  // Return every retained event in chronological order for explicit exports.
  // The normal viewer uses page() so a large store never crosses the webview
  // boundary in one message; exports are user initiated and intentionally
  // operate on the bounded retained set.
  all(options: PageOptions = {}): LogEvent[] {
    const events = this.scan(options).map(event => ({ ...event, fields: event.fields ? { ...event.fields } : event.fields }));
    return options.sort ? sortEvents(events, options.sort, options.sortDirection ?? 'asc') : events;
  }

  // Chronological references to the matching retained events. all() copies these
  // for export callers that hand events on to redaction and serialization; the
  // in-process readers below only ever read them, and cloning 100k events (and
  // their field maps) just to count them was most of what made analysis stall.
  private scan({ query = '', serverId, levels, before = Infinity, sessionId, from, to }: PageOptions = {}): LogEvent[] {
    if (!Number.isFinite(before)) before = Infinity;
    const levelSet = levels ? new Set(levels) : undefined;
    const parsedQuery: ParsedQuery = parseQuery(query.slice(0, 256));
    const test = this.filterFor({
      before, sessionId, from, to, serverId,
      levelMatches: (level: string) => !levelSet || levelSet.has(level), parsedQuery
    });
    const events: LogEvent[] = [];
    for (let i = 0; i < this.size; i++) {
      const event = this.slots[(this.head + i) % this.maxRows]!.event;
      if (test(event)) events.push(event);
    }
    return events;
  }

  private filtered(options: PageOptions = {}): LogEvent[] {
    const events = this.scan(options);
    return options.sort ? sortEvents(events, options.sort, options.sortDirection ?? 'asc') : events;
  }

  /** Field names and the most common values for the current search input. */
  fieldSuggestions(input = '', serverId?: string): { fields: string[]; values: SuggestedValue[]; } {
    const fields = new Set(BUILTIN_FIELDS);
    const values = new Map<string, number>();
    const match = input.match(/(?:^|\s)(?:@?([A-Za-z_][A-Za-z0-9_.]*):)?([^\s]*)$/);
    const fieldPrefix = (match?.[1] ?? match?.[2] ?? '').toLowerCase();
    const valuePrefix = match?.[1] ? (match[2] ?? '').toLowerCase() : '';
    // Field names are already maintained on ingest, so the common case — typing a
    // bare word — answers without touching the ring at all.
    const wantedServer = serverId?.toLowerCase();
    const known = serverId
      ? this.serverIndex.get([...this.serverIndex.keys()].find(key => key.toLowerCase() === wantedServer) ?? serverId)?.fields.keys()
      : this.columnCache;
    for (const key of known ?? []) fields.add(key);
    if (match?.[1]) {
      for (let i = 0; i < this.size; i++) {
        const event = this.slots[(this.head + i) % this.maxRows]!.event;
        if (wantedServer !== undefined && event.serverId?.toLowerCase() !== wantedServer) continue;
        const value = fieldValue(event, match[1]);
        if (value !== undefined && String(value).toLowerCase().startsWith(valuePrefix)) {
          const text = String(value); values.set(text, (values.get(text) ?? 0) + 1);
        }
      }
    }
    return {
      fields: [...fields].filter(field => field.toLowerCase().startsWith(fieldPrefix)).sort().slice(0, 40),
      values: [...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count }))
    };
  }

  errorGroups(options: PageOptions = {}, events?: LogEvent[]): ErrorGroup[] {
    return groupErrors(events ?? this.filtered(options));
  }

  patterns(options: PageOptions = {}, events?: LogEvent[], trendBuckets = 10): LogPattern[] {
    return findPatterns(events ?? this.filtered(options), options, trendBuckets);
  }

  analysis(options: PageOptions = {}): AnalysisResult {
    return analyzeEvents(this.filtered(options), options);
  }

  serverIds(): string[] { return [...this.serverIndex.keys()]; }

  serverLabel(serverId: string): string | undefined {
    const index = this.serverIndex.get(serverId);
    for (const slot of index?.iterateFromEnd() ?? []) return slot.event.server;
    return undefined;
  }

  stats(): Stats {
    return {
      total: this.total, retained: this.size, discarded: this.discarded,
      truncated: this.truncated, bytes: this.bytes, maxBytes: this.maxBytes, maxRows: this.maxRows
    };
  }

  private columnKeys(serverId?: string): Iterable<string> {
    if (serverId === undefined) return this.columnCache;
    const key = [...this.serverIndex.keys()].find(key => key.toLowerCase() === serverId.toLowerCase());
    return key === undefined ? [] : this.serverIndex.get(key)!.fields.keys();
  }

  columnFields(serverId?: string): string[] {
    const fields: string[] = [];
    for (const field of this.columnKeys(serverId)) { fields.push(field); if (fields.length === 200) break; }
    return fields.sort(fieldCollator.compare);
  }

  columns(serverId?: string): string[] {
    const known = this.columnFields(serverId);
    const preferred = ['service', 'logger', 'requestId', 'traceId', 'method', 'path', 'status', 'statusCode', 'durationMs', 'host', 'environment'];
    const chosen: string[] = [];
    const groups = new Set<string>();
    for (const field of preferred) {
      const key = known.includes(field) ? field : known.find(key => canonicalField(key) === canonicalField(field));
      if (key && !groups.has(canonicalField(key))) { chosen.push(key); groups.add(canonicalField(key)); }
    }
    for (const key of known) {
      if (chosen.length >= 6) break;
      const canonical = canonicalField(key);
      if (groups.has(canonical) || ['level', 'message'].includes(canonical)
        || ['@timestamp', 'ecs.version', 'severityNumber', 'SeverityNumber', 'timeUnixNano', 'observedTimeUnixNano', 'body.stringValue', 'Body.stringValue'].includes(key)) continue;
      // Bare aliases of nested fields remain searchable, but need not duplicate
      // their dotted column in the small automatic selection.
      if (!key.includes('.') && known.some(other => other.endsWith('.' + key))) continue;
      chosen.push(key); groups.add(canonical);
    }
    return chosen.slice(0, 6);
  }

  /** Every field observed in retained payloads, for sort and autocomplete controls. */
  fieldNames(): string[] {
    if (!this.fieldNamesCache) {
      const extra = [...this.columnCache].filter(field => !BUILTIN_FIELDS.includes(field)).sort(fieldCollator.compare);
      this.fieldNamesCache = [...BUILTIN_FIELDS, ...extra.slice(0, 200)].sort(fieldCollator.compare);
    }
    return this.fieldNamesCache.slice();
  }
}
