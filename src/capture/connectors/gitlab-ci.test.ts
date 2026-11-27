import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitLabCiConnection } from '../../core/connections';
import { GitLabCiConnector } from './gitlab-ci';

const TOKEN = ['glpat', 'x'.repeat(20)].join('-');
const connection = (extra: Partial<GitLabCiConnection> = {}): GitLabCiConnection => ({
  id: 'ci',
  label: 'ci',
  type: 'gitlab-ci',
  url: 'https://gitlab.com',
  project: 'grp/sub/shop',
  ...extra,
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

const PROJECT = '/api/v4/projects/grp%2Fsub%2Fshop';

function fake(overrides: (url: string) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  let updated = '2026-11-14T08:05:00Z';
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const over = overrides(url);
    if (over) return over;
    // The project's path stays encoded as one part of the URL.
    const path = url.slice(url.indexOf('/api/v4')).split('?')[0];
    if (path === PROJECT) return json({ path_with_namespace: 'grp/sub/shop' });
    if (path === `${PROJECT}/pipelines`)
      return json([
        {
          id: 900,
          iid: 42,
          name: 'Build',
          ref: 'feat',
          sha: 'abcdef123456',
          status: 'failed',
          web_url: 'https://gitlab.com/grp/sub/shop/-/pipelines/900',
          created_at: '2026-11-14T08:00:00Z',
          updated_at: updated,
        },
        { id: 899, iid: 41, status: 'success', created_at: '2026-11-14T07:00:00Z' },
      ]);
    if (path === `${PROJECT}/pipelines/900/jobs`)
      return json([
        { id: 10, name: 'unit', status: 'failed', web_url: 'https://gitlab.com/grp/sub/shop/-/jobs/10' },
        { id: 11, name: 'lint', status: 'failed', allow_failure: true },
        { id: 12, name: 'e2e', status: 'canceled' },
        { id: 13, name: 'build', status: 'success' },
      ]);
    if (path.endsWith('/trace'))
      return new Response(
        'section_start:1763107200:step_script\r\u001b[0KExecuting "step_script"\none\nERROR: bad\ntwo\n',
        { status: 200 },
      );
    return new Response('{"message":"404 Not Found"}', { status: 404 });
  };
  return { fetcher, calls, retry: () => (updated = '2026-11-14T09:00:00Z') };
}

const range = { fromMs: Date.parse('2025-11-01T00:00:00Z'), toMs: Date.parse('2026-11-30T00:00:00Z') };
/** `null` makes a connector without a token, as for a public project. */
const make = (f: ReturnType<typeof fake>, conn = connection(), token: string | null = TOKEN) =>
  new GitLabCiConnector(
    conn,
    token ?? undefined,
    async () => 'feat',
    () => 5000,
    f.fetcher,
  );

test('test() reports project, branch and latest pipeline', async () => {
  assert.equal(await make(fake()).test(), 'GitLab CI · grp/sub/shop · branch feat · latest pipeline #42 failed');
});

test('fetchLogs reads the failed jobs of failed pipelines and shapes records', async () => {
  const f = fake();
  const connector = make(f);
  const result = await connector.fetchLogs({ query: 'one OR two', ...range, limit: 2, order: 'asc', countTotal: true });
  const list = f.calls.find((c) => c.url.includes('/pipelines?'))!.url;
  assert.match(list, /^https:\/\/gitlab\.com\/api\/v4\/projects\/grp%2Fsub%2Fshop\/pipelines\?/);
  assert.match(list, /scope=finished/);
  assert.match(list, /updated_after=2025-11-01T00%3A00%3A00\.000Z/);
  assert.match(list, /ref=feat/);
  assert.ok(f.calls.some((c) => c.url.endsWith('/pipelines/900/jobs?per_page=100&scope[]=failed&scope[]=canceled')));
  assert.ok(f.calls.some((c) => c.url.endsWith('/jobs/10/trace')));
  assert.ok(f.calls.some((c) => c.url.endsWith('/jobs/12/trace')));
  assert.ok(!f.calls.some((c) => c.url.includes('/jobs/11/')), 'a job allowed to fail is left out');
  assert.ok(!f.calls.some((c) => c.url.includes('/pipelines/899/')));
  assert.equal(result.records.length, 2);
  assert.equal(result.total, 4, 'the lines that match the search, in both failed jobs');
  const first = JSON.parse(result.records[0].line);
  assert.ok(first.service === 'unit' || first.service === 'e2e');
  assert.equal(first.kind, 'ci');
  assert.equal(first.run, 42);
  assert.equal(first.workflow, 'Build');
  assert.equal(first.step, 'step_script');
  assert.equal(first.sha, 'abcdef1');
  assert.match(result.statement, /newest 10 failed pipelines on feat in grp\/sub\/shop: 2 failed jobs in 1 pipeline$/);
  const errors = await connector.fetchLogs({ query: 'level:error', ...range, limit: 10, order: 'desc' });
  assert.deepEqual(
    errors.records.map((r) => JSON.parse(r.line).message),
    ['ERROR: bad', 'ERROR: bad'],
  );
});

test('a second fetch reuses job lists and logs, a retried job lists jobs again', async () => {
  const f = fake();
  const connector = make(f);
  const req = { query: '', ...range, limit: 10, order: 'asc' as const };
  const count = (part: string) => f.calls.filter((c) => c.url.includes(part)).length;
  await connector.fetchLogs(req);
  await connector.fetchLogs(req);
  assert.equal(count('/pipelines/900/jobs'), 1);
  assert.equal(count('/jobs/10/trace'), 1);
  f.retry();
  await connector.fetchLogs(req);
  assert.equal(count('/pipelines/900/jobs'), 2);
});

test('the token, own GitLab, and connection branch are applied; a public project needs no token', async () => {
  const f = fake();
  await make(f, connection({ url: 'https://gitlab.example.com/', branch: 'main' })).fetchLogs({
    query: '',
    ...range,
    limit: 1,
    order: 'asc',
  });
  assert.match(f.calls[0].url, /^https:\/\/gitlab\.example\.com\/api\/v4\/projects\/grp%2Fsub%2Fshop\/pipelines\?/);
  assert.match(f.calls[0].url, /ref=main/);
  assert.equal(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls.find((c) => c.url.endsWith('/trace'))!.headers.accept, 'text/plain, */*');
  const g = fake();
  await make(g, connection(), null).test();
  assert.equal(g.calls[0].headers.authorization, undefined);
});

test('errors are explained', async () => {
  const status = (response: Response, token: string | null = TOKEN) =>
    make(
      fake(() => response),
      connection(),
      token,
    ).test();
  await assert.rejects(status(new Response('{}', { status: 401 })), /refused the request \(401\).*read_api/);
  await assert.rejects(status(new Response('{}', { status: 404 })), /no project grp\/sub\/shop that this token/);
  await assert.rejects(status(new Response('{}', { status: 404 }), null), /add an access token/);
  await assert.rejects(status(new Response('{"message":"nope"}', { status: 403 })), /403: nope/);
  await assert.rejects(status(new Response('oops', { status: 500 })), /GitLab answered 500: oops/);
  await assert.rejects(
    status(new Response('{}', { status: 429, headers: { 'retry-after': '7' } })),
    (error: Error & { retryAfterMs?: number }) => /rate limit/.test(error.message) && error.retryAfterMs === 7000,
  );
  await assert.rejects(
    make(fake((url) => (url.includes('/pipelines') ? new Response('{}', { status: 200 }) : undefined))).test(),
    /not a list/,
  );
});

test('services lists failed job names', async () => {
  const services = await make(fake()).services(range.fromMs, range.toMs);
  assert.deepEqual(services.map((s) => s.name).sort(), ['e2e', 'unit']);
});
