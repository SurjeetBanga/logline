import type { ServerSummary, SessionRegistry } from '../capture/session-registry';
import type { ExceptionBlock } from '../core/exceptions';
import type { AnalysisResult } from '../core/log-analysis';
import type { PageOptions, Stats, SuggestedValue } from '../core/log-store';
import type { LogEvent } from '../core/types';
import type { SavedSearch } from '../storage/saved-searches';

export interface Filter { query?: string; serverId?: string; levels?: string[]; }
export type ViewRequest =
  | ({ type: 'snapshot'; columns?: string[]; statsOnly?: boolean; } & PageOptions)
  | ({ type: 'analysis'; sessionId?: string; from?: number; to?: number; } & Filter)
  | ({ type: 'export' | 'exportForAI'; } & Filter)
  | ({ type: 'copyFiltered'; } & Filter)
  | ({ type: 'saveSearch'; name?: string; } & Filter)
  | { type: 'deleteSavedSearch'; id: string; }
  | { type: 'autocomplete'; input?: string; serverId?: string; }
  | { type: 'context'; id: number; }
  | { type: 'details' | 'copy'; id: number; target?: 'main' | 'context'; }
  | { type: 'openSource'; id: number; block: number; line: number; }
  | { type: 'exportContext'; ids: number[]; }
  | { type: 'run' | 'stop'; serverId?: string; }
  | { type: 'import' | 'clear' | 'config' | 'manageServers'; };

export interface Snapshot extends Stats {
  type: 'snapshot'; events?: LogEvent[]; page?: number; pages?: number; matched?: number;
  columns: string[]; columnFields: string[]; fields: string[];
  status: string; command: string; running: boolean;
  servers: ServerSummary[]; sessions: ReturnType<SessionRegistry['sessionSummaries']>;
  searches: { saved: SavedSearch[]; }; newest: number; generation: number;
  persistDropped: number; timezone: string;
}
export type HostMessage = Snapshot
  | { type: 'update' | 'serversChanged'; }
  | { type: 'context'; id: number; events: LogEvent[]; server?: string; missing: boolean; }
  | { type: 'details'; id: number; text: string; target: 'main' | 'context'; exceptions: ExceptionBlock[]; }
  | { type: 'searches'; searches: { saved: SavedSearch[]; }; saved?: SavedSearch; }
  | { type: 'autocomplete'; input: string; serverId?: string; fields: string[]; values: SuggestedValue[]; }
  | { type: 'analysis'; analysis: AnalysisResult; };

/** Normalize untrusted webview input once, before dispatching any host action. */
export function parseViewRequest(value: unknown): ViewRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const msg = value as Record<string, unknown>;
  const string = (key: string) => typeof msg[key] === 'string' ? msg[key] as string : undefined;
  const strings = (key: string) => Array.isArray(msg[key]) ? (msg[key] as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
  const number = (key: string) => typeof msg[key] === 'number' && Number.isFinite(msg[key]) ? msg[key] as number : undefined;
  const index = (key: string) => Number.isSafeInteger(msg[key]) && (msg[key] as number) >= 0 ? msg[key] as number : undefined;
  const filter = { query: string('query'), serverId: string('serverId'), levels: strings('levels') };
  switch (msg.type) {
    case 'snapshot': return {
      type: msg.type, ...filter, page: index('page'), before: number('before'),
      sort: string('sort'), sortDirection: msg.sortDirection === 'desc' ? 'desc' : 'asc', columns: strings('columns'), statsOnly: msg.statsOnly === true
    };
    case 'analysis': return { type: msg.type, ...filter, sessionId: string('sessionId'), from: number('from'), to: number('to') };
    case 'export': case 'exportForAI': case 'copyFiltered': return { type: msg.type, ...filter };
    case 'saveSearch': return { type: msg.type, ...filter, name: string('name') };
    case 'deleteSavedSearch': { const id = string('id'); return id === undefined ? undefined : { type: msg.type, id }; }
    case 'autocomplete': return { type: msg.type, input: string('input')?.slice(0, 256), serverId: filter.serverId };
    case 'context': case 'details': case 'copy': {
      const id = index('id'); if (id === undefined) return;
      return msg.type === 'context' ? { type: msg.type, id } : { type: msg.type, id, target: msg.target === 'context' ? 'context' : 'main' };
    }
    case 'openSource': {
      const id = index('id'), block = index('block'), line = index('line');
      if (id === undefined || block === undefined || line === undefined) return;
      return { type: msg.type, id, block, line };
    }
    case 'exportContext': return Array.isArray(msg.ids) ? { type: msg.type, ids: msg.ids.filter((id): id is number => Number.isSafeInteger(id) && id >= 0) } : undefined;
    case 'run': case 'stop': return { type: msg.type, serverId: filter.serverId };
    case 'import': case 'clear': case 'config': case 'manageServers': return { type: msg.type };
  }
}
