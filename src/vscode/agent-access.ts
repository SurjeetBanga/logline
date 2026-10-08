import { createHash, randomBytes } from 'node:crypto';
import { extractExceptions } from '../core/exceptions';
import { formatDetails } from '../core/format-details';
import { analyzeEvents } from '../core/log-analysis';
import { createRedactor, type RedactionOptions, type Redactor } from '../core/redaction';
import type { LogStore, PageOptions } from '../core/log-store';
import type { AgentRunStatus, AgentShareStatus } from '../core/agent-types';
import type { SessionRegistry } from '../capture/session-registry';
import type { LogEvent, SessionSummary } from '../core/types';
import type { Span } from '../core/otlp';
import { buildTrace, traceLogs, type SpanStore, type TraceView } from '../core/traces';

// Leaves room under the 64 KiB tool result limit (agent-tools.ts) for the envelope.
const INSPECT_BUDGET_BYTES = 56 * 1024;

export type AgentErrorCode = 'NOT_SHARED' | 'SHARE_CHANGED' | 'INVALID_INPUT' | 'EVENT_UNAVAILABLE' | 'CANCELLED' | 'BUSY';
export class AgentAccessError extends Error {
  constructor(readonly code: AgentErrorCode, message: string) { super(message); this.name = 'AgentAccessError'; }
}

export type { AgentRunStatus, AgentShareStatus } from '../core/agent-types';

export interface AgentSearchInput extends PageOptions { shareId: string; sourceIds?: string[]; sessionIds?: string[]; limit?: number; cursor?: string; }
export interface AgentSearchResult { events: LogEvent[]; matched: number; nextCursor?: string; newest: number; partial: boolean; hasMore: boolean; retention?: { oldest?: number; newest: number; } }

interface DecodedCursor { before?: number; lastId?: number; }
interface MergedRead { events: LogEvent[]; matched: number; hasMore: boolean; }

/** In-memory sharing boundary between the log store and agent tools. */
export class AgentLogAccess {
  private shareId?: string;
  private revision = 0;
  private shared = new Map<string, Set<string>>();
  private shareAllRuns = false;
  private anchor?: number;
  private readonly redaction: RedactionOptions;
  private redactor: Redactor;
  private activeWait?: symbol;
  constructor(private readonly store: LogStore, private readonly registry: SessionRegistry,
    private readonly nextId: () => number = () => 0, redaction: RedactionOptions = {}, private readonly spans?: SpanStore) {
    this.redaction = { enabled: true, replacement: '[REDACTED]', ...redaction };
    this.redaction.enabled = true;
    this.redactor = createRedactor(this.redaction);
  }
  updateRedaction(options: RedactionOptions): void {
    Object.assign(this.redaction, options, { enabled: true });
    this.redactor = createRedactor(this.redaction);
  }

  /** The current grant's id, or undefined while nothing is shared. */
  get grant(): string | undefined { return this.shareId; }

  status(): AgentShareStatus {
    this.refreshAllRuns();
    const recordsBySource = new Map<string, SessionSummary[]>();
    for (const record of this.registry.records.values()) {
      const records = recordsBySource.get(record.serverId) ?? [];
      records.push(record);
      recordsBySource.set(record.serverId, records);
    }
    const sources = [...this.shared.entries()].map(([id, sessions]) => {
      const records = (recordsBySource.get(id) ?? []).filter(record => sessions.has(record.id));
      const label = records.at(-1)?.server ?? this.store.serverLabel(id) ?? id;
      const runs = [...sessions].filter(sessionId => sessionId !== '*').map(sessionId => {
        const record = this.registry.records.get(sessionId);
        return { id: sessionId, sourceId: id, label: this.redactor.text(record?.command || record?.server || sessionId),
          status: record?.status ?? 'exited', startedAt: record?.startedAt, endedAt: record?.endedAt,
          events: this.store.sessionEventCount(id, sessionId), ...(record?.dependencies ? { dependencies: record.dependencies.map(value => this.redactor.text(value)) } : {}), captureStatus: record?.captureStatus,
          captureReason: record?.captureReason === undefined ? undefined : this.redactor.text(record.captureReason) };
      });
      return { id, label: this.redactor.text(label), sessions: runs.length, events: runs.reduce((sum, run) => sum + run.events, 0), runs };
    });
    return { active: Boolean(this.shareId), shareId: this.shareId, revision: this.revision, scope: this.shareAllRuns ? 'all' : 'selected', sources };
  }

  availableSources(): { id: string; label: string; events: number }[] {
    const ids = new Set([...this.store.serverIds(), ...[...this.registry.records.values()].map(record => record.serverId)]);
    const labels = new Map<string, string>();
    for (const record of this.registry.records.values()) if (!labels.has(record.serverId)) labels.set(record.serverId, record.server);
    return [...ids].map(id => ({ id, label: this.redactor.text(this.store.serverLabel(id) ?? labels.get(id) ?? id), events: this.store.serverEventCount(id) }));
  }

  availableRuns(): AgentRunStatus[] {
    const runs: AgentRunStatus[] = [];
    const seen = new Set<string>();
    for (const record of this.registry.records.values()) {
      seen.add(`${record.serverId}\0${record.id}`);
      runs.push({ id: record.id, sourceId: record.serverId, label: this.redactor.text(record.command || record.server || record.id),
        status: record.status, startedAt: record.startedAt, endedAt: record.endedAt,
        events: this.store.sessionEventCount(record.serverId, record.id), ...(record.dependencies ? { dependencies: record.dependencies.map(value => this.redactor.text(value)) } : {}), captureStatus: record.captureStatus,
        captureReason: record.captureReason === undefined ? undefined : this.redactor.text(record.captureReason) });
    }
    for (const sourceId of this.store.serverIds()) for (const sessionId of this.store.sessionIds(sourceId)) {
      if (sessionId === '*' || seen.has(`${sourceId}\0${sessionId}`)) continue;
      runs.push({ id: sessionId, sourceId, label: this.redactor.text(this.store.serverLabel(sourceId) ?? sessionId), status: 'exited',
        events: this.store.sessionEventCount(sourceId, sessionId) });
    }
    return runs;
  }

  share(sourceIds: string[], anchor?: number, sessionIds?: string[]): AgentShareStatus {
    const ids = [...new Set(sourceIds.filter(id => typeof id === 'string' && id.trim()))];
    if (!ids.length) throw new AgentAccessError('INVALID_INPUT', 'Choose at least one log source to share.');
    const available = new Set(this.availableSources().map(source => source.id));
    if (ids.some(id => !available.has(id))) throw new AgentAccessError('INVALID_INPUT', 'One or more selected log sources are no longer available.');
    if (anchor !== undefined) {
      const event = this.store.find(anchor);
      if (!event || !event.serverId || !ids.includes(event.serverId)) throw new AgentAccessError('INVALID_INPUT', 'The anchor event is not in a selected source.');
    }
    const selected = new Map<string, Set<string>>();
    for (const sourceId of ids) {
      const available = new Set<string>();
      for (const record of this.registry.records.values()) if (record.serverId === sourceId) available.add(record.id);
      for (const sessionId of this.store.sessionIds(sourceId)) available.add(sessionId);
      const wanted = sessionIds?.length ? sessionIds.filter(id => available.has(id)) : [...available];
      if (!wanted.length) throw new AgentAccessError('INVALID_INPUT', `No retained run is available for source ${sourceId}.`);
      selected.set(sourceId, new Set(wanted));
    }
    if (anchor !== undefined) {
      const event = this.store.find(anchor);
      const set = selected.get(event!.serverId!);
      if (set && !set.has(event!.sessionId ?? '*')) throw new AgentAccessError('INVALID_INPUT', 'The anchor event is not in a selected run.');
    }
    this.shareAllRuns = false;
    this.shared = selected; this.shareId = randomBytes(8).toString('hex'); this.revision++;
    this.anchor = anchor;
    return this.status();
  }

  shareAll(): AgentShareStatus {
    this.shareAllRuns = true; this.shareId = randomBytes(8).toString('hex'); this.anchor = undefined; this.revision++;
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

  revoke(): void { this.shareAllRuns = false; this.shared.clear(); this.shareId = undefined; this.anchor = undefined; this.revision++; this.activeWait = undefined; }
  isSharedSource(id: string | undefined): boolean { this.refreshAllRuns(); return Boolean(id && this.shared.has(id)); }
  getAnchor(): number | undefined { return this.anchor; }

  list(input?: { shareId?: string }): AgentShareStatus {
    this.assertShare(input?.shareId);
    return this.status();
  }

  search(input: AgentSearchInput): AgentSearchResult {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'A search input with a string shareId is required.');
    this.assertShare(input.shareId);
    this.validate(input);
    const sources = this.sources(input.sourceIds);
    const sessions = this.sessions(input.sessionIds);
    const limit = Math.max(1, Math.min(200, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 100));
    const cursorKey = createHash('sha256').update(JSON.stringify({ query: input.query ?? '', levels: input.levels ? [...input.levels].sort() : undefined, sourceIds: input.sourceIds ? [...input.sourceIds].sort() : this.shareAllRuns ? 'all' : [...this.shared.keys()].sort(), sessionId: input.sessionId, sessionIds: input.sessionIds ? [...input.sessionIds].sort() : undefined, from: input.from, to: input.to })).digest('base64url');
    const cursorState = this.decodeCursor(input.cursor, cursorKey);
    const snapshotBefore = cursorState.before ?? (Number.isFinite(input.before) ? input.before! : this.nextId());
    const before = cursorState.lastId ?? snapshotBefore;
    const newest = this.nextId();
    const read = this.readMerged(input, sources, sessions, before, snapshotBefore, limit);
    const selected: LogEvent[] = [];
    // Leave room for the envelope and opaque continuation cursor so the tool
    // adapter never has to drop an already-selected event after pagination.
    const maxResultBytes = 48 * 1024;
    const baseBytes = Buffer.byteLength(JSON.stringify({ events: [], matched: read.matched, newest, partial: true, hasMore: true }), 'utf8');
    let bytes = baseBytes;
    for (const event of read.events) {
      let safe = this.redactor.event(event);
      let encoded = JSON.stringify(safe);
      if (bytes + Buffer.byteLength(encoded, 'utf8') + 2 > maxResultBytes) {
        if (!selected.length) { safe = { id: safe.id, level: safe.level, message: '[TRUNCATED]', truncated: true }; encoded = JSON.stringify(safe); }
        else break;
      }
      selected.push(safe); bytes += Buffer.byteLength(encoded, 'utf8') + 1;
    }
    const byteLimited = selected.length < read.events.length;
    const hasMore = read.hasMore || byteLimited;
    const continuationBefore = selected.length ? selected[selected.length - 1].id - 1 : before;
    return { events: selected, matched: read.matched, newest, partial: hasMore, hasMore,
      retention: { oldest: selected.length ? selected[selected.length - 1].id : undefined, newest },
      nextCursor: hasMore ? this.encodeCursor(snapshotBefore, continuationBefore, cursorKey) : undefined };
  }

  // Each source contributes one bounded page at a time. Pages are merged by
  // event id, so a multi-source search stays newest-first without materializing
  // every matching event in the retained store.
  private readMerged(input: AgentSearchInput, sources: string[], sessions: Map<string, Set<string>> | undefined,
    before: number, snapshotBefore: number, limit: number): MergedRead {
    const pages = new Map<string, { events: LogEvent[]; offset: number; hasMore: boolean }>();
    const load = (sourceId: string, boundary: number) => {
      const sourceSessions = sessions?.get(sourceId) ?? this.shared.get(sourceId)!;
      const wantedSessions = input.sessionId
        ? new Set([...sourceSessions].filter(id => id === input.sessionId))
        : sourceSessions;
      const result = this.store.reversePage({ query: input.query, levels: input.levels, serverId: sourceId,
        before: boundary, sessionIds: [...wantedSessions], from: input.from, to: input.to }, Math.min(1000, limit));
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
    while (selectedEvents.length < limit && pages.size && [...pages.values()].some(page => page.offset < page.events.length)) {
      let sourceId: string | undefined;
      let selected: LogEvent | undefined;
      for (const candidate of sources) {
        const page = pages.get(candidate);
        if (!page) continue;
        const event = page.events[page.offset];
        if (event && (!selected || event.id > selected.id)) { selected = event; sourceId = candidate; }
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
    const hasMore = [...pages.values()].some(page => page.offset < page.events.length);
    return { events: selectedEvents, matched, hasMore };
  }

  inspect(shareId: string, id: number, context = 25): { event: LogEvent; details: string; exceptions: ReturnType<typeof extractExceptions>; context: LogEvent[];
    limited?: boolean; crash?: { id: number; message: string; exceptions?: ReturnType<typeof extractExceptions> } } {
    if (typeof shareId !== 'string' || !Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(context) || context < 0 || context > 25) throw new AgentAccessError('INVALID_INPUT', 'shareId, id, and context must be valid bounded values.');
    this.assertShare(shareId);
    const event = this.store.find(id);
    if (!event || !this.shared.has(event.serverId ?? '') || !this.shared.get(event.serverId!)!.has(event.sessionId ?? '*')) throw new AgentAccessError('EVENT_UNAVAILABLE', 'That event is not available in the shared runs.');
    const safe = this.boundEvent(this.redactor.event(event));
    const details = (safe.isJson && safe.raw ? formatDetails(safe.raw, 2) : safe.raw ?? safe.message ?? '').slice(0, 16 * 1024);
    const contextResult = this.store.context(id);
    const anchorIndex = contextResult.events.findIndex(item => item.id === id);
    const count = Math.min(25, Math.max(0, context));
    const contextEvents = anchorIndex < 0 ? [] : contextResult.events.slice(Math.max(0, anchorIndex - count), anchorIndex + count + 1);
    const result = this.fitInspect({ event: safe, details: this.redactor.text(details), exceptions: extractExceptions(safe),
      context: contextEvents.map(item => this.boundEvent(this.redactor.event(item))) }, contextEvents.findIndex(item => item.id === id));
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
    return Buffer.byteLength(JSON.stringify(full), 'utf8') <= INSPECT_BUDGET_BYTES ? full : { ...result, crash: summary };
  }

  /**
   * One trace across shared sources: spans from shared OpenTelemetry
   * services and retained logs from shared runs, redacted and bounded.
   */
  trace(shareId: string, traceId: string): TraceView & { coverage: { spans: number; logs: number; limited: boolean } } {
    if (typeof shareId !== 'string' || typeof traceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(traceId)) throw new AgentAccessError('INVALID_INPUT', 'shareId and a trace id of letters, digits, - or _ are required.');
    this.assertShare(shareId);
    const id = traceId.toLowerCase();
    const sources = this.sources();
    const read = this.readMerged({ shareId, query: `traceId:${JSON.stringify(id)}` }, sources, undefined, this.nextId(), this.nextId(), 200);
    // Spans belong to the receiver run that accepted them; sharing selected
    // runs shares only those runs' spans.
    const sharedSpan = (span: Span) => {
      const runs = this.shared.get(`otel:${span.service}`);
      return Boolean(runs) && (this.shareAllRuns || span.sessionId === undefined || runs!.has(span.sessionId));
    };
    const spans = (this.spans?.trace(id) ?? []).filter(sharedSpan).map(span => ({ ...span, name: this.redactor.text(span.name), attributes: this.redactor.value(span.attributes) as typeof span.attributes,
      events: span.events.map(event => ({ ...event, name: this.redactor.text(event.name), attributes: this.redactor.value(event.attributes) as typeof event.attributes })),
      status: { ...span.status, message: span.status.message === undefined ? undefined : this.redactor.text(span.status.message) } }));
    const logs = traceLogs(read.events, id, spans.length > 0, event => this.redactor.text(event.message ?? '').slice(0, 1024))
      .map(log => log.server === undefined ? log : { ...log, server: this.redactor.text(log.server) });
    const view = buildTrace(id, spans, logs, 300);
    return { ...view, coverage: { spans: spans.length, logs: logs.length, limited: read.hasMore || view.omitted > 0 } };
  }

  analyze(input: AgentSearchInput): unknown {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'An analysis input with a string shareId is required.');
    this.assertShare(input.shareId);
    this.validate(input);
    const sources = this.sources(input.sourceIds);
    const sessions = this.sessions(input.sessionIds);
    // Analysis historically considered the whole retained snapshot when no
    // explicit boundary was supplied; keep that behavior even for callers
    // constructed without an ingestion sequence callback.
    const before = Number.isFinite(input.before) ? input.before! : Infinity;
    const read = this.readMerged(input, sources, sessions, before, before, 10000);
    const chronological = read.events.slice().reverse();
    const analysis = analyzeEvents(chronological, { from: input.from, to: input.to });
    return this.redactor.value({ ...analysis, coverage: { matched: read.matched, analyzed: chronological.length, limited: read.matched > chronological.length } });
  }

  async wait(input: AgentSearchInput, watermark: number, timeoutMs = 5000, signal?: { aborted?: boolean; isCancellationRequested?: boolean }): Promise<AgentSearchResult> {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'A wait input with a string shareId is required.');
    this.assertShare(input.shareId);
    this.validate(input);
    if (!Number.isSafeInteger(watermark) || watermark < 0) throw new AgentAccessError('INVALID_INPUT', 'watermark must be a non-negative event id.');
    if (!Number.isFinite(timeoutMs)) throw new AgentAccessError('INVALID_INPUT', 'timeoutMs must be a finite number.');
    if (this.activeWait) throw new AgentAccessError('BUSY', 'A wait is already active for this share.');
    const waitToken = Symbol('logline-wait');
    this.activeWait = waitToken;
    const end = Date.now() + Math.min(10000, Math.max(0, timeoutMs));
    try {
      while (Date.now() < end) {
        if (signal?.aborted || signal?.isCancellationRequested) throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
        this.assertShare(input.shareId);
        const result = this.search({ ...input, before: undefined, limit: 200 });
        const events = result.events.filter(event => event.id > watermark);
        if (events.length) {
          if (signal?.aborted || signal?.isCancellationRequested) throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
          this.assertShare(input.shareId);
          return { ...result, events, matched: events.length,
            partial: result.partial || events.length >= 200, hasMore: result.hasMore || events.length >= 200 };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (signal?.aborted || signal?.isCancellationRequested) throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
      this.assertShare(input.shareId);
      const newest = this.nextId();
      return { events: [], matched: 0, newest, partial: false, hasMore: false, retention: { newest } };
    } finally { if (this.activeWait === waitToken) this.activeWait = undefined; }
  }

  private assertShare(id?: string): void {
    if (!this.shareId) throw new AgentAccessError('NOT_SHARED', 'No Logline logs are shared with agents. Ask the user to choose Share with agent in the Logline Logs panel in VS Code.');
    if (id !== undefined && id !== this.shareId) throw new AgentAccessError('SHARE_CHANGED', 'The Logline sharing grant has changed.');
    this.refreshAllRuns();
  }
  private validate(input: AgentSearchInput): void {
    if (!input || typeof input !== 'object') throw new AgentAccessError('INVALID_INPUT', 'A search input object is required.');
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) throw new AgentAccessError('INVALID_INPUT', 'query must be at most 256 characters.');
    if (input.sessionId !== undefined && typeof input.sessionId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'sessionId must be a string.');
    if (input.from !== undefined && (!Number.isFinite(input.from) || input.from < 0)) throw new AgentAccessError('INVALID_INPUT', 'from must be a finite timestamp.');
    if (input.to !== undefined && (!Number.isFinite(input.to) || input.to < 0)) throw new AgentAccessError('INVALID_INPUT', 'to must be a finite timestamp.');
    if (input.levels !== undefined && (!Array.isArray(input.levels) || input.levels.some(level => typeof level !== 'string'))) throw new AgentAccessError('INVALID_INPUT', 'levels must be an array of strings.');
    if (input.sourceIds !== undefined && (!Array.isArray(input.sourceIds) || input.sourceIds.some(id => typeof id !== 'string'))) throw new AgentAccessError('INVALID_INPUT', 'sourceIds must be an array of strings.');
    if (input.sessionIds !== undefined && (!Array.isArray(input.sessionIds) || input.sessionIds.some(id => typeof id !== 'string'))) throw new AgentAccessError('INVALID_INPUT', 'sessionIds must be an array of strings.');
    if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1)) throw new AgentAccessError('INVALID_INPUT', 'limit must be a positive number.');
    if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0)) throw new AgentAccessError('INVALID_INPUT', 'before must be a non-negative event id.');
  }
  private sources(ids?: string[]): string[] {
    const requested = ids?.length ? ids : [...this.shared.keys()];
    if (requested.some(id => !this.shared.has(id))) throw new AgentAccessError('NOT_SHARED', 'A requested source is not shared with the agent.');
    return requested;
  }
  private sessions(ids?: string[]): Map<string, Set<string>> | undefined {
    if (!ids?.length) return undefined;
    const result = new Map<string, Set<string>>();
    for (const id of this.sources()) {
      const requested = ids.filter(sessionId => this.shared.get(id)?.has(sessionId));
      result.set(id, new Set(requested));
    }
    if (![...result.values()].some(value => value.size)) throw new AgentAccessError('NOT_SHARED', 'No requested runs are shared with the agent.');
    return result;
  }
  private encodeCursor(before: number, lastId: number, key: string): string {
    return Buffer.from(JSON.stringify({ id: this.shareId, revision: this.revision, before, lastId, key })).toString('base64url');
  }
  /**
   * Keep an inspect result within the tool budget. Wide structured events
   * repeat every field in each neighbour, so the neighbours shrink first: to
   * their summary, then to the nearest ones. Only then does the event itself
   * lose its fields, which its details text still shows.
   */
  private fitInspect<T extends { event: LogEvent; details: string; exceptions: ReturnType<typeof extractExceptions>; context: LogEvent[] }>(
    result: T, anchor: number): T & { limited?: boolean } {
    const fits = (value: object) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= INSPECT_BUDGET_BYTES;
    if (fits(result)) return result;
    const summary = ({ id, timestamp, timestampMs, level, message, stream, truncated, attachedTo }: LogEvent): LogEvent => ({
      id, timestamp, timestampMs, level, message: message && message.length > 1024 ? message.slice(0, 1024) : message, stream,
      truncated: truncated || (message?.length ?? 0) > 1024 || undefined, ...(attachedTo !== undefined ? { attachedTo } : {})
    });
    let limited: T & { limited: boolean } = { ...result, context: result.context.map(summary), limited: true };
    for (let side = Math.max(anchor, result.context.length - anchor - 1); !fits(limited) && side > 0;) {
      side = Math.floor(side / 2);
      limited = { ...limited, context: result.context.slice(Math.max(0, anchor - side), anchor + side + 1).map(summary) };
    }
    if (!fits(limited)) limited = { ...limited, event: { ...limited.event, fields: undefined, truncated: true } };
    if (!fits(limited)) limited = { ...limited, exceptions: [] };
    return limited;
  }
  private boundEvent(event: LogEvent): LogEvent {
    const bound = { ...event };
    if (bound.raw && bound.raw.length > 16 * 1024) { bound.raw = bound.raw.slice(0, 16 * 1024); bound.truncated = true; }
    if (bound.message && bound.message.length > 8 * 1024) { bound.message = bound.message.slice(0, 8 * 1024); bound.truncated = true; }
    return bound;
  }
  private decodeCursor(cursor: string | undefined, key: string): DecodedCursor {
    if (!cursor) return {};
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (value.id !== this.shareId || value.revision !== this.revision || value.key !== key
        || !Number.isSafeInteger(value.before) || value.before < 0 || !Number.isSafeInteger(value.lastId) || value.lastId < -1) throw new Error();
      return { before: value.before, lastId: value.lastId };
    } catch { throw new AgentAccessError('SHARE_CHANGED', 'The search cursor is no longer valid.'); }
  }
}
