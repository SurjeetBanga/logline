import type { Ingestion } from '../capture/ingestion';
import type { RuntimeState } from '../capture/runtime-state';
import type { SessionRegistry } from '../capture/session-registry';
import type { LogStore } from '../core/log-store';
import { getField } from '../core/query';
import type { Settings } from '../core/settings';
import type { LogEvent } from '../core/types';
import type { GuideStatus, Snapshot, ViewRequest } from '../protocol/messages';
import type { LogPersistence } from '../storage/log-persistence';
import type { SavedSearches } from '../storage/saved-searches';
import type { AgentLogAccess } from './agent-access';

function pickColumns(event: LogEvent, columns: string[]): LogEvent['fields'] {
  const fields = event.fields;
  if (!fields) return fields;
  const picked: Record<string, string | number | boolean> = {};
  for (const column of columns) {
    const value = Object.hasOwn(fields, column) ? fields[column] : getField(event, column);
    if (value !== undefined) {
      if (column === '__proto__') Object.defineProperty(picked, column, { value, enumerable: true, writable: true, configurable: true });
      else picked[column] = value;
    }
  }
  return picked;
}

export interface SnapshotSources {
  store: LogStore; config: Settings; registry: SessionRegistry; state: RuntimeState;
  ingestion: Ingestion; persistence: LogPersistence; searches: SavedSearches; running: boolean;
  guideStatus: GuideStatus; agentAccess: AgentLogAccess; terminalCapture?: { status(): { state: 'off' | 'waiting' | 'capturing' | 'attention'; detail: string; active: number; failed: number } };
}
export function buildSnapshot(msg: Extract<ViewRequest, { type: 'snapshot'; }>,
  { store, config, registry, state, ingestion, persistence, searches, running, guideStatus, agentAccess, terminalCapture }: SnapshotSources): Snapshot {
  const options = { query: msg.query, serverId: msg.serverId, sessionId: msg.sessionId, levels: msg.levels,
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
  const sessions = registry.sessionSummaries();
  const known = new Set(sessions.map(session => `${session.serverId}\0${session.id}`));
  // Imported files and retained runs whose registry record has been pruned
  // still need to be selectable in the run picker.
  for (const serverId of store.serverIds()) for (const sessionId of store.sessionIds(serverId)) {
    if (sessionId === '*' || known.has(`${serverId}\0${sessionId}`)) continue;
    const label = store.serverLabel(serverId) ?? serverId;
    sessions.push({ id: sessionId, server: label, serverId, status: 'exited', startedAt: 0,
      sourceKind: 'import', owned: false, captureComplete: true, command: label });
  }
  return {
    type: 'snapshot',
    ...result, ...(events ? { events } : {}),
    columns,
    columnFields,
    fields: store.fieldNames(),
    status: state.status, command: state.command, running,
    servers: registry.serverSummaries(config.get('servers', []), store), sessions,
    searches: { saved: searches.savedSearches() },
    newest: ingestion.sequence, generation: state.generation,
    persistDropped: persistence.persistDropped,
    timezone: config.get('timezone', 'local'), guideStatus, agentSharing: agentAccess.status(),
    captureTerminals: config.get('captureTerminals', false), captureStatus: terminalCapture?.status()
  };

}
