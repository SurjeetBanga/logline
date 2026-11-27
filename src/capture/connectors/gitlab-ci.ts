import type { CiJob } from '../../core/ci-log';
import type { GitLabCiConnection } from '../../core/connections';
import { CiConnector, count, safeJson, text, type CiRun } from './ci';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';

/** A pipeline or job that ended this way has jobs worth reading. */
const FAILED = new Set(['failed', 'canceled']);

function problem(status: number, headers: Headers, body: string, project: string, token: boolean): Error {
  const json = object(safeJson(body));
  const detail = (text(json.message) ?? text(json.error_description) ?? text(json.error) ?? body).trim().slice(0, 300);
  if (status === 401)
    return new Error(
      'GitLab refused the request (401): check that the access token has the read_api scope and has not expired.',
    );
  if (status === 429) {
    const reset = Number(headers.get('ratelimit-reset')) * 1000;
    const wait = Number(headers.get('retry-after')) * 1000 || (reset ? Math.max(1000, reset - Date.now()) : 60_000);
    return retryAfter(`GitLab's rate limit was reached${detail ? `: ${detail}` : ''}.`, wait);
  }
  if (status === 403) return new Error(`GitLab refused the request (403${detail ? `: ${detail}` : ''}).`);
  if (status === 404)
    return new Error(
      token
        ? `GitLab has no project ${project} that this token can read, or CI/CD is off for it.`
        : `GitLab has no public project ${project}. For a private project, add an access token with the read_api scope.`,
    );
  return new Error(`GitLab answered ${status}${detail ? `: ${detail}` : ''}.`);
}

/** The CI pipelines of a GitLab project as logs: the jobs that failed in its newest failed pipelines. */
export class GitLabCiConnector extends CiConnector {
  protected readonly system = 'GitLab CI';
  protected readonly runNoun = 'pipeline';
  protected readonly failed = FAILED;
  protected readonly where: string;
  private readonly base: string;

  constructor(
    readonly connection: GitLabCiConnection,
    /** A personal, group, or project access token; a public project needs none. */
    private readonly token: string | undefined,
    /** The branch checked out in the workspace, for a connection that names none. */
    private readonly checkedOut: () => Promise<string | undefined>,
    private readonly timeoutMs: () => number,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {
    super();
    this.where = connection.project;
    this.base = `${connection.url.replace(/\/+$/, '')}/api/v4`;
  }

  private async request(
    path: string,
    signal?: AbortSignal,
    accept = 'application/json',
  ): Promise<{ json?: Json; text: string }> {
    const answer = await requestJson({
      service: `GitLab at ${new URL(this.base).host}`,
      url: `${this.base}${path}`,
      method: 'GET',
      headers: { accept, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      timeoutMs: this.timeoutMs(),
      signal,
      fetcher: this.fetcher,
    });
    if (!answer.ok)
      throw problem(answer.status, answer.headers, answer.text, this.connection.project, this.token !== undefined);
    return { ...(answer.json ? { json: answer.json } : {}), text: answer.text };
  }

  /** A list GitLab answers with, which `requestJson` reads as no object. */
  private async list(path: string, signal?: AbortSignal): Promise<unknown[]> {
    const { text: body } = await this.request(path, signal);
    const value = safeJson(body);
    if (!Array.isArray(value)) throw new Error('GitLab returned a response that is not a list.');
    return value;
  }

  private projectPath(): string {
    return `/projects/${encodeURIComponent(this.connection.project)}`;
  }

  protected async branch(): Promise<string | undefined> {
    return this.connection.branch ?? (await this.checkedOut());
  }

  protected async fullName(): Promise<string | undefined> {
    const { json } = await this.request(this.projectPath());
    return text(json?.path_with_namespace);
  }

  /** Finished pipelines of the branch updated in the range, newest first. */
  protected async runs(fromMs: number, toMs: number, signal?: AbortSignal, perPage = 50): Promise<CiRun[]> {
    const branch = await this.branch();
    const params = new URLSearchParams({
      per_page: String(perPage),
      scope: 'finished',
      // A pipeline is updated when it finishes, so this is when its logs were written.
      updated_after: new Date(fromMs).toISOString(),
      updated_before: new Date(toMs).toISOString(),
      order_by: 'id',
      sort: 'desc',
      ...(branch ? { ref: branch } : {}),
    });
    const list = await this.list(`${this.projectPath()}/pipelines?${params}`, signal);
    return list
      .map((item): CiRun => {
        const pipeline = object(item);
        return {
          id: count(pipeline.id),
          // A job run again changes its pipeline: it is listed again once the pipeline is updated.
          attempt: Date.parse(text(pipeline.updated_at) ?? '') || 0,
          number: count(pipeline.iid) || count(pipeline.id),
          workflow: text(pipeline.name) ?? text(pipeline.source) ?? 'pipeline',
          ...(text(pipeline.ref) ? { branch: text(pipeline.ref) } : {}),
          ...(text(pipeline.sha) ? { sha: text(pipeline.sha) } : {}),
          ...(text(pipeline.status) ? { conclusion: text(pipeline.status) } : {}),
          ...(text(pipeline.web_url) ? { url: text(pipeline.web_url) } : {}),
          createdMs: Date.parse(text(pipeline.created_at) ?? '') || 0,
        };
      })
      .filter((run) => run.id > 0)
      .sort((a, b) => b.createdMs - a.createdMs);
  }

  /** The jobs of a pipeline that failed, without those allowed to fail and those run again since. */
  protected async listFailedJobs(run: CiRun, signal?: AbortSignal): Promise<CiJob[]> {
    const list = await this.list(
      `${this.projectPath()}/pipelines/${run.id}/jobs?per_page=100&scope[]=failed&scope[]=canceled`,
      signal,
    );
    return list.flatMap((item) => {
      const job = object(item);
      const conclusion = text(job.status);
      if (!conclusion || !FAILED.has(conclusion) || job.allow_failure === true) return [];
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
          ...(text(job.web_url) ? { url: text(job.web_url) } : run.url ? { url: run.url } : {}),
          format: 'gitlab',
          checkout: this.connection.project,
        },
      ];
    });
  }

  protected async readLog(job: CiJob, signal?: AbortSignal): Promise<string> {
    return (await this.request(`${this.projectPath()}/jobs/${job.jobId}/trace`, signal, 'text/plain, */*')).text;
  }
}
