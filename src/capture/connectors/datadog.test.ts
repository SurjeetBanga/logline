import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatadogConnection } from '../../core/connections';
import { matchesQuery, parseQuery } from '../../core/query';
import { parseLogLine } from '../../core/log-event';
import { startFakeDatadog, type FakeLog } from '../../test/fake-datadog';
import { DatadogConnector, datadogLine } from './datadog';

const BASE = Date.parse('2026-10-23T09:00:00Z');
// Built at runtime: key-shaped literals look like leaked secrets to scanners.
const API_KEY = ['test', 'api', 'key'].join('-');
const APP_KEY = ['test', 'app', 'key'].join('-');

function logs(count: number): FakeLog[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `log-${i}`,
    timestamp: new Date(BASE + i * 1000).toISOString(),
    status: i % 4 === 0 ? 'error' : 'info',
    message: i % 4 === 0 ? `payment gateway timed out after ${i} ms` : `order ${i} placed`,
    service: i % 2 ? 'api' : 'checkout',
    host: 'web-1',
    attributes: { dd: { trace_id: `trace-${i % 10}` }, http: { status_code: i % 4 === 0 ? 504 : 200 }, user_id: i % 7 },
  }));
}

const connection = (site: string, indexes?: string[]): DatadogConnection => ({
  id: 'prod',
  label: 'prod',
  type: 'datadog',
  site,
  ...(indexes ? { indexes } : {}),
});

test('a search pages through Datadog, newest first, and counts every match when cut short', async () => {
  const fake = await startFakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, logs: logs(3000) });
  try {
    const connector = new DatadogConnector(
      connection(fake.url, ['main']),
      { apiKey: API_KEY, appKey: APP_KEY },
      () => 5000,
    );
    assert.match(await connector.test(), /^Datadog · logs readable at 127\.0\.0\.1:\d+$/);
    const result = await connector.fetchLogs({
      query: 'level:error service:checkout',
      fromMs: BASE,
      toMs: BASE + 3600000,
      limit: 1200,
      order: 'desc',
      countTotal: true,
    });
    // 750 errors, all from checkout since every fourth log is even.
    assert.equal(result.records.length, 750);
    assert.equal(result.total, undefined, 'not counted when every match fit');
    assert.equal(result.statement, 'status:(error) service:*checkout*');
    const capped = await connector.fetchLogs({
      query: '',
      fromMs: BASE,
      toMs: BASE + 3600000,
      limit: 1500,
      order: 'desc',
      countTotal: true,
    });
    assert.equal(capped.records.length, 1500);
    assert.equal(capped.total, 3000);
    assert.ok(capped.records[0].timeMs! > capped.records[1].timeMs!, 'newest first');
    const searches = fake.state.requests.filter((request) => request.path === '/api/v2/logs/events/search');
    // Pages of at most 1,000, each with the keys, the indexes, and the range in milliseconds.
    assert.deepEqual(
      searches.slice(-2).map((request) => (request.body.page as { limit: number }).limit),
      [1000, 500],
    );
    assert.equal(searches[1].headers['dd-api-key'], API_KEY);
    assert.deepEqual((searches[1].body.filter as { indexes: string[] }).indexes, ['main']);
    assert.equal((searches[1].body.filter as { from: string }).from, String(BASE));
    // What Datadog returns matches the whole search when Logline applies it.
    const filter = parseQuery('level:error service:checkout');
    for (const record of result.records.slice(0, 50))
      assert.ok(matchesQuery(parseLogLine(record.line, 'remote', 1, new Date()), filter), record.line);
  } finally {
    await fake.close();
  }
});

test('a log becomes a line with its trace id, attributes, and tags, keeping colliding names apart', () => {
  const record = datadogLine({
    id: 'AwAAAZ',
    type: 'log',
    attributes: {
      timestamp: '2026-10-23T09:12:04.311Z',
      status: 'error',
      message: 'payment gateway timed out',
      service: 'checkout',
      host: 'web-1',
      tags: ['env:prod', 'version:1.2'],
      attributes: { dd: { trace_id: '7f3a' }, message: 'inner', region: 'eu-west', level: 'ERROR' },
    },
  });
  assert.equal(record.timeMs, Date.parse('2026-10-23T09:12:04.311Z'));
  assert.deepEqual(JSON.parse(record.line), {
    timestamp: '2026-10-23T09:12:04.311Z',
    level: 'error',
    message: 'payment gateway timed out',
    service: 'checkout',
    host: 'web-1',
    traceId: '7f3a',
    dd: { trace_id: '7f3a' },
    'attributes.message': 'inner',
    region: 'eu-west',
    'attributes.level': 'ERROR',
    tags: 'env:prod,version:1.2',
    'datadog.id': 'AwAAAZ',
  });
  const event = parseLogLine(record.line, 'remote', 1, new Date());
  assert.equal(event.level, 'error');
  assert.equal(event.message, 'payment gateway timed out');
  assert.deepEqual(JSON.parse(datadogLine({ attributes: { message: 'bare' } }).line), { message: 'bare' });
  assert.equal(datadogLine(null).timeMs, undefined);
});

test('refused keys, rate limits, timeouts, and unreachable APIs are explained', async () => {
  const fake = await startFakeDatadog({ token: 'right-token', logs: logs(5) });
  try {
    const request = { query: '', fromMs: BASE, toMs: BASE + 60000, limit: 10, order: 'asc' as const };
    const wrong = new DatadogConnector(connection(fake.url), { token: 'wrong' }, () => 5000);
    await assert.rejects(
      wrong.fetchLogs(request),
      /Datadog refused the access token \(403: Forbidden\)\. Logs need the logs_read_data permission; metrics need timeseries_query and metrics_read\./,
    );
    const right = new DatadogConnector(connection(fake.url), { token: 'right-token' }, () => 5000);
    assert.equal((await right.fetchLogs(request)).records.length, 5);
    assert.equal(fake.state.requests.at(-1)?.headers.authorization, 'Bearer right-token');
    fake.state.rateLimited = 1;
    await assert.rejects(right.fetchLogs(request), /rate limit was reached; try again in 7 s/);
    const slow = new DatadogConnector(
      connection(fake.url),
      { token: 'right-token' },
      () => 50,
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    await assert.rejects(slow.fetchLogs(request), /longer than 50 ms/);
    const cancelled = new AbortController();
    const pending = slow.fetchLogs(request, cancelled.signal);
    cancelled.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    await fake.close();
  }
  const offline = new DatadogConnector(connection(fake.url), {}, () => 2000);
  await assert.rejects(offline.test(), /Could not reach Datadog at http:\/\/127\.0\.0\.1:\d+/);
  const notJson = new DatadogConnector(
    connection('https://example.com'),
    {},
    () => 2000,
    async () => new Response('<html>'),
  );
  await assert.rejects(notJson.test(), /not JSON/);
  const nowhere = new DatadogConnector(connection('http://example.com'), {}, () => 2000);
  await assert.rejects(nowhere.test(), /is not a Datadog site/);
  assert.deepEqual(await nowhere.preview('level:error /x/'), { statement: 'status:(error)', local: ['/x/'] });
});

test('a typed Datadog query is sent as it is, and the default range is the last 15 minutes', async () => {
  const seen: Record<string, unknown>[] = [];
  const connector = new DatadogConnector(
    connection('datadoghq.eu'),
    { apiKey: 'a', appKey: 'b' },
    () => 2000,
    async (url, init) => {
      assert.equal(url, 'https://api.datadoghq.eu/api/v2/logs/events/search');
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: [], meta: {} }));
    },
  );
  const before = Date.now();
  const result = await connector.fetchLogs({
    query: 'ignored',
    native: 'service:checkout @http.status_code:>499',
    limit: 10,
    order: 'asc',
  });
  assert.equal(result.statement, 'service:checkout @http.status_code:>499');
  assert.deepEqual(result.local, []);
  const filter = seen[0].filter as { query: string; from: string; to: string };
  assert.equal(filter.query, 'service:checkout @http.status_code:>499');
  assert.ok(Number(filter.to) - Number(filter.from) === 900000 && Number(filter.to) >= before);
  assert.equal(seen[0].sort, 'timestamp');
  assert.equal(connector.tailLagMs, 60000);
});

test('a metric query reads Datadog timeseries over the range, and metric names are suggested', async () => {
  const now = Date.now();
  const fake = await startFakeDatadog({
    token: 'metrics-token',
    series: [
      {
        metric: 'trace.http.request.duration',
        scope: 'env:prod',
        unit: 's',
        points: [
          [now - 120000, 0.2],
          [now - 60000, 0.9],
          [now - 7200000, 5],
        ],
      },
      { metric: 'system.cpu.user', scope: 'host:web-1', points: [[now - 60000, 30]] },
    ],
  });
  try {
    const connector = new DatadogConnector(connection(fake.url), { token: 'metrics-token' }, () => 5000);
    const result = await connector.queryMetrics('avg:trace.http.request.duration{*} by {env}', now - 3600000, now);
    assert.equal(result.statement, 'avg:trace.http.request.duration{*} by {env}');
    assert.deepEqual(result.series, [
      {
        name: 'trace.http.request.duration',
        scope: 'env:prod',
        unit: 's',
        points: [
          [now - 120000, 0.2],
          [now - 60000, 0.9],
        ],
      },
    ]);
    const request = fake.state.requests.at(-1)!;
    assert.equal(request.path, '/api/v1/query');
    assert.deepEqual(await connector.listMetrics('HTTP'), ['trace.http.request.duration']);
    assert.deepEqual(await connector.listMetrics(''), ['trace.http.request.duration', 'system.cpu.user']);
  } finally {
    await fake.close();
  }
  const failing = new DatadogConnector(
    connection('datadoghq.com'),
    {},
    () => 2000,
    async () => new Response(JSON.stringify({ status: 'error', error: 'Rule parsing error' })),
  );
  await assert.rejects(failing.queryMetrics('avg:x{', 0, 1), /could not run the query: Rule parsing error/);
});
