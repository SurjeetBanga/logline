import { createHash, randomBytes } from 'node:crypto';
import { extractExceptions } from '../core/exceptions';
import { formatDetails } from '../core/format-details';
import { analyzeEvents, groupErrors, patternText } from '../core/log-analysis';
import { withChangedScope } from '../core/changed-query';
import { createRedactor, type RedactionOptions, type Redactor } from '../core/redaction';
import type { LogStore, PageOptions } from '../core/log-store';
import type { AgentConnection, AgentRunStatus, AgentShareStatus } from '../core/agent-types';
import type { CompareRequest, CompareView } from '../protocol/messages';
import type { SessionRegistry } from '../capture/session-registry';
import type { LogEvent, SessionSummary } from '../core/types';
import type { Span } from '../core/otlp';
import { buildTrace, traceLogs, type SpanStore, type TraceView } from '../core/traces';
import { genAiCallDetail, summarizeGenAi, type GenAiCall, type GenAiMessage, type GenAiToolRun } from '../core/gen-ai';

// Leaves room under the 64 KiB tool result limit (agent-tools.ts) for the envelope.
const INSPECT_BUDGET_BYTES = 56 * 1024;
// Concurrent wait_for_logs calls, for example from Copilot and Claude Code.
const MAX_WAITS = 4;
// AI call content is long; an agent gets the start of each part, and asks for one trace to see more calls.
const AI_PART_CHARACTERS = 2048;
const AI_CONTENT_CALLS = 20;

export interface AgentAiCallsInput {
  shareId: string;
  traceId?: string;
  model?: string;
  limit?: number;
  includeContent?: boolean;
}

export type AgentErrorCode =
  | 'NOT_SHARED'
  | 'SHARE_CHANGED'
  | 'INVALID_INPUT'
  | 'EVENT_UNAVAILABLE'
  | 'CANCELLED'
  | 'BUSY'
  | 'CONNECTION_UNAVAILABLE'
  | 'RANGE_TOO_LARGE'
  | 'REMOTE_ERROR';

/** Production fetches an agent may make, for each connection, per minute. */
const PRODUCTION_FETCHES_PER_MINUTE = 10;
/** The ranges an agent may fetch: up to a day. */
const PRODUCTION_RANGES = ['15m', '1h', '4h', '24h'];

export interface ProductionFetchInput {
  shareId: string;
  connectionId: string;
  query?: string;
  traceId?: string;
  range?: string;
  limit?: number;
}

/** What a production fetch did, as the connection layer reports it. */
export interface ProductionFetchResult {
  sessionId?: string;
  sourceId: string;
  label: string;
  fetched: number;
  kept: number;
  total?: number;
  local: string[];
  statement?: string;
  error?: string;
}

/** Saved connections, for agents: which they may query, and the queries themselves. Attached by the controller. */
export interface ProductionAccess {
  connections(): AgentConnection[];
  fetch(input: {
    connectionId: string;
    query: string;
    traceId?: string;
    range: string;
    limit: number;
  }): Promise<ProductionFetchResult>;
  /** Compare with the newest local runs that `allowed` admits. */
  compare(request: CompareRequest, allowed?: (runId: string) => boolean): CompareView;
}
export class AgentAccessError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentAccessError';
  }
}

export type { AgentRunStatus, AgentShareStatus } from '../core/agent-types';

export interface AgentSearchInput extends PageOptions {
  shareId: string;
  sourceIds?: string[];
  sessionIds?: string[];
  limit?: number;
  cursor?: string;
  /** Only events from code changed since the last commit: adds `changed:true` to every alternative of the query. */
  changedOnly?: boolean;
}
export interface AgentSearchResult {
  events: LogEvent[];
  matched: number;
  nextCursor?: string;
  newest: number;
  partial: boolean;
  hasMore: boolean;
  retention?: { oldest?: number; newest: number };
  /** With `changedOnly`: files changed since the last commit, or null when the workspace is not a git repository. */
  changedFiles?: number | null;
}

interface DecodedCursor {
  before?: number;
  lastId?: number;
}
interface MergedRead {
  events: LogEvent[];
  matched: number;
  hasMore: boolean;
}

/** In-memory sharing boundary between the log store and agent tools. */
export class AgentLogAccess {
  private shareId?: string;
  private revision = 0;
  private shared = new Map<string, Set<string>>();
  private shareAllRuns = false;
  private anchor?: number;
  private readonly redaction: RedactionOptions;
  private redactor: Redactor;
  private readonly activeWaits = new Set<symbol>();
  /** Files changed since the last commit, or undefined outside a git repository. */
  changes?: () => { files: number } | undefined;
  /** Saved connections agents can fetch production logs from, when the user allowed them. */
  production?: ProductionAccess;
  /** When each connection was fetched from by agents in the last minute. */
  private readonly productionFetches = new Map<string, number[]>();
  constructor(
    private readonly store: LogStore,
    private readonly registry: SessionRegistry,
    private readonly nextId: () => number = () => 0,
    redaction: RedactionOptions = {},
    private readonly spans?: SpanStore,
  ) {
    this.redaction = { enabled: true, replacement: '[REDACTED]', ...redaction };
    this.redaction.enabled = true;
    this.redactor = createRedactor(this.redaction);
  }
  updateRedaction(options: RedactionOptions): void {
    Object.assign(this.redaction, options, { enabled: true });
    this.redactor = createRedactor(this.redaction);
  }

  /** The current grant's id, or undefined while nothing is shared. */
  get grant(): string | undefined {
    return this.shareId;
  }

  status(): AgentShareStatus {
    this.refreshAllRuns();
    const recordsBySource = new Map<string, SessionSummary[]>();
    for (const record of this.registry.records.values()) {
      const records = recordsBySource.get(record.serverId) ?? [];
      records.push(record);
      recordsBySource.set(record.serverId, records);
    }
    const sources = [...this.shared.entries()].map(([id, sessions]) => {
      const records = (recordsBySource.get(id) ?? []).filter((record) => sessions.has(record.id));
      const label = records.at(-1)?.server ?? this.store.serverLabel(id) ?? id;
      const runs = [...sessions]
        .filter((sessionId) => sessionId !== '*')
        .map((sessionId) => {
          const record = this.registry.records.get(sessionId);
          return {
            id: sessionId,
            sourceId: id,
            label: this.redactor.text(record?.command || record?.server || sessionId),
            status: record?.status ?? 'exited',
            startedAt: record?.startedAt,
            endedAt: record?.endedAt,
            events: this.store.sessionEventCount(id, sessionId),
            ...(record?.dependencies
              ? { dependencies: record.dependencies.map((value) => this.redactor.text(value)) }
              : {}),
            captureStatus: record?.captureStatus,
            captureReason: record?.captureReason === undefined ? undefined : this.redactor.text(record.captureReason),
          };
        });
      return {
        id,
        label: this.redactor.text(label),
        sessions: runs.length,
        events: runs.reduce((sum, run) => sum + run.events, 0),
        runs,
      };
    });
    return {
      active: Boolean(this.shareId),
      shareId: this.shareId,
      revision: this.revision,
      scope: this.shareAllRuns ? 'all' : 'selected',
      sources,
    };
  }

  availableSources(): { id: string; label: string; events: number }[] {
    const ids = new Set([
      ...this.store.serverIds(),
      ...[...this.registry.records.values()].map((record) => record.serverId),
    ]);
    const labels = new Map<string, string>();
    for (const record of this.registry.records.values())
      if (!labels.has(record.serverId)) labels.set(record.serverId, record.server);
    return [...ids].map((id) => ({
      id,
      label: this.redactor.text(this.store.serverLabel(id) ?? labels.get(id) ?? id),
      events: this.store.serverEventCount(id),
    }));
  }

  availableRuns(): AgentRunStatus[] {
    const runs: AgentRunStatus[] = [];
    const seen = new Set<string>();
    for (const record of this.registry.records.values()) {
      seen.add(`${record.serverId}\0${record.id}`);
      runs.push({
        id: record.id,
        sourceId: record.serverId,
        label: this.redactor.text(record.command || record.server || record.id),
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        events: this.store.sessionEventCount(record.serverId, record.id),
        ...(record.dependencies ? { dependencies: record.dependencies.map((value) => this.redactor.text(value)) } : {}),
        captureStatus: record.captureStatus,
        captureReason: record.captureReason === undefined ? undefined : this.redactor.text(record.captureReason),
      });
    }
    for (const sourceId of this.store.serverIds())
      for (const sessionId of this.store.sessionIds(sourceId)) {
        if (sessionId === '*' || seen.has(`${sourceId}\0${sessionId}`)) continue;
        runs.push({
          id: sessionId,
          sourceId,
          label: this.redactor.text(this.store.serverLabel(sourceId) ?? sessionId),
          status: 'exited',
          events: this.store.sessionEventCount(sourceId, sessionId),
        });
      }
    return runs;
  }

  share(sourceIds: string[], anchor?: number, sessionIds?: string[]): AgentShareStatus {
    const ids = [...new Set(sourceIds.filter((id) => typeof id === 'string' && id.trim()))];
    if (!ids.length) throw new AgentAccessError('INVALID_INPUT', 'Choose at least one log source to share.');
    const available = new Set(this.availableSources().map((source) => source.id));
    if (ids.some((id) => !available.has(id)))
      throw new AgentAccessError('INVALID_INPUT', 'One or more selected log sources are no longer available.');
    if (anchor !== undefined) {
      const event = this.store.find(anchor);
      if (!event || !event.serverId || !ids.includes(event.serverId))
        throw new AgentAccessError('INVALID_INPUT', 'The anchor event is not in a selected source.');
    }
    const selected = new Map<string, Set<string>>();
    for (const sourceId of ids) {
      const available = new Set<string>();
      for (const record of this.registry.records.values()) if (record.serverId === sourceId) available.add(record.id);
      for (const sessionId of this.store.sessionIds(sourceId)) available.add(sessionId);
      const wanted = sessionIds?.length ? sessionIds.filter((id) => available.has(id)) : [...available];
      if (!wanted.length)
        throw new AgentAccessError('INVALID_INPUT', `No retained run is available for source ${sourceId}.`);
      selected.set(sourceId, new Set(wanted));
    }
    if (anchor !== undefined) {
      const event = this.store.find(anchor);
      const set = selected.get(event!.serverId!);
      if (set && !set.has(event!.sessionId ?? '*'))
        throw new AgentAccessError('INVALID_INPUT', 'The anchor event is not in a selected run.');
    }
    this.shareAllRuns = false;
    this.shared = selected;
    this.shareId = randomBytes(8).toString('hex');
    this.revision++;
    this.anchor = anchor;
    return this.status();
  }

  shareAll(): AgentShareStatus {
    this.shareAllRuns = true;
    this.shareId = randomBytes(8).toString('hex');
    this.anchor = undefined;
    this.revision++;
    return this.status();
  }

  private refreshAllRuns(): void {
    if (!this.shareAllRuns || !this.shareId) return;
    const selected = new Map<string, Set<string>>();
    for (const sourceId of this.store.serverIds()) selected.set(sourceId, new Set(this.store.sessionIds(sourceId)));
    for (const record of this.registry.records.values()) {
      if (!selected.has(record.serverId)) selected.set(record.serverId, new Set());
      selected.get(record.serverId)!.add(record.id);
    }
    this.shared = selected;
  }

  /** A removed source leaves a selected share; sharing ends when nothing selected is left. */
  forgetSource(sourceId: string): void {
    if (this.shareAllRuns || !this.shareId) return;
    let changed = false;
    for (const id of [...this.shared.keys()])
      if (id === sourceId || id.startsWith(`${sourceId}::`)) changed = this.shared.delete(id) || changed;
    if (!changed) return;
    if (!this.shared.size) this.revoke();
    else this.revision++;
  }

  revoke(): void {
    this.shareAllRuns = false;
    this.shared.clear();
    this.shareId = undefined;
    this.anchor = undefined;
    this.revision++;
    this.activeWaits.clear();
  }
  isSharedSource(id: string | undefined): boolean {
    this.refreshAllRuns();
    return Boolean(id && this.shared.has(id));
  }
  getAnchor(): number | undefined {
    return this.anchor;
  }

  list(input?: { shareId?: string }): AgentShareStatus {
    this.assertShare(input?.shareId);
    const connections = this.production?.connections();
    return { ...this.status(), ...(connections?.length ? { connections } : {}) };
  }

  /** Add a run made for an agent to a share of selected runs, so the agent can read it. */
  private addRun(sourceId: string, sessionId: string): void {
    if (this.shareAllRuns) return;
    const sessions = this.shared.get(sourceId) ?? new Set<string>();
    sessions.add(sessionId);
    this.shared.set(sourceId, sessions);
  }

  /**
   * Fetch production logs from a connection the user allowed, into a run of
   * its own, and summarize them: the agent reads them with the other tools.
   */
  async fetchProduction(input: ProductionFetchInput): Promise<unknown> {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'shareId is required.');
    this.assertShare(input.shareId);
    if (typeof input.connectionId !== 'string' || !input.connectionId)
      throw new AgentAccessError(
        'INVALID_INPUT',
        'connectionId is required; list connections with logline_list_shared_sources.',
      );
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256))
      throw new AgentAccessError('INVALID_INPUT', 'query must be at most 256 characters.');
    if (
      input.traceId !== undefined &&
      (typeof input.traceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.traceId))
    )
      throw new AgentAccessError('INVALID_INPUT', 'traceId must be letters, digits, - or _.');
    const range = input.range ?? '1h';
    if (typeof range !== 'string' || !PRODUCTION_RANGES.includes(range))
      throw new AgentAccessError('RANGE_TOO_LARGE', `range must be one of ${PRODUCTION_RANGES.join(', ')}.`);
    const limit = Math.max(1, Math.min(1000, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 500));
    const connection = this.production?.connections().find((candidate) => candidate.id === input.connectionId);
    if (!connection)
      throw new AgentAccessError('CONNECTION_UNAVAILABLE', `There is no connection ${input.connectionId}.`);
    if (!connection.agents)
      throw new AgentAccessError(
        'CONNECTION_UNAVAILABLE',
        `The user has not allowed agents to query ${connection.label}. Ask them to choose Allow agents on it in the Logline Logs panel.`,
      );
    const now = Date.now();
    const recent = (this.productionFetches.get(connection.id) ?? []).filter((time) => time > now - 60000);
    if (recent.length >= PRODUCTION_FETCHES_PER_MINUTE)
      throw new AgentAccessError(
        'BUSY',
        `At most ${PRODUCTION_FETCHES_PER_MINUTE} fetches a minute from ${connection.label}; search the runs already fetched with logline_search_logs.`,
      );
    this.productionFetches.set(connection.id, [...recent, now]);
    const result = await this.production!.fetch({
      connectionId: connection.id,
      query: input.query ?? '',
      ...(input.traceId ? { traceId: input.traceId } : {}),
      range,
      limit,
    });
    if (result.error || !result.sessionId)
      throw new AgentAccessError(
        'REMOTE_ERROR',
        `${connection.label}: ${this.redactor.text(result.error ?? 'the fetch failed')}`,
      );
    // A share can have changed while the fetch ran; only a current one gets the run.
    if (this.shareId === input.shareId) this.addRun(result.sourceId, result.sessionId);
    const events = this.store.reversePage({ serverId: result.sourceId, sessionId: result.sessionId }, 5000).events;
    return {
      runId: result.sessionId,
      sourceId: result.sourceId,
      connection: result.label,
      fetched: result.fetched,
      kept: result.kept,
      ...(result.total !== undefined ? { totalInRange: result.total } : {}),
      ...(result.local.length ? { filteredLocally: result.local } : {}),
      ...(result.statement ? { sentAs: this.redactor.text(result.statement) } : {}),
      errorGroups: groupErrors(events)
        .slice(0, 10)
        .map((group) => ({
          pattern: this.redactor.text(patternText(group.message)),
          count: group.count,
          sampleIds: group.sampleIds.slice(0, 3),
          ...(group.location ? { location: group.location } : {}),
        })),
      next: 'Read these with logline_search_logs or logline_analyze_logs (sessionIds: [runId]) and logline_inspect_event; after a local run, call logline_compare_with_production.',
    };
  }

  /** Compare a production run's errors with a shared local source's newest runs. */
  compareWithProduction(input: { shareId: string; prodRunId: string; localSourceId?: string }): unknown {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'shareId is required.');
    this.assertShare(input.shareId);
    if (!this.production) throw new AgentAccessError('CONNECTION_UNAVAILABLE', 'Comparing is not available.');
    if (typeof input.prodRunId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'prodRunId is required.');
    const sources = [...this.shared.entries()];
    const baseline = sources.find(([, sessions]) => sessions.has(input.prodRunId))?.[0];
    if (!baseline)
      throw new AgentAccessError(
        'INVALID_INPUT',
        'prodRunId is not a shared run; use the runId logline_fetch_production returned.',
      );
    // By default, the shared local source that ran most recently.
    const latest = (sourceId: string) =>
      Math.max(
        0,
        ...[...this.registry.records.values()]
          .filter((record) => record.serverId === sourceId)
          .map((record) => record.startedAt),
      );
    const local =
      input.localSourceId ??
      sources
        .map(([id]) => id)
        .filter((id) => id !== baseline && !id.startsWith('conn:'))
        .sort((a, b) => latest(b) - latest(a))[0];
    if (!local || !this.shared.has(local))
      throw new AgentAccessError(
        'INVALID_INPUT',
        'localSourceId must be a shared local source, such as the app or tests just run.',
      );
    // Only the local runs the user shared, unless every run is.
    const runs = this.shared.get(local)!;
    const view = this.production.compare(
      { baselineServerId: baseline, baselineSessionId: input.prodRunId, localServerId: local },
      this.shareAllRuns ? undefined : (runId) => runs.has(runId),
    );
    return {
      production: {
        runId: input.prodRunId,
        label: this.redactor.text(view.baseline.label),
        events: view.baseline.events,
      },
      local: { sourceId: local, label: this.redactor.text(view.local.label), runs: view.runs.map((run) => run.id) },
      summary: view.summary,
      errors: view.rows.map((row) => ({
        status: row.status,
        pattern: this.redactor.text(row.pattern),
        production: row.baseline,
        runs: row.runs,
        ...(row.changed ? { fromChangedCode: true } : {}),
        ...(row.location ? { location: row.location } : {}),
        ...(row.baselineSample !== undefined ? { productionSampleId: row.baselineSample } : {}),
        ...(row.localSample !== undefined ? { localSampleId: row.localSample } : {}),
      })),
    };
  }

  search(input: AgentSearchInput): AgentSearchResult {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'A search input with a string shareId is required.');
    this.assertShare(input.shareId);
    input = this.validate(input);
    const sources = this.sources(input.sourceIds);
    const sessions = this.sessions(input.sessionIds);
    const limit = Math.max(1, Math.min(200, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 100));
    const cursorKey = createHash('sha256')
      .update(
        JSON.stringify({
          query: input.query ?? '',
          levels: input.levels ? [...input.levels].sort() : undefined,
          sourceIds: input.sourceIds
            ? [...input.sourceIds].sort()
            : this.shareAllRuns
              ? 'all'
              : [...this.shared.keys()].sort(),
          sessionId: input.sessionId,
          sessionIds: input.sessionIds ? [...input.sessionIds].sort() : undefined,
          from: input.from,
          to: input.to,
        }),
      )
      .digest('base64url');
    const cursorState = this.decodeCursor(input.cursor, cursorKey);
    const snapshotBefore = cursorState.before ?? (Number.isFinite(input.before) ? input.before! : this.nextId());
    const before = cursorState.lastId ?? snapshotBefore;
    const newest = this.nextId();
    const read = this.readMerged(input, sources, sessions, before, snapshotBefore, limit);
    const selected: LogEvent[] = [];
    // Leave room for the envelope and opaque continuation cursor so the tool
    // adapter never has to drop an already-selected event after pagination.
    const maxResultBytes = 48 * 1024;
    const baseBytes = Buffer.byteLength(
      JSON.stringify({ events: [], matched: read.matched, newest, partial: true, hasMore: true }),
      'utf8',
    );
    let bytes = baseBytes;
    for (const event of read.events) {
      let safe = this.redactor.event(event);
      let encoded = JSON.stringify(safe);
      if (bytes + Buffer.byteLength(encoded, 'utf8') + 2 > maxResultBytes) {
        if (!selected.length) {
          safe = { id: safe.id, level: safe.level, message: '[TRUNCATED]', truncated: true };
          encoded = JSON.stringify(safe);
        } else break;
      }
      selected.push(safe);
      bytes += Buffer.byteLength(encoded, 'utf8') + 1;
    }
    const byteLimited = selected.length < read.events.length;
    const hasMore = read.hasMore || byteLimited;
    const continuationBefore = selected.length ? selected[selected.length - 1].id - 1 : before;
    return {
      events: selected,
      matched: read.matched,
      newest,
      partial: hasMore,
      hasMore,
      retention: { oldest: selected.length ? selected[selected.length - 1].id : undefined, newest },
      nextCursor: hasMore ? this.encodeCursor(snapshotBefore, continuationBefore, cursorKey) : undefined,
      ...this.changedFiles(input),
    };
  }

  // Each source contributes one bounded page at a time. Pages are merged by
  // event id, so a multi-source search stays newest-first without materializing
  // every matching event in the retained store.
  private readMerged(
    input: AgentSearchInput,
    sources: string[],
    sessions: Map<string, Set<string>> | undefined,
    before: number,
    snapshotBefore: number,
    limit: number,
  ): MergedRead {
    const pages = new Map<string, { events: LogEvent[]; offset: number; hasMore: boolean }>();
    const load = (sourceId: string, boundary: number) => {
      const sourceSessions = sessions?.get(sourceId) ?? this.shared.get(sourceId)!;
      const wantedSessions = input.sessionId
        ? new Set([...sourceSessions].filter((id) => id === input.sessionId))
        : sourceSessions;
      const result = this.store.reversePage(
        {
          query: input.query,
          levels: input.levels,
          serverId: sourceId,
          before: boundary,
          sessionIds: [...wantedSessions],
          from: input.from,
          to: input.to,
        },
        Math.min(1000, limit),
      );
      pages.set(sourceId, { events: result.events, offset: 0, hasMore: result.hasMore });
      return result.matched;
    };
    let matched = 0;
    for (const sourceId of sources) {
      // The count is always taken at the fixed snapshot boundary. On a cursor
      // continuation this may be one extra indexed page read, but keeps the
      // coverage count exact if older rows were evicted between calls.
      matched += load(sourceId, snapshotBefore);
      // A continuation replaces that source's newest page with the page below
      // the last delivered event. Do not add its bounded page count again: the
      // reported match count describes the original snapshot, not this read.
      if (before !== snapshotBefore) load(sourceId, before);
    }
    const seen = new Set<number>();
    const selectedEvents: LogEvent[] = [];
    while (
      selectedEvents.length < limit &&
      pages.size &&
      [...pages.values()].some((page) => page.offset < page.events.length)
    ) {
      let sourceId: string | undefined;
      let selected: LogEvent | undefined;
      for (const candidate of sources) {
        const page = pages.get(candidate);
        if (!page) continue;
        const event = page.events[page.offset];
        if (event && (!selected || event.id > selected.id)) {
          selected = event;
          sourceId = candidate;
        }
      }
      if (!selected || sourceId === undefined) break;
      const page = pages.get(sourceId)!;
      page.offset++;
      // Duplicate ids are not expected from the normal capture allocator, but
      // deduplicating here keeps the merged protocol stable for imported data.
      if (!seen.has(selected.id)) {
        seen.add(selected.id);
        selectedEvents.push(selected);
      }
      if (page.offset >= page.events.length) {
        const oldest = page.events.at(-1);
        if (page.hasMore && oldest && oldest.id > 0) {
          load(sourceId, oldest.id - 1);
        } else pages.delete(sourceId);
      }
    }
    const hasMore = [...pages.values()].some((page) => page.offset < page.events.length);
    return { events: selectedEvents, matched, hasMore };
  }

  inspect(
    shareId: string,
    id: number,
    context = 25,
  ): {
    event: LogEvent;
    details: string;
    exceptions: ReturnType<typeof extractExceptions>;
    context: LogEvent[];
    limited?: boolean;
    crash?: { id: number; message: string; exceptions?: ReturnType<typeof extractExceptions> };
  } {
    if (
      typeof shareId !== 'string' ||
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(context) ||
      context < 0 ||
      context > 25
    )
      throw new AgentAccessError('INVALID_INPUT', 'shareId, id, and context must be valid bounded values.');
    this.assertShare(shareId);
    const event = this.store.find(id);
    if (
      !event ||
      !this.shared.has(event.serverId ?? '') ||
      !this.shared.get(event.serverId!)!.has(event.sessionId ?? '*')
    )
      throw new AgentAccessError('EVENT_UNAVAILABLE', 'That event is not available in the shared runs.');
    const safe = this.boundEvent(this.redactor.event(event));
    const details = (safe.isJson && safe.raw ? formatDetails(safe.raw, 2) : (safe.raw ?? safe.message ?? '')).slice(
      0,
      16 * 1024,
    );
    const contextResult = this.store.context(id);
    const anchorIndex = contextResult.events.findIndex((item) => item.id === id);
    const count = Math.min(25, Math.max(0, context));
    const contextEvents =
      anchorIndex < 0 ? [] : contextResult.events.slice(Math.max(0, anchorIndex - count), anchorIndex + count + 1);
    const result = this.fitInspect(
      {
        event: safe,
        details: this.redactor.text(details),
        exceptions: extractExceptions(safe),
        context: contextEvents.map((item) => this.boundEvent(this.redactor.event(item))),
      },
      contextEvents.findIndex((item) => item.id === id),
    );
    // The crash that followed a JSON error is its own event from the same run,
    // redacted on its own. Its frames already carry its text, so they are sent
    // without the raw event, and only while the result stays within the tool
    // budget; otherwise the agent can inspect the crash's id itself.
    const crash = this.store.attachedCrash(id);
    if (!crash) return result;
    const safeCrash = this.boundEvent(this.redactor.event(crash));
    // A short summary always fits beside a result that is within the budget.
    const summary = { id: safeCrash.id, message: (safeCrash.message ?? '').slice(0, 1024) };
    const full = { ...result, crash: { ...summary, exceptions: extractExceptions(safeCrash) } };
    return Buffer.byteLength(JSON.stringify(full), 'utf8') <= INSPECT_BUDGET_BYTES
      ? full
      : { ...result, crash: summary };
  }

  /**
   * One trace across shared sources: spans from shared OpenTelemetry
   * services and retained logs from shared runs, redacted and bounded.
   */
  trace(shareId: string, traceId: string): TraceView & { coverage: { spans: number; logs: number; limited: boolean } } {
    if (typeof shareId !== 'string' || typeof traceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(traceId))
      throw new AgentAccessError('INVALID_INPUT', 'shareId and a trace id of letters, digits, - or _ are required.');
    this.assertShare(shareId);
    const id = traceId.toLowerCase();
    const sources = this.sources();
    const read = this.readMerged(
      { shareId, query: `traceId:${JSON.stringify(id)}` },
      sources,
      undefined,
      this.nextId(),
      this.nextId(),
      200,
    );
    const spans = (this.spans?.trace(id) ?? [])
      .filter((span) => this.sharedSpan(span))
      .map((span) => ({
        ...span,
        name: this.redactor.text(span.name),
        attributes: this.redactor.value(span.attributes) as typeof span.attributes,
        events: span.events.map((event) => ({
          ...event,
          name: this.redactor.text(event.name),
          attributes: this.redactor.value(event.attributes) as typeof event.attributes,
        })),
        status: {
          ...span.status,
          message: span.status.message === undefined ? undefined : this.redactor.text(span.status.message),
        },
      }));
    const logs = traceLogs(read.events, id, spans.length > 0, (event) =>
      this.redactor.text(event.message ?? '').slice(0, 1024),
    ).map((log) => (log.server === undefined ? log : { ...log, server: this.redactor.text(log.server) }));
    const view = buildTrace(id, spans, logs, 300);
    return { ...view, coverage: { spans: spans.length, logs: logs.length, limited: read.hasMore || view.omitted > 0 } };
  }

  // Spans belong to the receiver run that accepted them; sharing selected
  // runs shares only those runs' spans.
  private sharedSpan(span: Span): boolean {
    const runs = this.shared.get(`otel:${span.service}`);
    return Boolean(runs) && (this.shareAllRuns || span.sessionId === undefined || runs!.has(span.sessionId));
  }

  /**
   * LLM calls, tool executions, and agent runs from shared OpenTelemetry
   * services: totals per model and tool, the newest calls, and optionally
   * the start of each call's conversation. Redacted and bounded.
   */
  aiCalls(input: AgentAiCallsInput): unknown {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'An input with a string shareId is required.');
    const { traceId, model, includeContent } = input;
    if (traceId !== undefined && (typeof traceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(traceId)))
      throw new AgentAccessError('INVALID_INPUT', 'traceId must be letters, digits, - or _.');
    if (model !== undefined && (typeof model !== 'string' || model.length > 256))
      throw new AgentAccessError('INVALID_INPUT', 'model must be a string of at most 256 characters.');
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AgentAccessError('INVALID_INPUT', 'limit must be an integer from 1 to 200.');
    this.assertShare(input.shareId);
    const traces = new Map<string, Span[]>();
    const add = (id: string, spans: readonly Span[]) => {
      const shared = spans.filter((span) => this.sharedSpan(span));
      if (shared.length) traces.set(id, shared);
    };
    if (traceId) add(traceId.toLowerCase(), this.spans?.trace(traceId.toLowerCase()) ?? []);
    else for (const [id, spans] of this.spans?.entries() ?? []) add(id, spans);
    const summary = summarizeGenAi(traces, Infinity);
    const matching = model ? summary.calls.filter((call) => call.model === model) : summary.calls;
    const calls: (GenAiCall & { messages?: GenAiMessage[]; toolRuns?: Record<string, GenAiToolRun> })[] = matching
      .slice(0, limit)
      .map((call) => ({ ...call }));
    // The newest calls that recorded content carry the start of their conversation.
    let withContent = 0;
    if (includeContent)
      for (const call of calls) {
        if (withContent >= AI_CONTENT_CALLS) break;
        if (!call.hasContent) continue;
        // Redacted before it is cut, so a secret across the cut still matches its pattern.
        const detail = genAiCallDetail(traces.get(call.traceId) ?? [], call.spanId, {
          text: this.redactor.text,
          limit: AI_PART_CHARACTERS,
        });
        if (!detail) continue;
        call.messages = detail.messages;
        call.toolRuns = detail.toolRuns;
        withContent++;
      }
    const result = (shown: typeof calls) =>
      this.redactor.value({
        ...summary,
        calls: shown,
        coverage: {
          matched: matching.length,
          listed: shown.length,
          limited: matching.length > shown.length,
          contentCalls: shown.filter((call) => call.messages).length,
        },
      });
    // Content goes first when the result would not fit: the newest calls keep theirs longest.
    let value = result(calls);
    while (Buffer.byteLength(JSON.stringify(value), 'utf8') > INSPECT_BUDGET_BYTES) {
      let last = calls.length - 1;
      while (last >= 0 && !calls[last].messages) last--;
      if (last >= 0) calls[last] = { ...calls[last], messages: undefined, toolRuns: undefined };
      else if (calls.length > 1) calls.splice(Math.ceil(calls.length / 2));
      else break;
      value = result(calls);
    }
    return value;
  }

  analyze(input: AgentSearchInput): unknown {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'An analysis input with a string shareId is required.');
    this.assertShare(input.shareId);
    input = this.validate(input);
    const sources = this.sources(input.sourceIds);
    const sessions = this.sessions(input.sessionIds);
    // Analysis historically considered the whole retained snapshot when no
    // explicit boundary was supplied; keep that behavior even for callers
    // constructed without an ingestion sequence callback.
    const before = Number.isFinite(input.before) ? input.before! : Infinity;
    const read = this.readMerged(input, sources, sessions, before, before, 10000);
    const chronological = read.events.slice().reverse();
    const analysis = analyzeEvents(chronological, { from: input.from, to: input.to });
    return this.redactor.value({
      ...analysis,
      coverage: { matched: read.matched, analyzed: chronological.length, limited: read.matched > chronological.length },
      ...this.changedFiles(input),
    });
  }

  async wait(
    input: AgentSearchInput,
    watermark: number,
    timeoutMs = 5000,
    signal?: { aborted?: boolean; isCancellationRequested?: boolean },
  ): Promise<AgentSearchResult> {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'A wait input with a string shareId is required.');
    this.assertShare(input.shareId);
    input = this.validate(input);
    if (!Number.isSafeInteger(watermark) || watermark < 0)
      throw new AgentAccessError('INVALID_INPUT', 'watermark must be a non-negative event id.');
    if (!Number.isFinite(timeoutMs)) throw new AgentAccessError('INVALID_INPUT', 'timeoutMs must be a finite number.');
    // Copilot and MCP clients may each wait at once; the cap bounds the polling.
    if (this.activeWaits.size >= MAX_WAITS)
      throw new AgentAccessError('BUSY', `${MAX_WAITS} log waits are already active for this share.`);
    const waitToken = Symbol('logline-wait');
    this.activeWaits.add(waitToken);
    const end = Date.now() + Math.min(10000, Math.max(0, timeoutMs));
    let searched: string | undefined;
    try {
      while (Date.now() < end) {
        if (signal?.aborted || signal?.isCancellationRequested)
          throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
        this.assertShare(input.shareId);
        // Search again only after events arrived or the share changed.
        const state = `${this.nextId()}:${this.store.total}:${this.revision}`;
        if (state === searched) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        searched = state;
        const result = this.search({ ...input, before: undefined, limit: 200 });
        const events = result.events.filter((event) => event.id > watermark);
        if (events.length) {
          if (signal?.aborted || signal?.isCancellationRequested)
            throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
          this.assertShare(input.shareId);
          return {
            ...result,
            events,
            matched: events.length,
            partial: result.partial || events.length >= 200,
            hasMore: result.hasMore || events.length >= 200,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (signal?.aborted || signal?.isCancellationRequested)
        throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
      this.assertShare(input.shareId);
      const newest = this.nextId();
      return {
        events: [],
        matched: 0,
        newest,
        partial: false,
        hasMore: false,
        retention: { newest },
        ...this.changedFiles(input),
      };
    } finally {
      this.activeWaits.delete(waitToken);
    }
  }

  // An empty changedOnly result means something different when there is no diff to compare with.
  private changedFiles(input: AgentSearchInput): Pick<AgentSearchResult, 'changedFiles'> {
    return input.changedOnly ? { changedFiles: this.changes?.()?.files ?? null } : {};
  }

  private assertShare(id?: string): void {
    if (!this.shareId)
      throw new AgentAccessError(
        'NOT_SHARED',
        'No Logline logs are shared with agents. Ask the user to choose Share with agent in the Logline Logs panel in VS Code.',
      );
    if (id !== undefined && id !== this.shareId)
      throw new AgentAccessError('SHARE_CHANGED', 'The Logline sharing grant has changed.');
    this.refreshAllRuns();
  }
  /** Check a search input, and return it with `changedOnly` folded into its query. */
  private validate(input: AgentSearchInput): AgentSearchInput {
    if (!input || typeof input !== 'object')
      throw new AgentAccessError('INVALID_INPUT', 'A search input object is required.');
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256))
      throw new AgentAccessError('INVALID_INPUT', 'query must be at most 256 characters.');
    if (input.sessionId !== undefined && typeof input.sessionId !== 'string')
      throw new AgentAccessError('INVALID_INPUT', 'sessionId must be a string.');
    if (input.from !== undefined && (!Number.isFinite(input.from) || input.from < 0))
      throw new AgentAccessError('INVALID_INPUT', 'from must be a finite timestamp.');
    if (input.to !== undefined && (!Number.isFinite(input.to) || input.to < 0))
      throw new AgentAccessError('INVALID_INPUT', 'to must be a finite timestamp.');
    if (
      input.levels !== undefined &&
      (!Array.isArray(input.levels) || input.levels.some((level) => typeof level !== 'string'))
    )
      throw new AgentAccessError('INVALID_INPUT', 'levels must be an array of strings.');
    if (
      input.sourceIds !== undefined &&
      (!Array.isArray(input.sourceIds) || input.sourceIds.some((id) => typeof id !== 'string'))
    )
      throw new AgentAccessError('INVALID_INPUT', 'sourceIds must be an array of strings.');
    if (
      input.sessionIds !== undefined &&
      (!Array.isArray(input.sessionIds) || input.sessionIds.some((id) => typeof id !== 'string'))
    )
      throw new AgentAccessError('INVALID_INPUT', 'sessionIds must be an array of strings.');
    if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1))
      throw new AgentAccessError('INVALID_INPUT', 'limit must be a positive number.');
    if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0))
      throw new AgentAccessError('INVALID_INPUT', 'before must be a non-negative event id.');
    if (input.changedOnly !== undefined && typeof input.changedOnly !== 'boolean')
      throw new AgentAccessError('INVALID_INPUT', 'changedOnly must be a boolean.');
    if (!input.changedOnly) return input;
    const query = withChangedScope(input.query ?? '', true);
    if (query.length > 256)
      throw new AgentAccessError(
        'INVALID_INPUT',
        'query must be at most 256 characters including the changed:true that changedOnly adds.',
      );
    return { ...input, query };
  }
  private sources(ids?: string[]): string[] {
    const requested = ids?.length ? ids : [...this.shared.keys()];
    if (requested.some((id) => !this.shared.has(id)))
      throw new AgentAccessError('NOT_SHARED', 'A requested source is not shared with the agent.');
    return requested;
  }
  private sessions(ids?: string[]): Map<string, Set<string>> | undefined {
    if (!ids?.length) return undefined;
    const result = new Map<string, Set<string>>();
    for (const id of this.sources()) {
      const requested = ids.filter((sessionId) => this.shared.get(id)?.has(sessionId));
      result.set(id, new Set(requested));
    }
    if (![...result.values()].some((value) => value.size))
      throw new AgentAccessError('NOT_SHARED', 'No requested runs are shared with the agent.');
    return result;
  }
  private encodeCursor(before: number, lastId: number, key: string): string {
    return Buffer.from(JSON.stringify({ id: this.shareId, revision: this.revision, before, lastId, key })).toString(
      'base64url',
    );
  }
  /**
   * Keep an inspect result within the tool budget. Wide structured events
   * repeat every field in each neighbour, so the neighbours shrink first: to
   * their summary, then to the nearest ones. Only then does the event itself
   * lose its fields, which its details text still shows.
   */
  private fitInspect<
    T extends {
      event: LogEvent;
      details: string;
      exceptions: ReturnType<typeof extractExceptions>;
      context: LogEvent[];
    },
  >(result: T, anchor: number): T & { limited?: boolean } {
    const fits = (value: object) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= INSPECT_BUDGET_BYTES;
    if (fits(result)) return result;
    const summary = ({
      id,
      timestamp,
      timestampMs,
      level,
      message,
      stream,
      truncated,
      attachedTo,
    }: LogEvent): LogEvent => ({
      id,
      timestamp,
      timestampMs,
      level,
      message: message && message.length > 1024 ? message.slice(0, 1024) : message,
      stream,
      truncated: truncated || (message?.length ?? 0) > 1024 || undefined,
      ...(attachedTo !== undefined ? { attachedTo } : {}),
    });
    let limited: T & { limited: boolean } = { ...result, context: result.context.map(summary), limited: true };
    for (let side = Math.max(anchor, result.context.length - anchor - 1); !fits(limited) && side > 0;) {
      side = Math.floor(side / 2);
      limited = {
        ...limited,
        context: result.context.slice(Math.max(0, anchor - side), anchor + side + 1).map(summary),
      };
    }
    if (!fits(limited)) limited = { ...limited, event: { ...limited.event, fields: undefined, truncated: true } };
    if (!fits(limited)) limited = { ...limited, exceptions: [] };
    return limited;
  }
  private boundEvent(event: LogEvent): LogEvent {
    const bound = { ...event };
    if (bound.raw && bound.raw.length > 16 * 1024) {
      bound.raw = bound.raw.slice(0, 16 * 1024);
      bound.truncated = true;
    }
    if (bound.message && bound.message.length > 8 * 1024) {
      bound.message = bound.message.slice(0, 8 * 1024);
      bound.truncated = true;
    }
    return bound;
  }
  private decodeCursor(cursor: string | undefined, key: string): DecodedCursor {
    if (!cursor) return {};
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (
        value.id !== this.shareId ||
        value.revision !== this.revision ||
        value.key !== key ||
        !Number.isSafeInteger(value.before) ||
        value.before < 0 ||
        !Number.isSafeInteger(value.lastId) ||
        value.lastId < -1
      )
        throw new Error();
      return { before: value.before, lastId: value.lastId };
    } catch {
      throw new AgentAccessError('SHARE_CHANGED', 'The search cursor is no longer valid.');
    }
  }
}
