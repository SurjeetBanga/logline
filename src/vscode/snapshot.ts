import type { Ingestion } from '../capture/ingestion';
import type { RuntimeState } from '../capture/runtime-state';
import type { SessionRegistry } from '../capture/session-registry';
import type { LogStore } from '../core/log-store';
import { getField } from '../core/query';
import type { Settings } from '../core/settings';
import type { LogEvent } from '../core/types';
import type { Snapshot, ViewRequest } from '../protocol/messages';
import type { LogPersistence } from '../storage/log-persistence';
import type { SavedSearches } from '../storage/saved-searches';

function pickColumns(event: LogEvent, columns: string[]): LogEvent['fields'] {
  const fields = event.fields;
  if (!fields) return fields;
  const picked: Record<string, string | number | boolean> = {};
  for (const column of columns) {
    const value = fields[column] ?? getField(event, column);
    if (value !== undefined) picked[column] = value;
  }
  return picked;
}

export interface SnapshotSources {
  store: LogStore; config: Settings; registry: SessionRegistry; state: RuntimeState;
  ingestion: Ingestion; persistence: LogPersistence; searches: SavedSearches; running: boolean;
}
export function buildSnapshot(msg: Extract<ViewRequest, { type: 'snapshot'; }>,
  { store, config, registry, state, ingestion, persistence, searches, running }: SnapshotSources): Snapshot {
  const options = { query: msg.query, serverId: msg.serverId, levels: msg.levels,
    page: msg.page, before: msg.before, sort: msg.sort, sortDirection: msg.sortDirection };
  const configured = config.get<string[]>('columns', []);
  const columns = configured.length ? configured : store.columns(options.serverId);
  const columnFields = store.columnFields(options.serverId);
  const requestedColumns = Array.isArray(msg.columns)
    ? msg.columns.filter((field): field is string => typeof field === 'string' && columnFields.includes(field)) : [];
  const projectedColumns = [...new Set([...columns, ...requestedColumns])];
  const pageResult = msg.statsOnly ? undefined : store.page(options);
  const result = pageResult ?? store.stats();
  // A row only ever reads the displayed field columns, but a structured
  // payload can carry dozens of keys per event. Trimming here keeps the
  // refresh payload proportional to what is on screen rather than to how
  // wide the log records happen to be.
  const events = pageResult?.events.map(event => ({ ...event, fields: pickColumns(event, projectedColumns) }));
  return {
    type: 'snapshot',
    ...result, ...(events ? { events } : {}),
    columns,
    columnFields,
    fields: store.fieldNames(),
    status: state.status, command: state.command, running,
    servers: registry.serverSummaries(config.get('servers', []), store), sessions: registry.sessionSummaries(),
    searches: { saved: searches.savedSearches() },
    newest: ingestion.sequence, generation: state.generation,
    persistDropped: persistence.persistDropped,
    timezone: config.get('timezone', 'local')
  };

}
