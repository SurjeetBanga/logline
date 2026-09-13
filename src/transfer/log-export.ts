import type { LogEvent } from '../core/types';

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

export function serializeExport(events: LogEvent[], format: ExportFormat): string {
  if (format === 'json') return JSON.stringify(events, null, 2) + '\n';
  if (format === 'jsonl') return events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
  const baseColumns = ['id', 'timestamp', 'timestampMs', 'level', 'message', 'stream', 'server', 'serverId', 'sessionId', 'raw'];
  // Field columns are always prefixed, even when a field's name doesn't collide
  // with a base column, so a header never ambiguously refers to either source
  // depending on which events happen to be in the export.
  const fieldKeys = [...new Set(events.flatMap(event => Object.keys(event.fields ?? {})))].sort();
  const columns = [...baseColumns, ...fieldKeys.map(key => `field:${key}`)];
  const rows = [columns.join(',')];
  for (const event of events) {
    rows.push(columns.map(column => column.startsWith('field:')
      ? csvCell(event.fields?.[column.slice('field:'.length)])
      : csvCell(event[column as keyof LogEvent])).join(','));
  }
  return rows.join('\n') + '\n';
}
