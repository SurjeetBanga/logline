import type { Ingestion } from '../capture/ingestion';
import type { RuntimeState } from '../capture/runtime-state';
import type { SessionRegistry } from '../capture/session-registry';
import type { LogStore } from '../core/log-store';
import { getField, parseQuery } from '../core/query';
import type { Settings } from '../core/settings';
import type { LogEvent } from '../core/types';
import type { DoctorFindingView, GuideStatus, RowEvent, Snapshot, ViewRequest } from '../protocol/messages';
import type { LogPersistence } from '../storage/log-persistence';
import type { SavedSearches } from '../storage/saved-searches';
import type { AgentLogAccess } from './agent-access';
import type { ReceiverStatus } from '../capture/otlp-receiver';

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
  otlp?: { status(): ReceiverStatus };
  spans?: { traceCount: number };
  /** What each row links to: its log statement and that statement's worst finding. */
  rowLinks?(event: LogEvent): Pick<RowEvent, 'site' | 'finding'>;
  doctor?: { revision: number; total: number; findings?: DoctorFindingView[] };
  /** MCP clients such as Claude Code that called recently. */
  agentClients?: string[];
  /** Changes whenever `rowLinks` could answer differently for an event already sent. */
  rowLinksVersion?: string;
}

// The newest page only changes at its ends: matches are appended and the
// oldest leave. So rows a view holds up to `have.last` are still the start of
// the new page, unless the page is sorted, a deeper page that slides with new
// events, or a `last:` window that moves with the clock.
function keptRows(msg: Extract<ViewRequest, { type: 'snapshot'; }>, events: LogEvent[], rowsVersion: string): number | undefined {
  const have = msg.have;
  if (!have || have.version !== rowsVersion || msg.sort || (msg.page && msg.before === undefined)) return undefined;
  if (parseQuery((msg.query ?? '').slice(0, 256)).some(group => group.some(token => token.canonical === 'last'))) return undefined;
  let low = 0, high = events.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const id = events[middle].id;
    if (id === have.last) return middle + 1 <= have.count ? middle + 1 : undefined;
    if (id < have.last) low = middle + 1; else high = middle - 1;
  }
  return undefined;
}
export function buildSnapshot(msg: Extract<ViewRequest, { type: 'snapshot'; }>,
  { store, config, registry, state, ingestion, persistence, searches, running, guideStatus, agentAccess, terminalCapture, otlp, spans, rowLinks, doctor, agentClients, rowLinksVersion }: SnapshotSources): Snapshot {
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
  const rowsVersion = JSON.stringify([state.generation, projectedColumns, rowLinksVersion ?? null]);
  const keep = pageResult && keptRows(msg, pageResult.events, rowsVersion);
  const events = pageResult?.events.slice(keep ?? 0).map(event => {
    const traceId = getField(event, 'traceId');
    return { ...event, fields: pickColumns(event, projectedColumns), ...(typeof traceId === 'string' && traceId ? { traceId } : {}), ...rowLinks?.(event) };
  });
  const sessions = registry.sessionSummaries();
  const known = new Set(sessions.map(session => `${session.serverId}\0${session.id}`));
  // Imported files and retained runs whose registry record has been pruned
  // still need to be selectable in the run picker.
  for (const serverId of store.serverIds()) for (const sessionId of store.sessionIds(serverId)) {
    if (sessionId === '*' || known.has(`${serverId}\0${sessionId}`)) continue;
    const label = store.serverLabel(serverId) ?? serverId;
    sessions.push({ id: sessionId, server: label, serverId, status: 'exited', startedAt: 0,
      sourceKind: 'import', owned: false, canStop: false, captureComplete: true, command: label });
  }
  return {
    type: 'snapshot',
    ...result, ...(events ? { events, rowsVersion } : {}),
    ...(keep !== undefined ? { keep, keepFirst: pageResult!.events[0].id } : {}),
    columns,
    columnFields,
    fields: store.fieldNames(),
    status: state.status, command: state.command, running,
    servers: registry.serverSummaries(config.get('servers', []), store), sessions,
    searches: { saved: searches.savedSearches() },
    newest: ingestion.sequence, generation: state.generation,
    persistDropped: persistence.persistDropped,
    timezone: config.get('timezone', 'local'), newestFirst: config.get('newestFirst', true), guideStatus, agentSharing: agentAccess.status(),
    captureTerminals: config.get('captureTerminals', false), captureStatus: terminalCapture?.status(), otlp: otlp?.status(),
    traceCount: spans?.traceCount ?? 0,
    ...(doctor ? { doctor } : {}),
    ...(agentClients?.length ? { agentClients } : {})
  };

}
