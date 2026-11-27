import { parseJobLog, type CiJob } from '../../core/ci-log';
import type { GitHubActionsConnection } from '../../core/connections';
import { parseLogLine } from '../../core/log-event';
import { termGroups } from '../../core/pushdown';
import { matchesQuery } from '../../core/query';
import { rowFilter } from '../../core/remote-query';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';
import type { Connector, FetchRequest, FetchResult, RemoteRecord } from './types';

export const GITHUB_API = 'https://api.github.com';
/** The newest failed runs whose failed jobs are read in one search. */
export const MAX_RUNS = 10;
/** Job logs kept after they are read: a finished job's log never changes. */
const CACHED_JOBS = 50;
/** A run that ended this way has jobs worth reading. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);

export interface GitHubAuth {
  /** A token for the GitHub account VS Code is signed in to, asking to sign in the first time. */
  token(): Promise<string | undefined>;
  /** The branch checked out in the workspace, for a connection that names none. */
  branch(): Promise<string | undefined>;
}

interface Run {
  id: number;
  /** A run run again is a new attempt, with jobs of its own. */
  attempt: number;
  number: number;
  workflow: string;
  branch?: string;
  sha?: string;
  conclusion?: string;
  url?: string;
  createdMs: number;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function problem(status: number, headers: Headers, body: string, repository: string): Error {
  const detail = (text(object(safeJson(body)).message) ?? body).trim().slice(0, 300);
  if (status === 401) return new Error('GitHub refused the sign-in (401). Sign in to GitHub again in VS Code.');
  const remaining = headers.get('x-ratelimit-remaining');
  if (status === 429 || (status === 403 && remaining === '0')) {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
    const wait = Number(headers.get('retry-after')) * 1000 || (reset ? Math.max(1000, reset - Date.now()) : 60_000);
    return retryAfter(`GitHub's rate limit was reached${detail ? `: ${detail}` : ''}.`, wait);
  }
  if (status === 403) return new Error(`GitHub refused the request (403${detail ? `: ${detail}` : ''}).`);
  if (status === 404)
    return new Error(`GitHub has no repository ${repository} that this account can read, or Actions is off for it.`);
  return new Error(`GitHub answered ${status}${detail ? `: ${detail}` : ''}.`);
}

const searchTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

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

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * The CI runs of a GitHub repository as logs. A search reads the jobs that
 * failed in the newest failed runs of the branch within its range, and turns
 * each job's log into events with their step, and an event per failed test.
 * Every search term is applied to the fetched lines.
 */
export class GitHubActionsConnector implements Connector {
  /** New runs are looked for at most this often, within GitHub's rate limit. */
  readonly tailPollMs = 30_000;
  private readonly base: string;
  private readonly jobs = new Map<number, RemoteRecord[]>();
  /** The failed jobs of a finished attempt, which never change. */
  private readonly attempts = new Map<string, CiJob[]>();

  constructor(
    readonly connection: GitHubActionsConnection,
    private readonly auth: GitHubAuth,
    private readonly timeoutMs: () => number,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {
    this.base = (connection.endpoint ?? GITHUB_API).replace(/\/+$/, '');
  }

  private async request(path: string, signal?: AbortSignal): Promise<{ json?: Json; text: string }> {
    const token = await this.auth.token();
    if (!token) throw new Error('Sign in to GitHub in VS Code to read the runs of this repository.');
    const answer = await requestJson({
      service: `GitHub at ${new URL(this.base).host}`,
      url: `${this.base}${path}`,
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      timeoutMs: this.timeoutMs(),
      signal,
      fetcher: this.fetcher,
    });
    if (!answer.ok) throw problem(answer.status, answer.headers, answer.text, this.connection.repository);
    return { ...(answer.json ? { json: answer.json } : {}), text: answer.text };
  }

  private async json(path: string, signal?: AbortSignal): Promise<Json> {
    const { json } = await this.request(path, signal);
    if (!json) throw new Error('GitHub returned a response that is not JSON.');
    return json;
  }

  private repo(): string {
    return this.connection.repository
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
  }

  private async branch(): Promise<string | undefined> {
    return this.connection.branch ?? (await this.auth.branch());
  }

  async test(): Promise<string> {
    const repository = await this.json(`/repos/${this.repo()}`);
    const branch = await this.branch();
    const runs = await this.runs(Date.now() - 30 * 86400_000, Date.now(), undefined, 1);
    const latest = runs[0];
    return [
      `GitHub Actions · ${text(repository.full_name) ?? this.connection.repository}`,
      branch ? `branch ${branch}` : undefined,
      latest ? `latest run #${latest.number} ${latest.conclusion ?? 'in progress'}` : 'no runs in the last 30 days',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  async preview(query: string): Promise<{ statement: string; local: string[] }> {
    const branch = await this.branch();
    return {
      statement: `The failed jobs of the newest ${MAX_RUNS} failed runs${branch ? ` on ${branch}` : ''} in ${this.connection.repository}`,
      local: termGroups(query)
        .flat()
        .map((term) => term.text),
    };
  }

  /** Completed runs of the branch created in the range, newest first. */
  private async runs(fromMs: number, toMs: number, signal?: AbortSignal, perPage = 50): Promise<Run[]> {
    const branch = await this.branch();
    const params = new URLSearchParams({
      per_page: String(perPage),
      status: 'completed',
      // GitHub's search syntax gives times to the second: YYYY-MM-DDTHH:MM:SSZ.
      created: `${searchTime(fromMs)}..${searchTime(toMs)}`,
      ...(branch ? { branch } : {}),
    });
    const answer = await this.json(`/repos/${this.repo()}/actions/runs?${params}`, signal);
    const list: unknown[] = Array.isArray(answer.workflow_runs) ? answer.workflow_runs : [];
    return list
      .map((item): Run => {
        const run = object(item);
        return {
          id: count(run.id),
          attempt: count(run.run_attempt) || 1,
          number: count(run.run_number),
          workflow: text(run.name) ?? text(object(run.workflow).name) ?? 'workflow',
          ...(text(run.head_branch) ? { branch: text(run.head_branch) } : {}),
          ...(text(run.head_sha) ? { sha: text(run.head_sha) } : {}),
          ...(text(run.conclusion) ? { conclusion: text(run.conclusion) } : {}),
          ...(text(run.html_url) ? { url: text(run.html_url) } : {}),
          createdMs: Date.parse(text(run.created_at) ?? '') || 0,
        };
      })
      .filter((run) => run.id > 0)
      .sort((a, b) => b.createdMs - a.createdMs);
  }

  /** The jobs of a run that failed, as GitHub lists them for its latest attempt. */
  private async failedJobs(run: Run, signal?: AbortSignal): Promise<CiJob[]> {
    const key = `${run.id}:${run.attempt}`;
    const known = this.attempts.get(key);
    if (known) return known;
    const jobs = await this.listFailedJobs(run, signal);
    if (this.attempts.size >= CACHED_JOBS) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, jobs);
    return jobs;
  }

  private async listFailedJobs(run: Run, signal?: AbortSignal): Promise<CiJob[]> {
    const answer = await this.json(
      `/repos/${this.repo()}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`,
      signal,
    );
    const list: unknown[] = Array.isArray(answer.jobs) ? answer.jobs : [];
    return list.flatMap((item) => {
      const job = object(item);
      const conclusion = text(job.conclusion);
      if (!conclusion || !FAILED.has(conclusion)) return [];
      return [
        {
          run: run.number,
          runId: run.id,
          workflow: run.workflow,
          job: text(job.name) ?? 'job',
          jobId: count(job.id),
          ...(run.branch ? { branch: run.branch } : {}),
          ...(run.sha ? { sha: run.sha } : {}),
          conclusion,
          ...(text(job.html_url) ? { url: text(job.html_url) } : run.url ? { url: run.url } : {}),
        },
      ];
    });
  }

  private async jobLog(job: CiJob, signal?: AbortSignal): Promise<RemoteRecord[]> {
    const cached = this.jobs.get(job.jobId);
    if (cached) return cached;
    // GitHub answers with a redirect to the log's file, which fetch follows without the token.
    const { text: log } = await this.request(`/repos/${this.repo()}/actions/jobs/${job.jobId}/logs`, signal);
    const records = parseJobLog(log, job).map((record): RemoteRecord => {
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
    const runs = (await this.runs(fromMs, toMs, signal)).filter((run) => run.conclusion && FAILED.has(run.conclusion));
    // GitHub applies no search terms, so they are applied here, before the limit cuts the lines short.
    const keep = request.native === undefined ? searchFilter(request.query) : undefined;
    const records: RemoteRecord[] = [];
    let jobs = 0;
    for (const run of runs.slice(0, MAX_RUNS)) {
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
    const used = Math.min(runs.length, MAX_RUNS);
    return {
      records: records.slice(0, request.limit),
      ...(request.countTotal ? { total: records.length } : {}),
      pushed: [],
      local,
      statement: `${statement}: ${jobs} failed job${jobs === 1 ? '' : 's'} in ${used} run${used === 1 ? '' : 's'}`,
      elapsedMs: Date.now() - started,
    };
  }

  /** The jobs that failed in the range, most lines first, for the Service list. */
  async services(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ name: string; count?: number }[]> {
    const counts = new Map<string, number>();
    const runs = (await this.runs(fromMs, toMs, signal)).filter((run) => run.conclusion && FAILED.has(run.conclusion));
    for (const run of runs.slice(0, MAX_RUNS))
      for (const job of await this.failedJobs(run, signal)) counts.set(job.job, (counts.get(job.job) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => ({ name }));
  }

  async dispose(): Promise<void> {
    this.jobs.clear();
    this.attempts.clear();
  }
}
