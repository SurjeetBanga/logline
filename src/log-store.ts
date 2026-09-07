import { StringDecoder } from 'node:string_decoder';
import { matchesQuery, parseQuery, type ParsedQuery } from './query';
import type { LogEvent } from './types';

const PAGE_SIZE = 1000;

interface Slot {
  event: LogEvent;
  bytes: number;
}

const pickFields = ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields }: LogEvent): LogEvent =>
  ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields });

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
  // Omitted = no filter (all levels). An empty array deliberately matches
  // nothing — that's a real, distinct choice from "not filtering at all".
  levels?: string[];
  page?: number;
  before?: number;
}

export interface PageResult extends Stats {
  events: LogEvent[];
  page: number;
  pages: number;
  matched: number;
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

  page({ query = '', levels, page = 0, before = Infinity }: PageOptions = {}): PageResult {
    if (!Number.isFinite(before)) before = Infinity;
    // `levels` omitted means no filter (every level shown, the default —
    // matches the fast path below); an empty array is a deliberate "nothing
    // checked", which matches nothing.
    const levelSet = levels ? new Set(levels) : undefined;
    const levelMatches = (eventLevel: string) => !levelSet || levelSet.has(eventLevel);
    query = query.slice(0, 256);
    const parsedQuery: ParsedQuery = parseQuery(query);
    const wantsLatestPage = !levelSet && before === Infinity && page === 0 && this.size > 10000;
    if (!parsedQuery.length && wantsLatestPage) {
      const events: LogEvent[] = [];
      for (let i = this.size - 1; i >= 0 && events.length < PAGE_SIZE; i--) {
        const event = this.slots[(this.head + i) % this.maxRows]!.event;
        if (levelMatches(event.level)) events.push(event);
      }
      return { events: events.reverse().map(pickFields), page: 0, pages: Math.max(1, Math.ceil(this.size / PAGE_SIZE)), matched: this.size, ...this.stats() };
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
      if (event.id <= before && levelMatches(event.level)
        && matchesQuery(event, parsedQuery)) matches.push(event);
    }
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
    // Each page is chronological; page zero is the newest page.
    const events = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).reverse().map(pickFields);
    return { events, page, pages, matched: matches.length, ...this.stats() };
  }

  stats(): Stats {
    return { total: this.total, retained: this.size, discarded: this.discarded,
      truncated: this.truncated, bytes: this.bytes, maxBytes: this.maxBytes, maxRows: this.maxRows };
  }

  columns(): string[] {
    const preferred = ['service', 'logger', 'requestId', 'traceId', 'method', 'path', 'status', 'statusCode', 'durationMs', 'host', 'environment'];
    return preferred.filter(key => this.columnCache.has(key)).slice(0, 6);
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
