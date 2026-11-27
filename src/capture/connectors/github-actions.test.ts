import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitHubActionsConnection } from '../../core/connections';
import { GitHubActionsConnector, type GitHubAuth } from './github-actions';

const TOKEN = ['gho', 'x'.repeat(10)].join('_');
const connection = (extra: Partial<GitHubActionsConnection> = {}): GitHubActionsConnection => ({
  id: 'ci',
  label: 'ci',
  type: 'github-actions',
  repository: 'o/r',
  ...extra,
});
const auth = (token: string | undefined = TOKEN, branch: string | undefined = 'feat'): GitHubAuth => ({
  token: async () => token,
  branch: async () => branch,
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fake(overrides: (url: string) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  let attempt = 1;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const over = overrides(url);
    if (over) return over;
    const path = new URL(url).pathname;
    if (path === '/repos/o/r') return json({ full_name: 'o/r' });
    if (path === '/repos/o/r/actions/runs')
      return json({
        workflow_runs: [
          {
            id: 1,
            run_attempt: attempt,
            run_number: 5,
            name: 'CI',
            head_branch: 'feat',
            head_sha: 'abcdef123456',
            conclusion: 'failure',
            created_at: '2026-11-14T08:00:00Z',
          },
          { id: 2, run_number: 4, name: 'CI', conclusion: 'success', created_at: '2026-11-14T07:00:00Z' },
        ],
      });
    if (path === '/repos/o/r/actions/runs/1/jobs')
      return json({
        jobs: [
          { id: 10, name: 'unit', conclusion: 'failure', html_url: 'https://github.com/o/r/job/10' },
          { id: 11, name: 'lint', conclusion: 'success' },
          { id: 12, name: 'e2e', conclusion: 'cancelled' },
        ],
      });
    if (path.endsWith('/logs'))
      return new Response(`2026-11-14T08:00:03Z one\n2026-11-14T08:00:01Z ##[error]bad\n2026-11-14T08:00:02Z two`, {
        status: 200,
      });
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls, rerun: () => attempt++ };
}

const range = { fromMs: Date.parse('2026-11-01T00:00:00Z'), toMs: Date.parse('2026-11-30T00:00:00Z') };
const make = (f: ReturnType<typeof fake>, conn = connection(), a = auth()) =>
  new GitHubActionsConnector(conn, a, () => 5000, f.fetcher);

test('test() reports repository, branch and latest run', async () => {
  const f = fake();
  assert.equal(await make(f).test(), 'GitHub Actions · o/r · branch feat · latest run #5 failure');
});

test('fetchLogs reads the failed jobs of failed runs and shapes records', async () => {
  const f = fake();
  const connector = make(f);
  const result = await connector.fetchLogs({ query: 'one OR two', ...range, limit: 2, order: 'asc', countTotal: true });
  const list = f.calls.find((c) => c.url.includes('/actions/runs?'))!.url;
  assert.match(list, /^https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs\?/);
  assert.match(list, /status=completed/);
  assert.match(list, /created=2026-11-01T00%3A00%3A00Z\.\.2026-11-30T00%3A00%3A00Z/);
  assert.match(list, /branch=feat/);
  assert.ok(f.calls.some((c) => c.url.endsWith('/actions/runs/1/jobs?per_page=100&filter=latest')));
  assert.ok(f.calls.some((c) => c.url.endsWith('/actions/jobs/10/logs')));
  assert.ok(f.calls.some((c) => c.url.endsWith('/actions/jobs/12/logs')));
  assert.ok(!f.calls.some((c) => c.url.includes('/actions/jobs/11/')));
  assert.ok(!f.calls.some((c) => c.url.includes('/actions/runs/2/jobs')));
  assert.equal(result.records.length, 2);
  assert.equal(result.total, 4, 'the lines that match the search, in both failed jobs');
  const first = JSON.parse(result.records[0].line);
  assert.equal(first.service === 'unit' || first.service === 'e2e', true);
  assert.equal(first.kind, 'ci');
  assert.equal(first.run, 5);
  assert.deepEqual(result.pushed, []);
  assert.ok(result.local.includes('one'));
  assert.match(result.statement, /2 failed jobs in 1 run/);
  assert.match(result.statement, /o\/r/);
  const times = result.records.map((r) => r.timeMs!);
  assert.ok(times[0] <= times[1]);
  const desc = await connector.fetchLogs({ query: '', ...range, limit: 10, order: 'desc' });
  const d = desc.records.map((r) => r.timeMs!);
  assert.deepEqual(
    d,
    [...d].sort((a, b) => b - a),
  );
  assert.equal(desc.total, undefined);
});

test('the search is applied before the limit, so matching lines past it are not lost', async () => {
  const connector = make(fake());
  const result = await connector.fetchLogs({
    query: 'level:error',
    ...range,
    limit: 1,
    order: 'desc',
    countTotal: true,
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.total, 2);
  assert.equal(JSON.parse(result.records[0].line).message, 'bad');
});

test('a second fetch reuses job lists and logs, a re-run lists jobs again', async () => {
  const f = fake();
  const connector = make(f);
  const req = { query: '', ...range, limit: 10, order: 'asc' as const };
  await connector.fetchLogs(req);
  const count = (part: string) => f.calls.filter((c) => c.url.includes(part)).length;
  assert.equal(count('/runs/1/jobs'), 1);
  assert.equal(count('/jobs/10/logs'), 1);
  await connector.fetchLogs(req);
  assert.equal(count('/runs/1/jobs'), 1);
  assert.equal(count('/jobs/10/logs'), 1);
  f.rerun();
  await connector.fetchLogs(req);
  assert.equal(count('/runs/1/jobs'), 2);
});

test('the connection’s branch wins; headers and the endpoint and encoding are applied', async () => {
  const f = fake();
  const connector = make(f, connection({ branch: 'main', endpoint: 'http://127.0.0.1:9/api/v3/' }));
  await connector.fetchLogs({ query: '', ...range, limit: 1, order: 'asc' }).catch(() => undefined);
  const call = f.calls[0];
  assert.match(call.url, /^http:\/\/127\.0\.0\.1:9\/api\/v3\/repos\/o\/r\/actions\/runs\?/);
  assert.match(call.url, /branch=main/);
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers['x-github-api-version'], '2022-11-28');
  const g = fake();
  await make(g, connection({ repository: 'a b/c#d' }))
    .test()
    .catch(() => undefined);
  assert.equal(g.calls[0].url, 'https://api.github.com/repos/a%20b/c%23d');
});

test('GitHub errors are explained', async () => {
  const f = fake();
  await assert.rejects(
    make(f, connection(), { token: async () => undefined, branch: async () => undefined }).test(),
    /Sign in to GitHub/,
  );
  assert.equal(f.calls.length, 0);
  const status = (response: Response) => make(fake(() => response)).test();
  await assert.rejects(status(new Response('{}', { status: 401 })), /401/);
  await assert.rejects(status(new Response('{}', { status: 404 })), /no repository o\/r/);
  await assert.rejects(status(new Response('{"message":"nope"}', { status: 403 })), /403: nope/);
  await assert.rejects(
    status(
      new Response('{"message":"limit"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '7' },
      }),
    ),
    (error: Error & { retryAfterMs?: number }) => /rate limit/.test(error.message) && error.retryAfterMs === 7000,
  );
  await assert.rejects(
    status(new Response('{}', { status: 429 })),
    (error: Error & { retryAfterMs?: number }) => error.retryAfterMs === 60_000,
  );
});

test('services lists failed job names, most failing first', async () => {
  // A second failed run in which only e2e failed: e2e failed twice, unit once.
  const runs = {
    workflow_runs: [
      { id: 1, run_number: 5, name: 'CI', conclusion: 'failure', created_at: '2026-11-14T08:00:00Z' },
      { id: 2, run_number: 4, name: 'CI', conclusion: 'failure', created_at: '2026-11-14T07:00:00Z' },
    ],
  };
  const f = fake((url) => {
    const path = new URL(url).pathname;
    if (path === '/repos/o/r/actions/runs') return new Response(JSON.stringify(runs));
    if (path === '/repos/o/r/actions/runs/2/jobs')
      return new Response(JSON.stringify({ jobs: [{ id: 20, name: 'e2e', conclusion: 'failure' }] }));
    return undefined;
  });
  const services = await make(f).services(range.fromMs, range.toMs);
  assert.deepEqual(
    services.map((s) => s.name),
    ['e2e', 'unit'],
  );
});
