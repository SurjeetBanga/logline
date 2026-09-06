const { StringDecoder } = require('node:string_decoder');
const { matchesQuery, parseQuery } = require('./query');
const PAGE_SIZE = 1000;

// Approximate UTF-16 storage plus per-record overhead, not total process RSS.
class LogStore {
  constructor(maxRows = 100000, maxBytes = 100 * 1024 * 1024) {
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
    this.clear();
  }

  clear() {
    this.slots = new Array(this.maxRows);
    this.head = 0;
    this.size = 0;
    this.bytes = 0;
    this.total = 0;
    this.discarded = 0;
    this.truncated = 0;
    this.columnCache = new Set();
  }

  add(event) {
    this.total++;
    if (event.truncated) this.truncated++;
    const bytes = 256 + Object.values(event).reduce(
      (sum, value) => sum + (typeof value === 'string' ? value.length * 2 : 0), 0
    );
    if (bytes > this.maxBytes) { this.discarded++; return; }
    while (this.size && (this.size === this.maxRows || this.bytes + bytes > this.maxBytes)) {
      this.bytes -= this.slots[this.head].bytes;
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.maxRows;
      this.size--;
      this.discarded++;
    }
    this.slots[(this.head + this.size) % this.maxRows] = { event, bytes };
    Object.keys(event.fields ?? {}).forEach(key => this.columnCache.add(key));
    this.size++;
    this.bytes += bytes;
  }

  // Ids increase monotonically along the ring, so the newest page can be found
  // without scanning every retained event.
  find(id) {
    let low = 0;
    let high = this.size - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const event = this.slots[(this.head + middle) % this.maxRows].event;
      if (event.id === id) return event;
      if (event.id < id) low = middle + 1;
      else high = middle - 1;
    }
  }

  // Re-home retained events into a new ring, dropping the oldest that no longer
  // fit. Used when the retention settings change without a window reload.
  resize(maxRows, maxBytes) {
    const kept = [];
    for (let i = 0; i < this.size; i++) kept.push(this.slots[(this.head + i) % this.maxRows]);
    const { total, discarded, truncated } = this;
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
    this.clear();
    this.total = total;
    this.discarded = discarded;
    this.truncated = truncated;
    for (const slot of kept) {
      if (slot.bytes > this.maxBytes) { this.discarded++; continue; }
      while (this.size && (this.size === this.maxRows || this.bytes + slot.bytes > this.maxBytes)) {
        this.bytes -= this.slots[this.head].bytes;
        this.slots[this.head] = undefined;
        this.head = (this.head + 1) % this.maxRows;
        this.size--;
        this.discarded++;
      }
      this.slots[(this.head + this.size) % this.maxRows] = slot;
      Object.keys(slot.event.fields ?? {}).forEach(key => this.columnCache.add(key));
      this.size++;
      this.bytes += slot.bytes;
    }
  }

  page({ query = '', level = 'trace', page = 0, before = Infinity } = {}) {
    if (!Number.isFinite(before)) before = Infinity;
    const ranks = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
    const matches = [];
    query = query.slice(0, 256);
    const parsedQuery = parseQuery(query);
    if (!parsedQuery.length && level === 'trace' && before === Infinity && page === 0 && this.size > 10000) {
      const events = [];
      for (let i = this.size - 1; i >= 0 && events.length < PAGE_SIZE; i--) {
        const event = this.slots[(this.head + i) % this.maxRows].event;
        if (ranks[event.level] >= (ranks[level] ?? 0)) events.push(event);
      }
      return { events: events.reverse().map(({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields }) => ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields })), page: 0, pages: Math.max(1, Math.ceil(this.size / PAGE_SIZE)), matched: this.size, ...this.stats() };
    }
    for (let i = this.size - 1; i >= 0; i--) {
      const event = this.slots[(this.head + i) % this.maxRows].event;
      if (event.id <= before && ranks[event.level] >= (ranks[level] ?? 0)
        && matchesQuery(event, parsedQuery)) matches.push(event);
    }
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    page = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
    // Each page is chronological; page zero is the newest page.
    const events = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).reverse().map(
      ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields }) =>
        ({ id, timestamp, timestampMs, level, message, isJson, truncated, stream, fields })
    );
    return { events, page, pages, matched: matches.length, ...this.stats() };
  }

  stats() {
    return { total: this.total, retained: this.size, discarded: this.discarded,
      truncated: this.truncated, bytes: this.bytes, maxBytes: this.maxBytes, maxRows: this.maxRows };
  }

  columns() {
    const preferred = ['service', 'logger', 'requestId', 'traceId', 'method', 'path', 'status', 'statusCode', 'durationMs', 'host', 'environment'];
    return preferred.filter(key => this.columnCache.has(key)).slice(0, 6);
  }
}

class LineReader {
  constructor(onLine, limit = 64 * 1024) {
    this.onLine = onLine;
    this.limit = limit;
    this.pending = '';
    this.truncated = false;
    this.decoder = new StringDecoder('utf8');
  }

  write(chunk) { this.consume(this.decoder.write(chunk)); }

  consume(text) {
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

  emit() {
    const line = this.pending.replace(/\r$/, '');
    if (line || this.truncated) this.onLine(line, this.truncated);
    this.pending = '';
    this.truncated = false;
  }

  end() { this.consume(this.decoder.end()); this.emit(); }
}

module.exports = { LogStore, LineReader };
