import { parseJobLog, type CiJob } from '../../core/ci-log';
import { parseLogLine } from '../../core/log-event';
import { termGroups } from '../../core/pushdown';
import { matchesQuery } from '../../core/query';
import { rowFilter } from '../../core/remote-query';
import type { Connector, FetchRequest, FetchResult, RemoteRecord } from './types';

/** The newest failed runs whose failed jobs are read in one search. */
export const MAX_RUNS = 10;
/** Job logs kept after they are read: a finished job's log never changes. */
const CACHED_JOBS = 50;

/** A finished run of a CI system: a GitHub Actions workflow run, or a GitLab pipeline. */
export interface CiRun {
  id: number;
  /** What changes when the run's jobs are run again, so its failed jobs are listed again. */
  attempt: number;
  number: number;
  workflow: string;
  branch?: string;
  sha?: string;
  conclusion?: string;
  url?: string;
  createdMs: number;
}

export const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Fields that come from where an event was captured, which a fetched line does not have yet. */
const CAPTURE_FIELDS = new Set(['id', 'serverId', 'server', 'sessionId']);

/**
 * Whether a fetched line matches the search, for a search whose terms the line alone decides; undefined when
 * every line is kept. The lines are checked again as they are captured.
 */
function searchFilter(query: string): ((record: RemoteRecord) => boolean) | undefined {
  const filter = rowFilter(query);
  if (!filter || filter.some((group) => group.some((token) => token.field && CAPTURE_FIELDS.has(token.field))))
    return undefined;
  const now = Date.now();
  const received = new Date(now);
  return (record) => matchesQuery(parseLogLine(record.line, 'remote', 0, received), filter, now);
}

/**
 * The runs of a CI system as logs. A search reads the jobs that failed in the
 * newest failed runs of the branch within its range, and turns each job's log
 * into events with their step, and an event per failed test. The system applies
 * no search terms, so every term is applied to the fetched lines.
 */
export abstract class CiConnector implements Connector {
  /** New runs are looked for at most this often, within the system's rate limit. */
  readonly tailPollMs = 30_000;
  private readonly jobs = new Map<number, RemoteRecord[]>();
  /** The failed jobs of a finished attempt, which never change. */
  private readonly attempts = new Map<string, CiJob[]>();

  /** The system, as the test result names it: `GitHub Actions`. */
  protected abstract readonly system: string;
  /** What the system calls a run: `run` or `pipeline`. */
  protected abstract readonly runNoun: string;
  /** The repository or project, as the connection names it. */
  protected abstract readonly where: string;
  /** The conclusions of a run, and of a job, that failed. */
  protected abstract readonly failed: ReadonlySet<string>;

  /** The repository's or project's full name, which also checks that it can be read. */
  protected abstract fullName(): Promise<string | undefined>;
  /** The branch whose runs are read, if any. */
  protected abstract branch(): Promise<string | undefined>;
  /** Finished runs of the branch in the range, newest first. */
  protected abstract runs(fromMs: number, toMs: number, signal?: AbortSignal, perPage?: number): Promise<CiRun[]>;
  /** The jobs of a run that failed. */
  protected abstract listFailedJobs(run: CiRun, signal?: AbortSignal): Promise<CiJob[]>;
  /** A job's whole log. */
  protected abstract readLog(job: CiJob, signal?: AbortSignal): Promise<string>;

  async test(): Promise<string> {
    const name = await this.fullName();
    const branch = await this.branch();
    const runs = await this.runs(Date.now() - 30 * 86400_000, Date.now(), undefined, 1);
    const latest = runs[0];
    return [
      `${this.system} · ${name ?? this.where}`,
      branch ? `branch ${branch}` : undefined,
      latest
        ? `latest ${this.runNoun} #${latest.number} ${latest.conclusion ?? 'in progress'}`
        : `no ${this.runNoun}s in the last 30 days`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  async preview(query: string): Promise<{ statement: string; local: string[] }> {
    const branch = await this.branch();
    return {
      statement: `The failed jobs of the newest ${MAX_RUNS} failed ${this.runNoun}s${branch ? ` on ${branch}` : ''} in ${this.where}`,
      local: termGroups(query)
        .flat()
        .map((term) => term.text),
    };
  }

  private async failedRuns(fromMs: number, toMs: number, signal?: AbortSignal): Promise<CiRun[]> {
    const runs = await this.runs(fromMs, toMs, signal);
    return runs.filter((run) => run.conclusion && this.failed.has(run.conclusion)).slice(0, MAX_RUNS);
  }

  private async failedJobs(run: CiRun, signal?: AbortSignal): Promise<CiJob[]> {
    const key = `${run.id}:${run.attempt}`;
    const known = this.attempts.get(key);
    if (known) return known;
    const jobs = await this.listFailedJobs(run, signal);
    if (this.attempts.size >= CACHED_JOBS) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, jobs);
    return jobs;
  }

  private async jobLog(job: CiJob, signal?: AbortSignal): Promise<RemoteRecord[]> {
    const cached = this.jobs.get(job.jobId);
    if (cached) return cached;
    const records = parseJobLog(await this.readLog(job, signal), job).map((record): RemoteRecord => {
      const timeMs = record.timestamp ? Date.parse(record.timestamp) : undefined;
      return { line: JSON.stringify({ ...record, service: job.job }), ...(timeMs ? { timeMs } : {}) };
    });
    if (this.jobs.size >= CACHED_JOBS) this.jobs.delete(this.jobs.keys().next().value!);
    this.jobs.set(job.jobId, records);
    return records;
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    const toMs = request.toMs ?? started;
    const fromMs = request.fromMs ?? toMs - 7 * 86400_000;
    const runs = await this.failedRuns(fromMs, toMs, signal);
    // The search terms are applied here, before the limit cuts the lines short.
    const keep = request.native === undefined ? searchFilter(request.query) : undefined;
    const records: RemoteRecord[] = [];
    let jobs = 0;
    for (const run of runs) {
      for (const job of await this.failedJobs(run, signal)) {
        jobs++;
        // A long job log has more lines than one call can take as arguments.
        for (const record of await this.jobLog(job, signal)) if (!keep || keep(record)) records.push(record);
      }
      if (records.length >= request.limit * 4) break;
    }
    records.sort((a, b) =>
      request.order === 'desc' ? (b.timeMs ?? 0) - (a.timeMs ?? 0) : (a.timeMs ?? 0) - (b.timeMs ?? 0),
    );
    const { statement, local } = await this.preview(request.query);
    const noun = (n: number) => `${this.runNoun}${n === 1 ? '' : 's'}`;
    return {
      records: records.slice(0, request.limit),
      ...(request.countTotal ? { total: records.length } : {}),
      pushed: [],
      local,
      statement: `${statement}: ${jobs} failed job${jobs === 1 ? '' : 's'} in ${runs.length} ${noun(runs.length)}`,
      elapsedMs: Date.now() - started,
    };
  }

  /** The jobs that failed in the range, most failing first, for the Service list. */
  async services(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ name: string; count?: number }[]> {
    const counts = new Map<string, number>();
    for (const run of await this.failedRuns(fromMs, toMs, signal))
      for (const job of await this.failedJobs(run, signal)) counts.set(job.job, (counts.get(job.job) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => ({ name }));
  }

  async dispose(): Promise<void> {
    this.jobs.clear();
    this.attempts.clear();
  }
}
