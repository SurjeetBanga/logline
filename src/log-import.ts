import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldToHost } from 'node:timers/promises';

export interface ImportRecord { raw: string; truncated: boolean; }

// Keep at most one bounded record, rather than a file's text, split lines and
// parsed objects at the same time. Oversized records still consume their full
// framing so the following record can be read correctly.
class RecordBuffer {
  private parts: string[] = [];
  private length = 0;
  private truncated = false;
  constructor(private limit: number) {}
  append(text: string): void {
    const room = this.limit - this.length;
    if (text.length > room) this.truncated = true;
    if (room > 0 && text) {
      const part = text.slice(0, room);
      this.parts.push(part);
      this.length += part.length;
    }
  }
  take(): ImportRecord {
    const record = { raw: this.parts.join(''), truncated: this.truncated };
    this.parts = []; this.length = 0; this.truncated = false;
    return record;
  }
}

class RecordFramer {
  private buffer: RecordBuffer;
  private quoted = false;
  private escaped = false;
  private depth = 0;
  private arrayDocument?: boolean;
  private arrayEnded = false;
  private cellStart = true;
  private quotePending = false;
  constructor(private format: string, limit: number) { this.buffer = new RecordBuffer(limit); }

  *write(text: string): Generator<ImportRecord> {
    if (this.format !== 'json' && this.format !== 'csv') {
      let start = 0;
      for (let end; (end = text.indexOf('\n', start)) !== -1; start = end + 1) {
        this.buffer.append(text.slice(start, end));
        yield this.buffer.take();
      }
      this.buffer.append(text.slice(start));
      return;
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.format === 'csv') {
        if (this.quotePending) {
          this.quotePending = false;
          if (char === '"') continue; // doubled quote inside a quoted cell
          this.quoted = false;
        }
        if (this.quoted) { if (char === '"') this.quotePending = true; continue; }
        if (char === '"' && this.cellStart) { this.quoted = true; this.cellStart = false; continue; }
        if (char === '\n' || char === '\r') {
          this.buffer.append(text.slice(start, i));
          yield this.buffer.take();
          start = i + 1; this.cellStart = true;
        } else this.cellStart = char === ',';
        continue;
      }
      if (this.arrayDocument === undefined) {
        if (/\s|\uFEFF/.test(char)) { start = i + 1; continue; }
        this.arrayDocument = char === '[';
        if (this.arrayDocument) { start = i + 1; continue; }
      }
      if (this.arrayEnded) {
        if (!/\s/.test(char)) throw new Error('Unexpected content after the JSON array.');
        start = i + 1; continue;
      }
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.quoted = false;
        continue;
      }
      if (char === '"') { this.quoted = true; continue; }
      if (this.depth === 0 && this.arrayDocument && (char === ',' || char === ']')) {
        this.buffer.append(text.slice(start, i));
        yield this.buffer.take();
        start = i + 1;
        if (char === ']') this.arrayEnded = true;
      } else if (char === '{' || char === '[') this.depth++;
      else if (char === '}' || char === ']') {
        this.depth--;
        if (!this.arrayDocument && this.depth === 0) {
          this.buffer.append(text.slice(start, i + 1));
          yield this.buffer.take();
          start = i + 1;
        }
      } else if (!this.arrayDocument && this.depth === 0 && (char === '\n' || char === '\r')) {
        this.buffer.append(text.slice(start, i));
        yield this.buffer.take();
        start = i + 1;
      }
    }
    this.buffer.append(text.slice(start));
  }

  end(): ImportRecord { return this.buffer.take(); }
}

/** Decode UTF-8 across chunk boundaries and yield records without parsing JSON twice. */
export async function* importRecords(chunks: AsyncIterable<Uint8Array>, format = 'jsonl', limit = 65536): AsyncGenerator<ImportRecord> {
  const decoder = new StringDecoder('utf8');
  const framer = new RecordFramer(format, limit);
  let header: string[] | undefined;
  let firstText = true;
  const convert = (record: ImportRecord): ImportRecord | undefined => {
    if (!(format === 'csv' ? record.raw : record.raw.trim()) && !record.truncated) return undefined;
    if (format !== 'csv') return record;
    if (!header) {
      if (record.truncated) throw new Error('CSV header exceeds the maximum log line length.');
      header = parseCsv(record.raw)[0];
      return undefined;
    }
    if (record.truncated) return record;
    const row = parseCsv(record.raw)[0];
    if (!row) return undefined;
    const value = csvRecord(header, row);
    if (value === undefined) return undefined;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return { raw: raw.slice(0, limit), truncated: raw.length > limit };
  };
  for await (const chunk of chunks) {
    let text = decoder.write(chunk);
    if (firstText && text) { text = text.replace(/^\uFEFF/, ''); firstText = false; }
    for (const record of framer.write(text)) {
      const converted = convert(record);
      if (converted) yield converted;
    }
    // Even an in-memory filesystem provider must let capture and UI callbacks run.
    await yieldToHost();
  }
  for (const record of framer.write(decoder.end())) {
    const converted = convert(record);
    if (converted) yield converted;
  }
  const final = convert(framer.end());
  if (final) yield final;
}

// RFC 4180: cells may be quoted, a doubled quote is a literal one, and a quoted
// cell may span commas and newlines. Only a quote in first position opens a
// cell, which is what serializeExport emits.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') { cell += char; continue; }
      if (text[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (char === '"' && cell === '') { quoted = true; continue; }
    if (char === ',') { row.push(cell); cell = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseCsvRecords(text: string): unknown[] {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) return [];
  const records: unknown[] = [];
  for (const row of rows) {
    const record = csvRecord(header, row);
    if (record !== undefined) records.push(record);
  }
  return records;
}

function csvRecord(header: string[], row: string[]): unknown {
  if (!row.some(cell => cell !== '')) return undefined;
  const cells = new Map(header.map((name, index) => [name.trim(), row[index] ?? '']));
  // A Logline CSV export keeps the original line in `raw`, so replaying that
  // reproduces the event exactly - timestamp, level and JSON payload included -
  // instead of rebuilding an approximation from the flattened columns.
  const raw = cells.get('raw');
  if (raw) return raw;
  const record: Record<string, unknown> = {};
  for (const [name, value] of cells) {
    // `id` and `timestampMs` are re-derived on ingest; carrying them over
    // would collide with live capture ids and add noise columns.
    if (!name || value === '' || name === 'id' || name === 'timestampMs') continue;
    record[name.startsWith('field:') ? name.slice('field:'.length) : name] = value;
  }
  return Object.keys(record).length ? record : undefined;
}
