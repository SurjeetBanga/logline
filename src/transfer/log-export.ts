import type { LogEvent } from '../core/types';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { redactEvent, type RedactionOptions } from '../core/redaction';

export const CSV_BASE_COLUMNS = ['id', 'timestamp', 'timestampMs', 'level', 'message', 'stream', 'server', 'serverId', 'sessionId', 'raw'];
export const CSV_FIELD_LIMIT = 200;

export type ExportFormat = 'jsonl' | 'json' | 'csv';

export interface ExportRequest {
  query?: string;
  levels?: string[];
  serverId?: string;
}

export function exportQuery(request: ExportRequest = {}): string {
  const server = request.serverId ? `serverId:${request.serverId}` : '';
  return [server, request.query?.trim() ?? ''].filter(Boolean).join(' ');
}

export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function* exportParts(events: readonly LogEvent[], format: ExportFormat, transform: (event: LogEvent) => LogEvent): Generator<string> {
  if (format === 'json') {
    if (!events.length) { yield '[]\n'; return; }
    yield '[\n';
    for (let i = 0; i < events.length; i++) {
      yield JSON.stringify(transform(events[i]), null, 2).replace(/^/gm, '  ') + (i < events.length - 1 ? ',\n' : '\n');
    }
    yield ']\n'; return;
  }
  if (format === 'jsonl') { for (const event of events) yield JSON.stringify(transform(event)) + '\n'; return; }
  // Field columns are always prefixed, even when a field's name doesn't collide
  // with a base column, so a header never ambiguously refers to either source
  // depending on which events happen to be in the export.
  const fields = new Set<string>();
  outer: for (const event of events) for (const key of Object.keys(event.fields ?? {})) {
    fields.add(key);
    if (fields.size >= CSV_FIELD_LIMIT) break outer;
  }
  const columns = [...CSV_BASE_COLUMNS, ...[...fields].sort().map(key => `field:${key}`)];
  yield columns.map(csvCell).join(',') + '\n';
  for (const original of events) {
    const event = transform(original);
    yield columns.map(column => {
      const key = column.slice('field:'.length);
      return column.startsWith('field:') ? csvCell(event.fields && Object.hasOwn(event.fields, key) ? event.fields[key] : undefined)
        : csvCell(event[column as keyof LogEvent]);
    }).join(',') + '\n';
  }
}

export function serializeExport(events: readonly LogEvent[], format: ExportFormat): string {
  return [...exportParts(events, format, event => event)].join('');
}

/** One bounded batch plus one record; yield even when records are very small. */
export async function* exportChunks(events: readonly LogEvent[], format: ExportFormat, options: RedactionOptions = {},
  cancelled = () => false): AsyncGenerator<Uint8Array> {
  const transform = (event: LogEvent) => {
    if (cancelled()) throw new Error('Export cancelled.');
    return redactEvent(event, options);
  };
  let parts: Buffer[] = [];
  let bytes = 0;
  for (const part of exportParts(events, format, transform)) {
    if (cancelled()) throw new Error('Export cancelled.');
    const buffer = Buffer.from(part, 'utf8');
    parts.push(buffer); bytes += buffer.length;
    if (bytes >= 256 * 1024 || parts.length >= 128) {
      yield Buffer.concat(parts, bytes);
      parts = []; bytes = 0;
      await yieldToHost();
    }
  }
  if (parts.length) yield Buffer.concat(parts, bytes);
}
