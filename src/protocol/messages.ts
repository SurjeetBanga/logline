import type { ServerSummary, SessionRegistry } from '../capture/session-registry';
import type { ExceptionBlock } from '../core/exceptions';
import type { AnalysisResult } from '../core/log-analysis';
import type { PageOptions, Stats, SuggestedValue } from '../core/log-store';
import type { LogEvent } from '../core/types';
import type { SavedSearch } from '../storage/saved-searches';
import type { AgentShareStatus } from '../core/agent-types';
import type { TraceSummary, TraceView } from '../core/traces';
import type { ReceiverStatus } from '../capture/otlp-receiver';

export interface Filter { query?: string; serverId?: string; sessionId?: string; levels?: string[]; }
export type ViewRequest =
  | ({ type: 'snapshot'; columns?: string[]; statsOnly?: boolean; requestId?: number; doctorRevision?: number; } & PageOptions)
  | ({ type: 'analysis'; sessionId?: string; from?: number; to?: number; } & Filter)
  | ({ type: 'export' | 'exportForAI'; } & Filter)
  | ({ type: 'copyFiltered'; } & Filter)
  | ({ type: 'saveSearch'; name?: string; } & Filter)
  | { type: 'deleteSavedSearch'; id: string; }
  | { type: 'autocomplete'; input?: string; serverId?: string; }
  | { type: 'context'; id: number; }
  | { type: 'details' | 'copy'; id: number; target?: 'main' | 'context'; }
  | { type: 'openSource'; id: number; block: number; line: number; }
  | { type: 'openLogSite' | 'breakOnEvent'; id: number; }
  | { type: 'doctorAction'; action: DoctorAction; siteId?: string; }
  | ({ type: 'breakOnQuery'; } & Filter)
  | { type: 'trace'; traceId: string; }
  | { type: 'traces'; }
  | { type: 'toggleOtlp'; enabled: boolean; }
  | { type: 'exportContext'; ids: number[]; }
  | { type: 'shareWithAgent'; sourceIds?: string[]; sessionIds?: string[]; anchor?: number; chooseRuns?: boolean; }
  | { type: 'stopSharing'; }
  | { type: 'askCopilot'; anchor?: number; }
  | { type: 'shareEvent'; id: number; }
  | { type: 'toggleTerminalCapture'; enabled: boolean; }
  | { type: 'showGuide'; section?: 'guide' | 'whatsNew'; }
  | { type: 'run'; serverId?: string; }
  | { type: 'stop'; serverId?: string; sessionId?: string; }
  | { type: 'import' | 'clear' | 'config' | 'manageServers'; };

export interface Snapshot extends Stats {
  type: 'snapshot'; requestId?: number; events?: RowEvent[]; page?: number; pages?: number; matched?: number;
  columns: string[]; columnFields: string[]; fields: string[];
  status: string; command: string; running: boolean;
  servers: ServerSummary[]; sessions: ReturnType<SessionRegistry['sessionSummaries']>;
  searches: { saved: SavedSearch[]; }; newest: number; generation: number;
  persistDropped: number; timezone: string;
  guideStatus: GuideStatus;
  agentSharing: AgentShareStatus;
  captureTerminals: boolean;
  captureStatus?: { state: 'off' | 'waiting' | 'capturing' | 'attention'; detail: string; active: number; failed: number };
  /** A filter requested from the editor, such as a log statement's CodeLens, applied once. */
  applyQuery?: string;
  /** A trace requested from the editor, opened once. */
  openTrace?: string;
  otlp?: ReceiverStatus;
  /** Traces with spans currently retained. */
  traceCount?: number;
  /**
   * Log doctor findings, worst first, while log doctor is on. `findings` is
   * left out when the view already has this revision.
   */
  doctor?: { revision: number; total: number; findings?: DoctorFindingView[]; };
}
/**
 * A table row: the event with its displayed fields, plus what the row links
 * to: its trace, whether its log statement is known, and that statement's
 * worst log doctor finding.
 */
export type RowEvent = LogEvent & { traceId?: string; site?: boolean; finding?: { severity: FindingSeverity; message: string; }; };
export type FindingSeverity = 'warning' | 'information' | 'hint';
/** A log doctor finding as the Logs panel shows it. */
export interface DoctorFindingView { siteId: string; code: string; severity: FindingSeverity; message: string; file: string; line: number; }
/** What the Logs panel can do with a finding; `report` opens the health report. */
export type DoctorAction = 'open' | 'showEvents' | 'fix' | 'report';
/** Links offered with an expanded event, resolved by the host. */
export interface DetailLinks {
  /** The log statement that produced the event, as `path:line`. */
  site?: string;
  traceId?: string;
  /** Log doctor findings on that statement. */
  findings?: DoctorFindingView[];
}
export interface GuideStatus { version: string; unread: boolean; }
export type HostMessage = Snapshot
  | { type: 'snapshotError'; requestId?: number; message: string; }
  | { type: 'update' | 'serversChanged'; }
  | ({ type: 'guideStatus' } & GuideStatus)
  | { type: 'context'; id: number; events: LogEvent[]; server?: string; missing: boolean; }
  | ({ type: 'details'; id: number; text: string; target: 'main' | 'context'; exceptions: ExceptionBlock[]; } & DetailLinks)
  | { type: 'searches'; searches: { saved: SavedSearch[]; }; saved?: SavedSearch; }
  | { type: 'autocomplete'; input: string; serverId?: string; fields: string[]; values: SuggestedValue[]; }
  | { type: 'analysis'; analysis: AnalysisResult; }
  | { type: 'trace'; trace: TraceView; }
  | { type: 'traces'; traces: TraceSummary[]; };
  // Sharing status is also included in snapshots so the webview can render a
  // durable indicator after a notification-driven refresh.

/** Normalize untrusted webview input once, before dispatching any host action. */
export function parseViewRequest(value: unknown): ViewRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const msg = value as Record<string, unknown>;
  const string = (key: string) => typeof msg[key] === 'string' ? msg[key] as string : undefined;
  const strings = (key: string) => Array.isArray(msg[key]) ? (msg[key] as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
  const number = (key: string) => typeof msg[key] === 'number' && Number.isFinite(msg[key]) ? msg[key] as number : undefined;
  const index = (key: string) => Number.isSafeInteger(msg[key]) && (msg[key] as number) >= 0 ? msg[key] as number : undefined;
  const filter = { query: string('query'), serverId: string('serverId'), levels: strings('levels'), ...(string('sessionId') ? { sessionId: string('sessionId') } : {}) };
  switch (msg.type) {
    case 'snapshot': return {
      type: msg.type, ...filter, page: index('page'), before: number('before'),
      sort: string('sort'), sortDirection: msg.sortDirection === 'desc' ? 'desc' : 'asc', columns: strings('columns'), statsOnly: msg.statsOnly === true,
      requestId: index('requestId'), doctorRevision: index('doctorRevision')
    };
    case 'analysis': return { type: msg.type, ...filter, from: number('from'), to: number('to') };
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
    case 'openLogSite': case 'breakOnEvent': { const id = index('id'); return id === undefined ? undefined : { type: msg.type, id }; }
    case 'doctorAction': {
      const action = ['open', 'showEvents', 'fix', 'report'].includes(msg.action as string) ? msg.action as DoctorAction : undefined;
      const siteId = string('siteId')?.slice(0, 4096);
      return action && (action === 'report' || siteId) ? { type: msg.type, action, ...(siteId ? { siteId } : {}) } : undefined;
    }
    case 'breakOnQuery': return { type: msg.type, query: filter.query, levels: filter.levels };
    case 'traces': return { type: msg.type };
    case 'trace': {
      const traceId = string('traceId');
      return traceId && /^[A-Za-z0-9_-]{1,128}$/.test(traceId) ? { type: msg.type, traceId } : undefined;
    }
    case 'toggleOtlp': return { type: msg.type, enabled: msg.enabled === true };
    case 'exportContext': return Array.isArray(msg.ids) ? { type: msg.type, ids: msg.ids.filter((id): id is number => Number.isSafeInteger(id) && id >= 0) } : undefined;
    case 'shareWithAgent': return { type: msg.type, sourceIds: strings('sourceIds'), sessionIds: strings('sessionIds'), anchor: index('anchor'), chooseRuns: msg.chooseRuns === true };
    case 'stopSharing': return { type: msg.type };
    case 'askCopilot': return { type: msg.type, anchor: index('anchor') };
    case 'shareEvent': { const id = index('id'); return id === undefined ? undefined : { type: msg.type, id }; }
    case 'toggleTerminalCapture': return { type: msg.type, enabled: msg.enabled === true };
    case 'showGuide': return { type: msg.type, section: msg.section === 'whatsNew' ? 'whatsNew' : 'guide' };
    case 'run': return { type: msg.type, serverId: filter.serverId };
    case 'stop': return { type: msg.type, serverId: filter.serverId, sessionId: filter.sessionId };
    case 'import': case 'clear': case 'config': case 'manageServers': return { type: msg.type };
  }
}
