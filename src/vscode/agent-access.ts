import { randomBytes } from 'node:crypto';
import { extractExceptions } from '../core/exceptions';
import { formatDetails } from '../core/format-details';
import { analyzeEvents } from '../core/log-analysis';
import { createRedactor, type RedactionOptions, type Redactor } from '../core/redaction';
import type { LogStore, PageOptions } from '../core/log-store';
import type { AgentRunStatus, AgentShareStatus } from '../core/agent-types';
import type { SessionRegistry } from '../capture/session-registry';
import type { LogEvent } from '../core/types';

export type AgentErrorCode = 'NOT_SHARED' | 'SHARE_CHANGED' | 'INVALID_INPUT' | 'EVENT_UNAVAILABLE' | 'CANCELLED' | 'BUSY';
export class AgentAccessError extends Error {
  constructor(readonly code: AgentErrorCode, message: string) { super(message); this.name = 'AgentAccessError'; }
}

export type { AgentRunStatus, AgentShareStatus } from '../core/agent-types';

export interface AgentSearchInput extends PageOptions { shareId: string; sourceIds?: string[]; sessionIds?: string[]; limit?: number; cursor?: string; }
export interface AgentSearchResult { events: LogEvent[]; matched: number; nextCursor?: string; newest: number; partial: boolean; hasMore: boolean; retention?: { oldest?: number; newest: number; } }

interface SourceCursor { before: number; }
interface DecodedCursor { before?: number; sources?: Record<string, SourceCursor>; }
interface MergedRead { events: LogEvent[]; matched: number; hasMore: boolean; sources: Map<string, SourceCursor>; checkpoints: Map<string, SourceCursor>[]; }

/** In-memory sharing boundary between the log store and agent tools. */
export class AgentLogAccess {
  private shareId?: string;
  private revision = 0;
  private shared = new Map<string, Set<string>>();
  private shareAllRuns = false;
  private anchor?: number;
  private readonly redaction: RedactionOptions;
  private redactor: Redactor;
  private activeWait = false;
  constructor(private readonly store: LogStore, private readonly registry: SessionRegistry,
    private readonly nextId: () => number = () => 0, redaction: RedactionOptions = {}) {
    this.redaction = { enabled: true, replacement: '[REDACTED]', ...redaction };
    this.redaction.enabled = true;
    this.redactor = createRedactor(this.redaction);
  }
  updateRedaction(options: RedactionOptions): void {
    Object.assign(this.redaction, options, { enabled: true });
    this.redactor = createRedactor(this.redaction);
  }

  status(): AgentShareStatus {
    this.refreshAllRuns();
    const recordsBySource = new Map<string, typeof this.registry.records extends Map<any, infer R> ? R[] : never>();
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
          events: this.store.sessionEventCount(id, sessionId), captureStatus: record?.captureStatus,
          captureReason: record?.captureReason };
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
        events: this.store.sessionEventCount(record.serverId, record.id), captureStatus: record.captureStatus, captureReason: record.captureReason });
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

  revoke(): void { this.shareAllRuns = false; this.shared.clear(); this.shareId = undefined; this.anchor = undefined; this.revision++; this.activeWait = false; }
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
    const cursorKey = JSON.stringify({ query: input.query ?? '', levels: input.levels ? [...input.levels].sort() : undefined, sourceIds: input.sourceIds ? [...input.sourceIds].sort() : this.shareAllRuns ? 'all' : [...this.shared.keys()].sort(), sessionId: input.sessionId, sessionIds: input.sessionIds ? [...input.sessionIds].sort() : undefined, from: input.from, to: input.to });
    const cursorState = this.decodeCursor(input.cursor, cursorKey);
    const before = cursorState.before ?? (Number.isFinite(input.before) ? input.before! : this.nextId());
    const newest = this.nextId();
    const read = this.readMerged(input, sources, sessions, before, cursorState.sources, limit);
    const selected: LogEvent[] = [];
    const baseBytes = Buffer.byteLength(JSON.stringify({ events: [], matched: read.matched, newest, partial: true, hasMore: true }), 'utf8');
    let bytes = baseBytes;
    for (const event of read.events) {
      let safe = this.redactor.event(event);
      let encoded = JSON.stringify(safe);
      if (bytes + Buffer.byteLength(encoded, 'utf8') + 2 > 60 * 1024) {
        if (!selected.length) { safe = { id: safe.id, level: safe.level, message: '[TRUNCATED]', truncated: true }; encoded = JSON.stringify(safe); }
        else break;
      }
      selected.push(safe); bytes += Buffer.byteLength(encoded, 'utf8') + 1;
    }
    const byteLimited = selected.length < read.events.length;
    const hasMore = read.hasMore || byteLimited;
    const cursorSources = byteLimited && selected.length
      ? read.checkpoints[selected.length - 1]
      : read.sources;
    return { events: selected, matched: read.matched, newest, partial: hasMore, hasMore,
      retention: { oldest: selected.length ? selected[selected.length - 1].id : undefined, newest },
      nextCursor: hasMore ? this.encodeCursor(cursorSources, before, cursorKey) : undefined };
  }

  // Each source contributes one bounded page at a time. Pages are merged by
  // event id, so a multi-source search stays newest-first without materializing
  // every matching event in the retained store.
  private readMerged(input: AgentSearchInput, sources: string[], sessions: Map<string, Set<string>> | undefined,
    before: number, cursorSources: Record<string, SourceCursor> | undefined, limit: number): MergedRead {
    const states = new Map<string, SourceCursor>();
    const pages = new Map<string, { events: LogEvent[]; offset: number }>();
    const load = (sourceId: string, boundary: number) => {
      const sourceSessions = sessions?.get(sourceId) ?? this.shared.get(sourceId)!;
      const wantedSessions = input.sessionId
        ? new Set([...sourceSessions].filter(id => id === input.sessionId))
        : sourceSessions;
      const result = this.store.page({ query: input.query, levels: input.levels, serverId: sourceId,
        before: boundary, sessionIds: [...wantedSessions], from: input.from, to: input.to, full: true });
      pages.set(sourceId, { events: result.events, offset: 0 });
      return result.matched;
    };
    let matched = 0;
    for (const sourceId of sources) {
      const requested = cursorSources?.[sourceId];
      const boundary = requested?.before ?? before;
      states.set(sourceId, { before: boundary });
      // The count is always taken at the fixed snapshot boundary. On a cursor
      // continuation this may be one extra indexed page read, but keeps the
      // coverage count exact if older rows were evicted between calls.
      matched += load(sourceId, before);
      if (boundary !== before) load(sourceId, boundary);
    }
    const seen = new Set<number>();
    const selectedEvents: LogEvent[] = [];
    const checkpoints: Map<string, SourceCursor>[] = [];
    while (selectedEvents.length < limit && pages.size && [...pages.values()].some(page => page.offset < page.events.length)) {
      let sourceId: string | undefined;
      let selected: LogEvent | undefined;
      for (const candidate of sources) {
        const page = pages.get(candidate)!;
        const event = page.events[page.events.length - 1 - page.offset];
        if (event && (!selected || event.id > selected.id)) { selected = event; sourceId = candidate; }
      }
      if (!selected || sourceId === undefined) break;
      const page = pages.get(sourceId)!;
      page.offset++;
      const state = states.get(sourceId)!;
      state.before = selected.id > 0 ? selected.id - 1 : -1;
      // Duplicate ids are not expected from the normal capture allocator, but
      // deduplicating here keeps the merged protocol stable for imported data.
      if (!seen.has(selected.id)) {
        seen.add(selected.id);
        selectedEvents.push(selected);
        checkpoints.push(new Map([...states].map(([id, state]) => [id, { ...state }])));
      }
      if (page.offset >= page.events.length) {
        const oldest = page.events[0];
        if (oldest && oldest.id > 0) {
          const nextBoundary = oldest.id - 1;
          state.before = nextBoundary;
          load(sourceId, nextBoundary);
        } else pages.delete(sourceId);
      }
    }
    const hasMore = [...pages.values()].some(page => page.offset < page.events.length);
    return { events: selectedEvents, matched, hasMore, sources: states, checkpoints };
  }

  inspect(shareId: string, id: number, context = 25): { event: LogEvent; details: string; exceptions: ReturnType<typeof extractExceptions>; context: LogEvent[] } {
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
    return { event: safe, details: this.redactor.text(details), exceptions: extractExceptions(safe), context: contextEvents.map(item => this.boundEvent(this.redactor.event(item))) };
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
    const read = this.readMerged(input, sources, sessions, before, undefined, 10000);
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
    this.activeWait = true;
    const end = Date.now() + Math.min(10000, Math.max(0, timeoutMs));
    try {
      while (Date.now() < end) {
        if (signal?.aborted || signal?.isCancellationRequested) throw new AgentAccessError('CANCELLED', 'The log wait was cancelled.');
        this.assertShare(input.shareId);
        const result = this.search({ ...input, before: undefined, limit: 200 });
        const events = result.events.filter(event => event.id > watermark);
        if (events.length) return { ...result, events, matched: events.length,
          partial: result.partial || events.length >= 200, hasMore: result.hasMore || events.length >= 200 };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { events: [], matched: 0, newest: this.nextId(), partial: false, hasMore: false, retention: { newest: this.nextId() } };
    } finally { this.activeWait = false; }
  }

  private assertShare(id?: string): void {
    if (!this.shareId) throw new AgentAccessError('NOT_SHARED', 'No Logline logs are shared with Copilot. Use Share logs with agent in the Logs toolbar first.');
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
  private encodeCursor(sources: Map<string, SourceCursor>, before: number, key: string): string {
    return Buffer.from(JSON.stringify({ id: this.shareId, revision: this.revision, before, key,
      sources: Object.fromEntries(sources) })).toString('base64url');
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
        || !Number.isSafeInteger(value.before) || value.before < 0 || !value.sources || typeof value.sources !== 'object') throw new Error();
      const sources: Record<string, SourceCursor> = {};
      for (const [sourceId, state] of Object.entries(value.sources as Record<string, unknown>)) {
        if (!state || typeof state !== 'object' || !Number.isSafeInteger((state as any).before) || (state as any).before < -1) throw new Error();
        sources[sourceId] = { before: (state as any).before };
      }
      return { before: value.before, sources };
    } catch { throw new AgentAccessError('SHARE_CHANGED', 'The search cursor is no longer valid.'); }
  }
}
