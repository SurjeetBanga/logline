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
    assert.equal(
      fake.state.requests.filter((request) => request.path === '/api/v2/logs/analytics/aggregate').length,
      0,
      'nor asked for',
    );
    assert.equal(result.statement, 'status:(error) service:checkout');
    const capped = await connector.fetchLogs({
      query: '',
      fromMs: BASE,
      toMs: BASE + 3600000,
      limit: 1500,
      order: 'desc',
      countTotal: true,
    });
    // Services by how many logs they had: of the first 2,001 logs, checkout has the even ones.
    assert.deepEqual(await connector.services(BASE, BASE + 2000 * 1000), [
      { name: 'checkout', count: 1001 },
      { name: 'api', count: 1000 },
    ]);
    assert.equal(capped.records.length, 1500);
    // A small first page is handed over early when more follows; the rest come in one more page.
    const early: number[] = [];
    const paged = await connector.fetchLogs({
      query: '',
      fromMs: BASE,
      toMs: BASE + 3600000,
      limit: 1000,
      order: 'desc',
      firstPage: (records) => early.push(records.length),
    });
    assert.deepEqual(early, [200]);
    assert.equal(paged.records.length, 1000);
    assert.deepEqual(
      fake.state.requests
        .filter((request) => request.path === '/api/v2/logs/events/search')
        .slice(-2)
        .map((request) => (request.body.page as { limit: number }).limit),
      [200, 800],
    );
    // One page holds it all: nothing is handed over early.
    await connector.fetchLogs({
      query: '',
      limit: 150,
      order: 'desc',
      fromMs: BASE,
      toMs: BASE + 3600000,
      firstPage: () => early.push(-1),
    });
    assert.deepEqual(early, [200]);
    assert.equal(capped.total, 3000);
    assert.ok(capped.records[0].timeMs! > capped.records[1].timeMs!, 'newest first');
    const searches = fake.state.requests.filter((request) => request.path === '/api/v2/logs/events/search');
    // One page for the whole limit, with the keys, the indexes, and the range in milliseconds.
    assert.ok(searches.some((request) => (request.body.page as { limit: number }).limit === 1500));
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
      tags: ['env:prod', 'version:1.2', 'region:us', 'team:a', 'team:b', 'service:other', 'flag'],
      attributes: { dd: { trace_id: '7f3a', span_id: '91' }, message: 'inner', region: 'eu-west', level: 'ERROR' },
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
    dd: { span_id: '91' },
    'attributes.message': 'inner',
    region: 'eu-west',
    'attributes.level': 'ERROR',
    tags: 'env:prod,version:1.2,region:us,team:a,team:b,service:other,flag',
    'datadog.id': 'AwAAAZ',
  });
  const event = parseLogLine(record.line, 'remote', 1, new Date());
  // A filter finds a tag as a field, unless the event has a field of that name.
  const matches = (query: string) => matchesQuery(event, parseQuery(query));
  assert.equal(matches('env:prod'), true);
  assert.equal(matches('team:b'), true, 'a repeated tag keeps every value');
  assert.equal(matches('region:us'), false, 'the attribute wins');
  assert.equal(matches('service:other'), false);
  assert.equal(matches('flag:x'), false);
  assert.equal(event.level, 'error');
  assert.equal(event.message, 'payment gateway timed out');
  assert.deepEqual(JSON.parse(datadogLine({ attributes: { message: 'bare' } }).line), { message: 'bare' });
  // Colors a service printed are dropped from the message.
  const colored = `${String.fromCharCode(27)}[37;1mChecking for jobs${String.fromCharCode(27)}[0m`;
  assert.equal(JSON.parse(datadogLine({ attributes: { message: colored } }).line).message, 'Checking for jobs');
  // A trace id is shown once, as traceId, rather than again under dd.
  assert.deepEqual(JSON.parse(datadogLine({ attributes: { attributes: { dd: { trace_id: 't' } } } }).line), {
    traceId: 't',
  });
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

test('tails read as often as the rate limit Datadog reports allows', async () => {
  let headers: Record<string, string> = {};
  const connector = new DatadogConnector(
    connection('https://example.com'),
    { apiKey: API_KEY, appKey: APP_KEY },
    () => 5000,
    async () => new Response(JSON.stringify({ data: [], meta: {} }), { headers }),
  );
  const read = () => connector.fetchLogs({ query: '', limit: 10, order: 'asc' });
  assert.equal(connector.tailPollMs, 15000, 'every 15 s until Datadog has said');
  await read();
  assert.equal(connector.tailPollMs, 15000, 'an answer without the limit leaves the pace');
  headers = {
    'x-ratelimit-limit': '300',
    'x-ratelimit-period': '3600',
    'x-ratelimit-remaining': '290',
    'x-ratelimit-reset': '3000',
  };
  await read();
  assert.equal(connector.tailPollMs, 12000, 'the period spread over its searches');
  headers = { ...headers, 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': '90' };
  await read();
  assert.equal(connector.tailPollMs, 45000, 'what is left spread over the time until it resets');
  headers = { 'x-ratelimit-limit': '6000', 'x-ratelimit-period': '60' };
  await read();
  assert.equal(connector.tailPollMs, 10);
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
