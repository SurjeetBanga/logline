import type { ServerSummary, SessionRegistry } from '../capture/session-registry';
import type { FormUpdate } from '../core/connection-form';
import type { ExceptionBlock } from '../core/exceptions';
import type { GenAiCallDetail, GenAiSummary } from '../core/gen-ai';
import type { AnalysisResult } from '../core/log-analysis';
import type { PageOptions, Stats, SuggestedValue } from '../core/log-store';
import type { LogEvent } from '../core/types';
import type { SavedSearch } from '../storage/saved-searches';
import type { AgentShareStatus } from '../core/agent-types';
import type { MetricSeriesView } from '../core/metrics';
import type { TraceSummary, TraceView } from '../core/traces';
import type { ReceiverStatus } from '../capture/otlp-receiver';
import type { RemoteRunInfo } from '../capture/remote-source';
import { RANGE_CHOICES, type ConnectionType } from '../core/connections';
import type { SignatureRow } from '../core/signature-compare';
import type { MetricSeriesData } from '../core/metric-query';

export interface Filter {
  query?: string;
  serverId?: string;
  sessionId?: string;
  levels?: string[];
}
/**
 * The rows a view already holds for the same request, so a refresh can send
 * only the rows that follow them. `version` is the `rowsVersion` they came with.
 */
export interface HeldRows {
  last: number;
  count: number;
  version: string;
}
export type ViewRequest =
  | ({
      type: 'snapshot';
      columns?: string[];
      statsOnly?: boolean;
      requestId?: number;
      doctorRevision?: number;
      have?: HeldRows;
    } & PageOptions)
  | ({ type: 'analysis'; sessionId?: string; from?: number; to?: number } & Filter)
  | ({ type: 'export' | 'exportForAI' } & Filter)
  | ({ type: 'copyFiltered' } & Filter)
  | ({ type: 'saveSearch'; name?: string } & Filter)
  | { type: 'deleteSavedSearch'; id: string }
  | { type: 'autocomplete'; input?: string; serverId?: string }
  | { type: 'context'; id: number }
  | { type: 'details' | 'copy'; id: number; target?: 'main' | 'context' }
  | { type: 'openSource'; id: number; block: number; line: number }
  | { type: 'openLogSite' | 'breakOnEvent'; id: number }
  | { type: 'doctorAction'; action: DoctorAction; siteId?: string }
  | { type: 'connectAgent'; agent?: 'claude' | 'codex' }
  | { type: 'onboardingSeen' }
  | { type: 'showStatus' }
  | ({ type: 'breakOnQuery' } & Filter)
  | { type: 'trace'; traceId: string }
  | { type: 'traces' }
  | { type: 'metrics' }
  | { type: 'aiCalls' }
  | { type: 'aiCall' | 'copyAiCall'; traceId: string; spanId: string }
  | { type: 'toggleOtlp'; enabled: boolean }
  | { type: 'exportContext'; ids: number[] }
  | { type: 'shareWithAgent'; sourceIds?: string[]; sessionIds?: string[]; anchor?: number; chooseRuns?: boolean }
  | { type: 'stopSharing' }
  | { type: 'askCopilot'; anchor?: number }
  | { type: 'shareEvent'; id: number }
  | { type: 'toggleTerminalCapture'; enabled: boolean }
  | { type: 'showGuide'; section?: 'guide' | 'whatsNew' }
  | { type: 'run'; serverId?: string }
  | { type: 'stop'; serverId?: string; sessionId?: string }
  | { type: 'removeSource'; serverId: string }
  | { type: 'removeRun'; sessionId: string }
  | { type: 'removeConnection' | 'editConnection'; connectionId: string }
  /** A message from the Connection form; the connection manager checks `request` itself. */
  | { type: 'connectionForm'; session: number; request: Record<string, unknown> }
  | { type: 'connectionPreview'; connectionId: string; query: string; range: string }
  | {
      type: 'connectionFetch';
      connectionId: string;
      query: string;
      range: string;
      /** An exact window, such as one selected on a metric chart, instead of the range. */
      fromMs?: number;
      toMs?: number;
      /** A query in the store's own syntax, sent as typed, instead of `query`. */
      native?: string;
    }
  | { type: 'metricQuery'; connectionId: string; query: string; range: string }
  | { type: 'metricNames'; connectionId: string; search: string }
  | { type: 'metricWatch'; connectionId: string; query: string; enabled: boolean }
  | { type: 'connectionTail'; connectionId: string; query: string; enabled: boolean; native?: string }
  | { type: 'connectionServices'; connectionId: string; range: string }
  | { type: 'connectionSql' | 'connectionLink'; connectionId: string }
  | { type: 'connectionAgents'; connectionId: string; enabled: boolean }
  | ({ type: 'compare' } & CompareRequest)
  | { type: 'config'; setting?: string }
  | { type: 'import' | 'clear' | 'manageServers' | 'addConnection' };

/** Production (a run fetched from a connection, or an imported file) against a local source's newest runs. */
export interface CompareRequest {
  baselineServerId: string;
  baselineSessionId?: string;
  localServerId: string;
}
/** An event shown beside its counterpart, with the fields whose values differ. */
export interface CompareSample {
  id: number;
  /** The run it was logged in. */
  sessionId?: string;
  timestamp?: string;
  level: string;
  message?: string;
  fields: Record<string, string | number | boolean>;
  differs: string[];
}
export interface CompareView {
  baseline: { serverId: string; sessionId?: string; label: string; events: number };
  local: { serverId: string; label: string };
  /** The local source's newest runs, oldest first; each row has a count per run. */
  runs: { id: string; label: string; startedAt: number }[];
  rows: (SignatureRow & { samples: { baseline?: CompareSample; local?: CompareSample } })[];
  summary: string;
}

/** A saved connection as the Logs panel lists it. */
export interface ConnectionView {
  id: string;
  /** The source its runs are captured under. */
  sourceId: string;
  label: string;
  type: ConnectionType;
  /** Whether searches can run: always for Datadog, once a log table is mapped for a database. */
  mapped: boolean;
  /** Whether it runs queries typed by a person (databases do, Datadog does not). */
  sql: boolean;
  /** What those queries are written in, when not SQL: MongoDB filters and pipelines. */
  language?: 'mongo';
  /** Metric queries watched into the Metrics list. */
  watching: string[];
  /** Whether agents may fetch from it. */
  agents: boolean;
  tailing: boolean;
  /** The latest fetch or tail. */
  last?: RemoteRunInfo;
}

export interface Snapshot extends Stats {
  type: 'snapshot';
  requestId?: number;
  events?: RowEvent[];
  page?: number;
  pages?: number;
  matched?: number;
  /**
   * Set when `events` only holds rows after the view's held rows: keep the
   * newest `keep` held rows, the first of which has id `keepFirst`.
   */
  keep?: number;
  keepFirst?: number;
  /** Identifies how rows were projected and linked; held rows are reusable only with the same version. */
  rowsVersion?: string;
  /** Show the newest row at the top of the table. */
  newestFirst?: boolean;
  columns: string[];
  columnFields: string[];
  fields: string[];
  status: string;
  command: string;
  running: boolean;
  servers: ServerSummary[];
  sessions: ReturnType<SessionRegistry['sessionSummaries']>;
  searches: { saved: SavedSearch[] };
  newest: number;
  generation: number;
  persistDropped: number;
  timezone: string;
  guideStatus: GuideStatus;
  agentSharing: AgentShareStatus;
  captureTerminals: boolean;
  captureStatus?: {
    state: 'off' | 'waiting' | 'capturing' | 'attention';
    detail: string;
    active: number;
    failed: number;
  };
  /** A filter requested from the editor, such as a log statement's CodeLens, applied once. */
  applyQuery?: string;
  /** A trace requested from the editor, opened once. */
  openTrace?: string;
  /** A source to select, such as a connection just added, applied once. */
  applySource?: string;
  /** With applySource, a run of that source to select, such as a search just run. */
  applyRun?: string;
  /** Saved connections to log stores outside the editor. */
  connections?: ConnectionView[];
  /** A comparison to open, such as after a local run finished, applied once. */
  openCompare?: CompareRequest;
  /** A control to point at for the guide's Show me, and one to point at while it is hidden, applied once. */
  reveal?: { target: string; fallback?: string };
  /** Start the guided tour of the panel, applied once. */
  startTour?: boolean;
  /** Open the Connection form as a tab, applied once; its messages carry `session`. */
  openConnectionForm?: { session: number; title: string; connectionId?: string };
  otlp?: ReceiverStatus;
  /** Traces with spans currently retained. */
  traceCount?: number;
  /** OpenTelemetry metric series retained, and a revision that changes with every new data point. */
  metrics?: { series: number; revision: number };
  /** Retained GenAI spans (model calls, tool executions, agent runs), and a revision that changes with spans. */
  aiCalls?: { calls: number; revision: number };
  /**
   * Log doctor findings, worst first, while log doctor is on. `findings` is
   * left out when the view already has this revision.
   */
  doctor?: { revision: number; total: number; findings?: DoctorFindingView[] };
  /** MCP clients such as Claude Code and Codex that read shared logs recently. */
  agentClients?: string[];
  /** Which agents can read shared logs, for the Share panel. */
  agentSetup?: AgentSetupView;
  /** Files changed since the last commit, while the workspace is a git repository. */
  changes?: { files: number };
}
/** Which agents are set up to read shared logs. */
export interface AgentSetupView {
  /** Whether Logline accepts MCP clients such as Claude Code and Codex in this window (logline.externalAgents). */
  external: boolean;
  /** Whether GitHub Copilot Chat is installed. */
  copilot: boolean;
  /** Agents with Logline's skills installed, which Connect set up: `Claude Code`, `Codex`. */
  connected: string[];
}
/**
 * A table row: the event with its displayed fields, plus what the row links
 * to: its trace, whether its log statement is known, and that statement's
 * worst log doctor finding.
 */
export type RowEvent = LogEvent & {
  traceId?: string;
  site?: boolean;
  finding?: { severity: FindingSeverity; message: string };
};
export type FindingSeverity = 'warning' | 'information' | 'hint';
/** A log doctor finding as the Logs panel shows it. */
/**
 * A log doctor finding as the Logs panel shows it: on a log statement (`siteId`,
 * `file`, `line`), or in a source's output that no statement accounts for
 * (`source`, and `eventId` of an example).
 */
export interface DoctorFindingView {
  siteId?: string;
  code: string;
  severity: FindingSeverity;
  message: string;
  file?: string;
  line?: number;
  source?: string;
  eventId?: number;
  /** A trace that shows an OpenTelemetry finding. */
  traceId?: string;
}
/** What the Logs panel can do with a finding; `report` opens the health report. */
export type DoctorAction = 'open' | 'showEvents' | 'fix' | 'report';
/** Links offered with an expanded event, resolved by the host. */
export interface DetailLinks {
  /** The log statement that produced the event, as `path:line`. */
  site?: string;
  traceId?: string;
  /** Log doctor findings on that statement. */
  findings?: DoctorFindingView[];
  /** The crash or stack trace that followed this JSON error, with its own frames. */
  crash?: { id: number; message: string; exceptions: ExceptionBlock[] };
  /** For a crash, the JSON error it followed. */
  attachedTo?: { id: number; message: string };
}
export interface GuideStatus {
  version: string;
  unread: boolean;
}
export type HostMessage =
  | Snapshot
  | { type: 'snapshotError'; requestId?: number; message: string }
  | { type: 'update' | 'serversChanged' }
  | ({ type: 'guideStatus' } & GuideStatus)
  | { type: 'context'; id: number; events: LogEvent[]; server?: string; missing: boolean }
  | ({
      type: 'details';
      id: number;
      text: string;
      target: 'main' | 'context';
      exceptions: ExceptionBlock[];
    } & DetailLinks)
  | { type: 'searches'; searches: { saved: SavedSearch[] }; saved?: SavedSearch }
  | { type: 'autocomplete'; input: string; serverId?: string; fields: string[]; values: SuggestedValue[] }
  | { type: 'analysis'; analysis: AnalysisResult }
  | { type: 'trace'; trace: TraceView }
  | { type: 'traces'; traces: TraceSummary[] }
  | { type: 'aiCalls'; aiCalls: GenAiSummary }
  | { type: 'aiCall'; traceId: string; spanId: string; detail?: GenAiCallDetail }
  | { type: 'metrics'; metrics: MetricSeriesView[] }
  | { type: 'compare'; view?: CompareView; error?: string }
  | {
      type: 'metricQuery';
      connectionId: string;
      query: string;
      range: string;
      result?: { series: MetricSeriesData[]; statement: string; elapsedMs: number; fromMs: number; toMs: number };
      error?: string;
    }
  | { type: 'metricNames'; connectionId: string; search: string; names: string[] }
  | {
      type: 'connectionServices';
      connectionId: string;
      range: string;
      /** The services that logged in the range, most logs first. */
      services: { name: string; count: number }[];
      error?: string;
    }
  | { type: 'connectionForm'; session: number; update: FormUpdate }
  | {
      type: 'connectionPreview';
      connectionId: string;
      query: string;
      range: string;
      /** The SQL the search would run, and the terms Logline would apply to the fetched rows. */
      statement?: string;
      local: string[];
      error?: string;
    };
// Sharing status is also included in snapshots so the webview can render a
// durable indicator after a notification-driven refresh.

function heldRows(value: unknown): HeldRows | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { last, count, version } = value as Record<string, unknown>;
  return Number.isSafeInteger(last) &&
    Number.isSafeInteger(count) &&
    (count as number) > 0 &&
    typeof version === 'string'
    ? { last: last as number, count: count as number, version }
    : undefined;
}

/** Normalize untrusted webview input once, before dispatching any host action. */
export function parseViewRequest(value: unknown): ViewRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const msg = value as Record<string, unknown>;
  const string = (key: string) => (typeof msg[key] === 'string' ? (msg[key] as string) : undefined);
  const strings = (key: string) =>
    Array.isArray(msg[key]) ? (msg[key] as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
  const number = (key: string) =>
    typeof msg[key] === 'number' && Number.isFinite(msg[key]) ? (msg[key] as number) : undefined;
  const index = (key: string) =>
    Number.isSafeInteger(msg[key]) && (msg[key] as number) >= 0 ? (msg[key] as number) : undefined;
  const filter = {
    query: string('query'),
    serverId: string('serverId'),
    levels: strings('levels'),
    ...(string('sessionId') ? { sessionId: string('sessionId') } : {}),
  };
  switch (msg.type) {
    case 'snapshot':
      return {
        type: msg.type,
        ...filter,
        page: index('page'),
        before: number('before'),
        sort: string('sort'),
        sortDirection: msg.sortDirection === 'desc' ? 'desc' : 'asc',
        columns: strings('columns'),
        statsOnly: msg.statsOnly === true,
        requestId: index('requestId'),
        doctorRevision: index('doctorRevision'),
        have: heldRows(msg.have),
      };
    case 'analysis':
      return { type: msg.type, ...filter, from: number('from'), to: number('to') };
    case 'export':
    case 'exportForAI':
    case 'copyFiltered':
      return { type: msg.type, ...filter };
    case 'saveSearch':
      return { type: msg.type, ...filter, name: string('name') };
    case 'deleteSavedSearch': {
      const id = string('id');
      return id === undefined ? undefined : { type: msg.type, id };
    }
    case 'autocomplete':
      return { type: msg.type, input: string('input')?.slice(0, 256), serverId: filter.serverId };
    case 'context':
    case 'details':
    case 'copy': {
      const id = index('id');
      if (id === undefined) return;
      return msg.type === 'context'
        ? { type: msg.type, id }
        : { type: msg.type, id, target: msg.target === 'context' ? 'context' : 'main' };
    }
    case 'openSource': {
      const id = index('id'),
        block = index('block'),
        line = index('line');
      if (id === undefined || block === undefined || line === undefined) return;
      return { type: msg.type, id, block, line };
    }
    case 'openLogSite':
    case 'breakOnEvent': {
      const id = index('id');
      return id === undefined ? undefined : { type: msg.type, id };
    }
    case 'doctorAction': {
      const action = ['open', 'showEvents', 'fix', 'report'].includes(msg.action as string)
        ? (msg.action as DoctorAction)
        : undefined;
      const siteId = string('siteId')?.slice(0, 4096);
      return action && (action === 'report' || siteId)
        ? { type: msg.type, action, ...(siteId ? { siteId } : {}) }
        : undefined;
    }
    case 'breakOnQuery':
      return { type: msg.type, query: filter.query, levels: filter.levels };
    case 'traces':
    case 'metrics':
      return { type: msg.type };
    case 'trace': {
      const traceId = string('traceId');
      return traceId && /^[A-Za-z0-9_-]{1,128}$/.test(traceId) ? { type: msg.type, traceId } : undefined;
    }
    case 'aiCalls':
      return { type: msg.type };
    case 'aiCall':
    case 'copyAiCall': {
      const traceId = string('traceId'),
        spanId = string('spanId');
      const id = /^[A-Za-z0-9_-]{1,128}$/;
      return traceId && spanId && id.test(traceId) && id.test(spanId) ? { type: msg.type, traceId, spanId } : undefined;
    }
    case 'toggleOtlp':
      return { type: msg.type, enabled: msg.enabled === true };
    case 'exportContext':
      return Array.isArray(msg.ids)
        ? { type: msg.type, ids: msg.ids.filter((id): id is number => Number.isSafeInteger(id) && id >= 0) }
        : undefined;
    case 'shareWithAgent':
      return {
        type: msg.type,
        sourceIds: strings('sourceIds'),
        sessionIds: strings('sessionIds'),
        anchor: index('anchor'),
        chooseRuns: msg.chooseRuns === true,
      };
    case 'connectAgent':
      return msg.agent === 'claude' || msg.agent === 'codex'
        ? { type: msg.type, agent: msg.agent }
        : { type: msg.type };
    case 'stopSharing':
    case 'showStatus':
    case 'onboardingSeen':
      return { type: msg.type };
    case 'askCopilot':
      return { type: msg.type, anchor: index('anchor') };
    case 'shareEvent': {
      const id = index('id');
      return id === undefined ? undefined : { type: msg.type, id };
    }
    case 'toggleTerminalCapture':
      return { type: msg.type, enabled: msg.enabled === true };
    case 'showGuide':
      return { type: msg.type, section: msg.section === 'whatsNew' ? 'whatsNew' : 'guide' };
    case 'run':
      return { type: msg.type, serverId: filter.serverId };
    case 'stop':
      return { type: msg.type, serverId: filter.serverId, sessionId: filter.sessionId };
    case 'removeSource':
      return filter.serverId ? { type: msg.type, serverId: filter.serverId } : undefined;
    case 'removeRun':
      return filter.sessionId ? { type: msg.type, sessionId: filter.sessionId } : undefined;
    case 'connectionForm':
      return Number.isSafeInteger(msg.session) &&
        msg.request &&
        typeof msg.request === 'object' &&
        !Array.isArray(msg.request) &&
        typeof (msg.request as { type?: unknown }).type === 'string'
        ? { type: msg.type, session: msg.session as number, request: msg.request as Record<string, unknown> }
        : undefined;
    case 'removeConnection':
    case 'editConnection': {
      const connectionId = string('connectionId')?.slice(0, 128);
      return connectionId ? { type: msg.type, connectionId } : undefined;
    }
    case 'connectionAgents': {
      const connectionId = string('connectionId')?.slice(0, 128);
      return connectionId ? { type: msg.type, connectionId, enabled: msg.enabled === true } : undefined;
    }
    case 'metricQuery':
    case 'metricNames':
    case 'metricWatch': {
      const connectionId = string('connectionId')?.slice(0, 128);
      const query = (string(msg.type === 'metricNames' ? 'search' : 'query') ?? '').slice(0, 2048);
      if (!connectionId) return;
      if (msg.type === 'metricNames') return { type: msg.type, connectionId, search: query.slice(0, 256) };
      if (!query.trim()) return;
      if (msg.type === 'metricWatch') return { type: msg.type, connectionId, query, enabled: msg.enabled === true };
      const range = string('range');
      return { type: msg.type, connectionId, query, range: range && RANGE_CHOICES.includes(range) ? range : '1h' };
    }
    case 'connectionFetch':
    case 'connectionPreview':
    case 'connectionTail':
    case 'connectionSql':
    case 'connectionLink': {
      const connectionId = string('connectionId')?.slice(0, 128);
      if (!connectionId) return;
      if (msg.type === 'connectionSql' || msg.type === 'connectionLink') return { type: msg.type, connectionId };
      const query = (string('query') ?? '').slice(0, 1024);
      const typed = string('native')?.slice(0, 2048);
      const native = typed?.trim() && msg.type !== 'connectionPreview' ? { native: typed } : {};
      if (msg.type === 'connectionTail')
        return { type: msg.type, connectionId, query, enabled: msg.enabled === true, ...native };
      const range = string('range');
      const valid = range && RANGE_CHOICES.includes(range) ? range : '1h';
      const fromMs = number('fromMs');
      const toMs = number('toMs');
      if (msg.type === 'connectionFetch' && fromMs !== undefined && toMs !== undefined && fromMs < toMs)
        return { type: msg.type, connectionId, query, range: valid, fromMs, toMs, ...native };
      return { type: msg.type, connectionId, query, range: valid, ...native };
    }
    case 'connectionServices': {
      const connectionId = string('connectionId')?.slice(0, 128);
      const range = string('range');
      return connectionId
        ? { type: msg.type, connectionId, range: range && RANGE_CHOICES.includes(range) ? range : '1h' }
        : undefined;
    }
    case 'compare': {
      const baselineServerId = string('baselineServerId')?.slice(0, 4096);
      const localServerId = string('localServerId')?.slice(0, 4096);
      const baselineSessionId = string('baselineSessionId')?.slice(0, 128);
      if (!baselineServerId || !localServerId) return;
      return {
        type: msg.type,
        baselineServerId,
        localServerId,
        ...(baselineSessionId ? { baselineSessionId } : {}),
      };
    }
    case 'config': {
      // Only a Logline setting can be opened by name.
      const setting = string('setting');
      return setting && /^logline\.[A-Za-z][\w.]{0,63}$/.test(setting)
        ? { type: msg.type, setting }
        : { type: msg.type };
    }
    case 'import':
    case 'clear':
    case 'manageServers':
    case 'addConnection':
      return { type: msg.type };
  }
}
