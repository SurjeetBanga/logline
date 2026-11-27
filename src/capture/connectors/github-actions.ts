import type { CiJob } from '../../core/ci-log';
import type { GitHubActionsConnection } from '../../core/connections';
import { CiConnector, count, safeJson, text, type CiRun } from './ci';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';

export const GITHUB_API = 'https://api.github.com';
/** A run or job that ended this way has jobs worth reading. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);

export interface GitHubAuth {
  /** A token for the GitHub account VS Code is signed in to, asking to sign in the first time. */
  token(): Promise<string | undefined>;
  /** The branch checked out in the workspace, for a connection that names none. */
  branch(): Promise<string | undefined>;
}

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

/** The CI runs of a GitHub repository as logs: the jobs that failed in its newest failed workflow runs. */
export class GitHubActionsConnector extends CiConnector {
  protected readonly system = 'GitHub Actions';
  protected readonly runNoun = 'run';
  protected readonly failed = FAILED;
  protected readonly where: string;
  private readonly base: string;

  constructor(
    readonly connection: GitHubActionsConnection,
    private readonly auth: GitHubAuth,
    private readonly timeoutMs: () => number,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {
    super();
    this.where = connection.repository;
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

  protected async branch(): Promise<string | undefined> {
    return this.connection.branch ?? (await this.auth.branch());
  }

  protected async fullName(): Promise<string | undefined> {
    return text((await this.json(`/repos/${this.repo()}`)).full_name);
  }

  /** Completed runs of the branch created in the range, newest first. */
  protected async runs(fromMs: number, toMs: number, signal?: AbortSignal, perPage = 50): Promise<CiRun[]> {
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
      .map((item): CiRun => {
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
  protected async listFailedJobs(run: CiRun, signal?: AbortSignal): Promise<CiJob[]> {
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

  protected async readLog(job: CiJob, signal?: AbortSignal): Promise<string> {
    // GitHub answers with a redirect to the log's file, which fetch follows without the token.
    return (await this.request(`/repos/${this.repo()}/actions/jobs/${job.jobId}/logs`, signal)).text;
  }
}
