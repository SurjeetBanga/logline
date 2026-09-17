import { randomBytes } from 'node:crypto';
import { extractExceptions } from '../core/exceptions';
import { formatDetails } from '../core/format-details';
import { analyzeEvents, findPatterns, groupErrors } from '../core/log-analysis';
import { redactEvent, redactText, redactValue, type RedactionOptions } from '../core/redaction';
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

/** In-memory sharing boundary between the log store and agent tools. */
export class AgentLogAccess {
  private shareId?: string;
  private revision = 0;
  private shared = new Map<string, Set<string>>();
  private shareAllRuns = false;
  private anchor?: number;
  private readonly redaction: RedactionOptions;
  private activeWait = false;
  constructor(private readonly store: LogStore, private readonly registry: SessionRegistry,
    private readonly nextId: () => number = () => 0, redaction: RedactionOptions = {}) {
    this.redaction = { enabled: true, replacement: '[REDACTED]', ...redaction };
    this.redaction.enabled = true;
  }
  updateRedaction(options: RedactionOptions): void {
    Object.assign(this.redaction, options, { enabled: true });
  }

  status(): AgentShareStatus {
    this.refreshAllRuns();
    const sources = [...this.shared.entries()].map(([id, sessions]) => {
      const records = [...this.registry.records.values()].filter(record => record.serverId === id && sessions.has(record.id));
      const label = records.at(-1)?.server ?? this.store.serverLabel(id) ?? id;
      const runs = [...sessions].filter(sessionId => sessionId !== '*').map(sessionId => {
        const record = this.registry.records.get(sessionId);
        return { id: sessionId, sourceId: id, label: redactText(record?.command || record?.server || sessionId, this.redaction),
          status: record?.status ?? 'exited', startedAt: record?.startedAt, endedAt: record?.endedAt,
          events: this.store.sessionEventCount(id, sessionId), captureStatus: record?.captureStatus,
          captureReason: record?.captureReason };
      });
      return { id, label: redactText(label, this.redaction), sessions: runs.length, events: runs.reduce((sum, run) => sum + run.events, 0), runs };
    });
    return { active: Boolean(this.shareId), shareId: this.shareId, revision: this.revision, scope: this.shareAllRuns ? 'all' : 'selected', sources };
  }

  availableSources(): { id: string; label: string; events: number }[] {
    const ids = new Set([...this.store.serverIds(), ...[...this.registry.records.values()].map(record => record.serverId)]);
    return [...ids].map(id => ({ id, label: redactText(this.store.serverLabel(id) ?? [...this.registry.records.values()].find(record => record.serverId === id)?.server ?? id, this.redaction), events: this.store.serverEventCount(id) }));
  }

  availableRuns(): AgentRunStatus[] {
    const runs: AgentRunStatus[] = [];
    const seen = new Set<string>();
    for (const record of this.registry.records.values()) {
      seen.add(`${record.serverId}\0${record.id}`);
      runs.push({ id: record.id, sourceId: record.serverId, label: redactText(record.command || record.server || record.id, this.redaction),
        status: record.status, startedAt: record.startedAt, endedAt: record.endedAt,
        events: this.store.sessionEventCount(record.serverId, record.id), captureStatus: record.captureStatus, captureReason: record.captureReason });
    }
    for (const sourceId of this.store.serverIds()) for (const sessionId of this.store.sessionIds(sourceId)) {
      if (sessionId === '*' || seen.has(`${sourceId}\0${sessionId}`)) continue;
      runs.push({ id: sessionId, sourceId, label: redactText(this.store.serverLabel(sourceId) ?? sessionId, this.redaction), status: 'exited',
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
    const all: LogEvent[] = [];
    for (const sourceId of sources) {
      const sourceSessions = sessions?.get(sourceId) ?? this.shared.get(sourceId)!;
      const wantedSessions = input.sessionId ? new Set([...sourceSessions].filter(id => id === input.sessionId)) : sourceSessions;
      for (const event of this.store.exportEvents({ query: input.query, levels: input.levels, serverId: sourceId, before, sessionId: input.sessionId, from: input.from, to: input.to }))
        if (wantedSessions.has(event.sessionId ?? '*')) all.push(event);
    }
    all.sort((a, b) => b.id - a.id);
    const offset = cursorState.offset;
    const selected: LogEvent[] = [];
    const baseBytes = Buffer.byteLength(JSON.stringify({ events: [], matched: all.length, newest: this.nextId(), partial: true, hasMore: true }), 'utf8');
    let bytes = baseBytes;
    for (let index = offset; index < Math.min(offset + limit, all.length); index++) {
      let safe = redactEvent(all[index], this.redaction);
      let encoded = JSON.stringify(safe);
      if (bytes + Buffer.byteLength(encoded, 'utf8') + 2 > 60 * 1024) {
        if (!selected.length) { safe = { id: safe.id, level: safe.level, message: '[TRUNCATED]', truncated: true }; encoded = JSON.stringify(safe); }
        else break;
      }
      selected.push(safe); bytes += Buffer.byteLength(encoded, 'utf8') + 1;
    }
    const nextOffset = offset + selected.length;
    const hasMore = nextOffset < all.length;
    return { events: selected, matched: all.length, newest: this.nextId(), partial: hasMore, hasMore,
      retention: { oldest: all.length ? all[0].id : undefined, newest: this.nextId() },
      nextCursor: hasMore ? this.encodeCursor(nextOffset, before, cursorKey) : undefined };
  }

  inspect(shareId: string, id: number, context = 25): { event: LogEvent; details: string; exceptions: ReturnType<typeof extractExceptions>; context: LogEvent[] } {
    if (typeof shareId !== 'string' || !Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(context) || context < 0 || context > 25) throw new AgentAccessError('INVALID_INPUT', 'shareId, id, and context must be valid bounded values.');
    this.assertShare(shareId);
    const event = this.store.find(id);
    if (!event || !this.shared.has(event.serverId ?? '') || !this.shared.get(event.serverId!)!.has(event.sessionId ?? '*')) throw new AgentAccessError('EVENT_UNAVAILABLE', 'That event is not available in the shared runs.');
    const safe = this.boundEvent(redactEvent(event, this.redaction));
    const details = (safe.isJson && safe.raw ? formatDetails(safe.raw, 2) : safe.raw ?? safe.message ?? '').slice(0, 16 * 1024);
    const contextResult = this.store.context(id);
    const anchorIndex = contextResult.events.findIndex(item => item.id === id);
    const count = Math.min(25, Math.max(0, context));
    const contextEvents = anchorIndex < 0 ? [] : contextResult.events.slice(Math.max(0, anchorIndex - count), anchorIndex + count + 1);
    return { event: safe, details: redactText(details, this.redaction), exceptions: extractExceptions(safe), context: contextEvents.map(item => this.boundEvent(redactEvent(item, this.redaction))) };
  }

  analyze(input: AgentSearchInput): unknown {
    if (!input || typeof input !== 'object' || typeof input.shareId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'An analysis input with a string shareId is required.');
    this.assertShare(input.shareId);
    this.validate(input);
    const sources = this.sources(input.sourceIds);
    const sessions = this.sessions(input.sessionIds);
    const events: LogEvent[] = [];
    for (const serverId of sources) {
      const wanted = sessions?.get(serverId) ?? this.shared.get(serverId)!;
      for (const event of this.store.exportEvents({ query: input.query, levels: input.levels, serverId, before: input.before, from: input.from, to: input.to }))
        if (wanted.has(event.sessionId ?? '*') && (!input.sessionId || input.sessionId === event.sessionId)) events.push(event);
    }
    events.sort((a, b) => a.id - b.id);
    const limited = events.slice(-10000);
    const analysis = analyzeEvents(limited, { from: input.from, to: input.to });
    return redactValue({ ...analysis, errorGroups: groupErrors(limited), patterns: findPatterns(limited, { from: input.from, to: input.to }), coverage: { matched: events.length, analyzed: limited.length, limited: events.length > limited.length } }, this.redaction);
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
  private encodeCursor(offset: number, before: number, key: string): string { return Buffer.from(JSON.stringify({ id: this.shareId, revision: this.revision, offset, before, key })).toString('base64url'); }
  private boundEvent(event: LogEvent): LogEvent {
    const bound = { ...event };
    if (bound.raw && bound.raw.length > 16 * 1024) { bound.raw = bound.raw.slice(0, 16 * 1024); bound.truncated = true; }
    if (bound.message && bound.message.length > 8 * 1024) { bound.message = bound.message.slice(0, 8 * 1024); bound.truncated = true; }
    return bound;
  }
  private decodeCursor(cursor: string | undefined, key: string): { offset: number; before?: number } {
    if (!cursor) return { offset: 0 };
    try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); if (value.id !== this.shareId || value.revision !== this.revision || value.key !== key) throw new Error(); return { offset: Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0, before: Number.isSafeInteger(value.before) ? value.before : undefined }; } catch { throw new AgentAccessError('SHARE_CHANGED', 'The search cursor is no longer valid.'); }
  }
}
