import { randomBytes } from 'node:crypto';
import { matchesQuery, type ParsedQuery } from '../core/query';
import { rowFilter } from '../core/remote-query';
import type { Settings } from '../core/settings';
import type { LogEvent, SessionSummary } from '../core/types';
import { errorText, type FetchResult, type RemoteConnector, type RemoteRecord } from './connectors/types';
import type { Ingestion } from './ingestion';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';

/** A connection as runs see it: the source its rows land in and what fetches them. */
export interface RemoteTarget {
  id: string;
  sourceId: string;
  label: string;
  connector: RemoteConnector;
  /** The setting that limits the rows one search or tail read fetches, when not `connectionMaxRows`. */
  maxRowsSetting?: string;
}

/** What the latest fetch from a connection did, for the Logs panel's result line. */
export interface RemoteRunInfo {
  sessionId: string;
  kind: 'fetch' | 'sql' | 'tail';
  running: boolean;
  /** Rows the database returned, and how many matched the full search. */
  fetched: number;
  kept: number;
  /** Matching rows in the range, when the limit cut the result short. */
  total?: number;
  /** How long the store took to answer, and how long Logline took to show what it returned. */
  elapsedMs?: number;
  processMs?: number;
  /** How long after the search started its first rows were shown, when they came before the rest. */
  firstMs?: number;
  local: string[];
  statement?: string;
  /** What a tail follows, as typed. */
  query?: string;
  /** Whether a tail's query is in the store's own syntax. */
  native?: boolean;
  error?: string;
  at: number;
}

export interface FetchOptions {
  query: string;
  fromMs?: number;
  toMs?: number;
  /** Run this SQL instead of searching the mapped table. */
  sql?: string;
  /** A query in the store's own syntax, such as from a link, instead of `query`. */
  native?: string;
  /** At most this many rows, fewer than `connectionMaxRows`. */
  limit?: number;
  /** What the run is called in the run picker. */
  title: string;
  /** Called with the new run's session id as soon as it exists. */
  started?(sessionId: string): void;
  /** Sees the fetched records before they are filtered and ingested. */
  inspect?(records: RemoteRecord[]): void;
}

interface Run {
  record: SessionSummary;
  target: RemoteTarget;
  info: RemoteRunInfo;
  abort: AbortController;
  stopped: boolean;
  // Tails only.
  query?: string;
  /** A query in the store's own syntax, followed instead of `query`. */
  native?: string;
  watermark?: number;
  /**
   * Lines already ingested that the next read can return again, with their
   * times: those at the watermark, and those within the store's indexing lag.
   */
  seen?: Map<string, number>;
  /** How far behind the newest row seen each recent read's new rows were, newest last. */
  late?: number[];
  /** Reads after the first. */
  reads?: number;
  /** Where the next read starts when the last one was cut short by the limit. */
  catchUp?: number;
  /** No read before this time: the store's pace, or how long it said to wait. */
  resumeAt?: number;
  poll?: ReturnType<typeof setInterval>;
  pumping?: Promise<void>;
}

const CHUNK = 500;
const TAIL_START_ROWS = 200;
// A store that indexes late is read back over twice the lateness of the last reads, at least LAG_FLOOR_MS,
// once LAG_READS reads have shown it; until then, over all of the store's lag. Every LAG_FULL_EVERY reads go
// back over all of it again: a row later than the shorter look-back is seen only then, and widens it.
const LAG_READS = 5;
const LAG_HISTORY = 20;
const LAG_FLOOR_MS = 15000;
const LAG_FULL_EVERY = 10;
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fetches rows from connections into runs: a fetch is one run with the rows
 * that matched, a tail is a run that keeps reading rows newer than the last
 * one it read. Rows enter through the shared ingestion path oldest first and
 * are not written to disk.
 */
export class RemoteSource {
  private readonly runs = new Map<string, Run>();
  private readonly latest = new Map<string, RemoteRunInfo>();

  constructor(
    private readonly config: Settings,
    private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion,
    private readonly state: RuntimeState,
  ) {}

  get active(): number {
    return this.runs.size;
  }

  /** The latest fetch or tail of a connection. */
  last(connectionId: string): RemoteRunInfo | undefined {
    return this.latest.get(connectionId);
  }

  tailing(connectionId: string): boolean {
    return [...this.runs.values()].some((run) => run.target.id === connectionId && run.info.kind === 'tail');
  }

  /** What a connection's tail follows, or undefined while none runs. */
  tailOf(connectionId: string): { query: string; native: boolean } | undefined {
    const run = [...this.runs.values()].find((one) => one.target.id === connectionId && one.info.kind === 'tail');
    return run && { query: run.native ?? run.query!, native: run.native !== undefined };
  }

  private limit(target: RemoteTarget): number {
    return target.maxRowsSetting
      ? this.config.get(target.maxRowsSetting, 1000)
      : this.config.get('connectionMaxRows', 5000);
  }

  private start(target: RemoteTarget, kind: RemoteRunInfo['kind'], title: string): Run {
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'),
      serverId: target.sourceId,
      server: target.label,
      status: 'running',
      startedAt: Date.now(),
      events: 0,
      sourceKind: 'remote',
      owned: true,
      canStop: true,
      captureComplete: false,
      command: title,
    };
    const info: RemoteRunInfo = {
      sessionId: record.id,
      kind,
      running: true,
      fetched: 0,
      kept: 0,
      local: [],
      at: record.startedAt,
    };
    const run: Run = { record, target, info, abort: new AbortController(), stopped: false };
    this.registry.records.set(record.id, record);
    this.runs.set(record.id, run);
    this.latest.set(target.id, info);
    return run;
  }

  /** Fetch the newest rows that match a search (or a typed query) into a new run. */
  async fetch(target: RemoteTarget, options: FetchOptions): Promise<RemoteRunInfo> {
    const run = this.start(target, options.sql === undefined ? 'fetch' : 'sql', options.title);
    this.state.status = `Fetching from ${target.label}…`;
    this.state.notify();
    options.started?.(run.record.id);
    const started = Date.now();
    const filter = options.sql === undefined && options.native === undefined ? rowFilter(options.query) : undefined;
    // The first rows of a store that reads in pages are shown while it reads the rest.
    let early: Promise<void> | undefined;
    const firstPage = (records: RemoteRecord[]) => {
      if (run.stopped) return;
      run.info.firstMs = Date.now() - started;
      run.info.fetched = records.length;
      early = this.ingest(run, [...records].reverse(), filter);
    };
    // The rows shown early leave once the search ends: the whole result takes their place, oldest first so the
    // run stays in order, and a failed search keeps none of them.
    const dropEarly = async () => {
      if (!early) return;
      await early;
      early = undefined;
      if (run.stopped) return;
      this.ingestion.store.removeSessions(new Set([run.record.id]));
      run.record.events = 0;
      run.info.kept = 0;
      this.state.invalidate();
    };
    try {
      const connector = target.connector;
      let result: FetchResult;
      if (options.sql !== undefined) {
        if (!connector.runSql) throw new Error(`${target.label} does not run SQL.`);
        result = await connector.runSql(options.sql, this.limit(target), run.abort.signal);
      } else
        result = await connector.fetchLogs(
          {
            query: options.query,
            ...(options.native !== undefined ? { native: options.native } : {}),
            fromMs: options.fromMs,
            toMs: options.toMs,
            limit: Math.min(options.limit ?? Infinity, this.limit(target)),
            order: 'desc',
            countTotal: true,
            firstPage,
          },
          run.abort.signal,
        );
      if (run.stopped) return run.info;
      await dropEarly();
      if (run.stopped) return run.info;
      options.inspect?.(result.records);
      Object.assign(run.info, {
        fetched: result.records.length,
        total: result.total,
        elapsedMs: result.elapsedMs,
        local: result.local,
        statement: result.statement,
      });
      // A search returns the newest rows first; they enter oldest first. Typed SQL keeps its own order.
      const records = options.sql === undefined ? [...result.records].reverse() : result.records;
      await this.timed(run, () => this.ingest(run, records, filter));
      this.finish(run, run.stopped ? 'stopped' : `${run.info.kept.toLocaleString()} rows`);
      this.state.status = `Fetched ${run.info.kept.toLocaleString()} rows from ${target.label}`;
    } catch (error) {
      if (!run.stopped) {
        await dropEarly();
        run.info.error = errorText(error);
        this.finish(run, 'failed', run.info.error);
        this.state.status = `${target.label}: ${run.info.error}`;
      }
    }
    this.state.notify();
    return run.info;
  }

  /** Show the newest matching rows, then keep reading rows as they are added; `native` is in the store's syntax. */
  tail(target: RemoteTarget, query: string, title: string, native?: string): string {
    const run = this.start(target, 'tail', title);
    run.query = query;
    run.info.query = native ?? query;
    if (native !== undefined) run.native = native;
    run.info.native = native !== undefined;
    run.seen = new Map();
    // A store that limits searches is read less often than every poll; see pump.
    run.poll = setInterval(
      () => {
        void this.pump(run);
      },
      this.config.get('connectionPollSeconds', 2) * 1000,
    );
    run.poll.unref?.();
    this.state.status = `Tailing ${target.label}`;
    this.state.notify();
    void this.pump(run);
    return run.record.id;
  }

  // Reads are serialized per tail; a poll during a read waits for the next one.
  private pump(run: Run): Promise<void> {
    if (run.stopped || run.pumping) return run.pumping ?? Promise.resolve();
    if (run.resumeAt !== undefined && Date.now() < run.resumeAt) return Promise.resolve();
    // The store's pace is asked before each read, as it can change with what the store reports.
    const paceMs = run.target.connector.tailPollMs;
    run.resumeAt = paceMs ? Date.now() + paceMs : undefined;
    run.pumping = (async () => {
      try {
        await this.readTail(run);
        if (run.record.captureStatus === 'interrupted') {
          run.record.captureStatus = 'streaming';
          run.record.captureReason = undefined;
          run.info.error = undefined;
        }
      } catch (error) {
        if (run.stopped) return;
        // A tail outlives a failed read: the database may be restarting or locked.
        const retryMs = (error as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
        if (typeof retryMs === 'number' && retryMs > 0) run.resumeAt = Date.now() + retryMs;
        run.info.error = errorText(error);
        run.record.captureStatus = 'interrupted';
        run.record.captureReason = run.info.error;
        this.state.status = `${run.target.label}: ${run.info.error}`;
        this.state.notify();
      } finally {
        run.pumping = undefined;
      }
    })();
    return run.pumping;
  }

  private async readTail(run: Run): Promise<void> {
    const first = run.watermark === undefined;
    // A store that makes logs searchable late is read from further back.
    const lag = this.lagMs(run);
    const fromMs = run.catchUp ?? run.watermark! - lag;
    const limit = this.limit(run.target);
    const native = run.native !== undefined ? { native: run.native } : {};
    const result = await run.target.connector.fetchLogs(
      first
        ? { query: run.query!, ...native, limit: TAIL_START_ROWS, order: 'desc' }
        : { query: run.query!, ...native, fromMs, limit, order: 'asc' },
      run.abort.signal,
    );
    if (run.stopped) return;
    const ordered = first ? [...result.records].reverse() : result.records;
    // Reads overlap at the watermark time and over the lag; only rows not shown yet are new.
    const seen = run.seen!;
    const fresh = ordered.filter((record) => !seen.has(record.line));
    if (!first) {
      // How late the store made this read's new rows searchable, behind the newest row seen before it.
      let late = 0;
      for (const record of fresh)
        if (record.timeMs !== undefined) late = Math.max(late, run.watermark! - record.timeMs);
      (run.late ??= []).push(late);
      if (run.late.length > LAG_HISTORY) run.late.shift();
      run.reads = (run.reads ?? 0) + 1;
    }
    let last: number | undefined;
    for (const record of ordered) {
      if (record.timeMs === undefined) continue;
      last = Math.max(last ?? record.timeMs, record.timeMs);
      run.watermark = Math.max(run.watermark ?? record.timeMs, record.timeMs);
      seen.set(record.line, record.timeMs);
    }
    // A full read may have stopped short of newer rows, even ones already
    // shown: the next read starts at its last row instead of going back over
    // the lag. Rows past the limit at one time cannot be reached; they are skipped.
    run.catchUp = undefined;
    if (!first && ordered.length >= limit) {
      run.catchUp = last !== undefined && last > fromMs ? last : fromMs + 1;
      if (run.catchUp === fromMs + 1)
        this.state.status = `${run.target.label}: more than ${limit.toLocaleString()} rows share one time; some were skipped`;
    }
    // An empty table starts the tail now, so its first rows are not read as history.
    if (first && run.watermark === undefined) run.watermark = Date.now();
    const keepFrom = Math.min(run.watermark! - lag, run.catchUp ?? Infinity);
    for (const [line, time] of seen) if (time < keepFrom) seen.delete(line);
    Object.assign(run.info, {
      fetched: run.info.fetched + fresh.length,
      elapsedMs: result.elapsedMs,
      local: result.local,
      statement: result.statement,
      at: Date.now(),
    });
    await this.ingest(run, fresh, run.native === undefined ? rowFilter(run.query!) : undefined);
  }

  /** How far back a tail's next read starts: what the store needs, judged from how late its rows have been. */
  private lagMs(run: Run): number {
    const most = run.target.connector.tailLagMs ?? 0;
    if (!most || (run.late?.length ?? 0) < LAG_READS || (run.reads ?? 0) % LAG_FULL_EVERY === LAG_FULL_EVERY - 1)
      return most;
    return Math.min(most, Math.max(LAG_FLOOR_MS, 2 * Math.max(...run.late!)));
  }

  /** Ingest, adding the time it took to the run's processing time. */
  private async timed(run: Run, ingest: () => Promise<void>): Promise<void> {
    const started = Date.now();
    await ingest();
    run.info.processMs = (run.info.processMs ?? 0) + Date.now() - started;
  }

  private async ingest(run: Run, records: RemoteRecord[], filter: ParsedQuery | undefined): Promise<void> {
    const now = Date.now();
    const accept = filter ? (event: LogEvent) => matchesQuery(event, filter, now) : undefined;
    const { record, target } = run;
    for (let start = 0; start < records.length; start += CHUNK) {
      if (start) await yieldTurn();
      if (run.stopped) return;
      for (const { line } of records.slice(start, start + CHUNK)) {
        const event = this.ingestion.accept(line, 'remote', {
          serverId: target.sourceId,
          server: target.label,
          sessionId: record.id,
          accept,
        });
        if (!event) continue;
        record.events++;
        run.info.kept++;
      }
      this.state.notify();
    }
  }

  private finish(run: Run, reason: string, error?: string): void {
    if (!this.runs.has(run.record.id)) return;
    clearInterval(run.poll);
    this.runs.delete(run.record.id);
    run.info.running = false;
    Object.assign(run.record, {
      status: error ? 'failed' : 'exited',
      endedAt: Date.now(),
      captureComplete: true,
      exitReason: reason,
      ...(error ? { error, captureReason: error } : {}),
    });
    this.registry.pruneSessionRegistry();
  }

  private halt(run: Run): void {
    run.stopped = true;
    run.abort.abort();
    this.finish(run, run.info.kind === 'tail' ? 'stopped tailing' : 'stopped');
  }

  stopSessionById(id: string): void {
    const run = this.runs.get(id);
    if (run) this.halt(run);
    this.state.notify();
  }

  stopServer(serverId: string): void {
    for (const run of [...this.runs.values()]) if (run.record.serverId === serverId) this.halt(run);
    this.state.notify();
  }

  /** Forget the results of finished runs, whose rows Clear logs removed; running tails keep theirs. */
  clearResults(): void {
    for (const [id, info] of this.latest) if (!info.running) this.latest.delete(id);
  }

  /**
   * Stop a connection's searches that are still running and drop the rows they showed, since a newer search
   * replaces them. Tails go on.
   */
  cancelFetches(connectionId: string): void {
    const replaced = new Set<string>();
    for (const run of [...this.runs.values()])
      if (run.target.id === connectionId && run.info.kind === 'fetch') {
        this.halt(run);
        replaced.add(run.record.id);
      }
    if (!replaced.size) return;
    this.ingestion.store.removeSessions(replaced);
    for (const id of replaced) this.registry.records.delete(id);
    this.state.invalidate();
  }

  /** A finished run was removed: its connection no longer reports it as the latest. */
  forgetRun(sessionId: string): void {
    for (const [id, info] of this.latest) if (info.sessionId === sessionId && !info.running) this.latest.delete(id);
  }

  stopTails(connectionId: string): void {
    for (const run of [...this.runs.values()])
      if (run.target.id === connectionId && run.info.kind === 'tail') this.halt(run);
    this.state.notify();
  }

  /** Stop every fetch and tail of a connection, such as one removed from settings. */
  stopConnection(connectionId: string): void {
    for (const run of [...this.runs.values()]) if (run.target.id === connectionId) this.halt(run);
    this.latest.delete(connectionId);
    this.state.notify();
  }

  stop(): void {
    for (const run of [...this.runs.values()]) this.halt(run);
  }

  async dispose(): Promise<void> {
    const pending = [...this.runs.values()].map((run) => run.pumping);
    this.stop();
    await Promise.all(pending);
  }
}
