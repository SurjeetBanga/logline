import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LokiConnection } from '../../core/connections';
import { CONTRACT_START, describeConnector, type ContractLog } from '../../test/connector-contract';
import { startFakeLoki, type FakeLine } from '../../test/fake-loki';
import { LokiConnector, lokiLine } from './loki';

// Built at runtime: token-shaped literals look like leaked secrets to scanners.
const TOKEN = ['glc', 'test', 'token'].join('_');

const connection = (url: string, extra: Partial<LokiConnection> = {}): LokiConnection => ({
  id: 'prod',
  label: 'prod',
  type: 'loki',
  url,
  ...extra,
});

const asLines = (logs: ContractLog[]): FakeLine[] =>
  logs.map((log) => ({
    labels: { service_name: log.service, env: 'prod' },
    timeMs: log.timeMs,
    line: JSON.stringify({ level: log.level, msg: log.message, traceId: log.traceId }),
  }));

describeConnector('loki', async (logs) => {
  const fake = await startFakeLoki({ lines: asLines(logs), password: TOKEN });
  const connector = new LokiConnector(connection(fake.url), TOKEN, () => 5000);
  return { connector, rateLimit: () => (fake.state.rateLimited = 1), close: fake.close };
});

test('a line becomes a log: a JSON line is the log, any other its text, with the stream’s labels beside it', () => {
  // 12:00:00.123456789: nanoseconds, of which Logline keeps the milliseconds.
  const ns = `${Date.parse('2026-10-30T12:00:00.123Z')}456789`;
  const json = lokiLine(
    { service_name: 'checkout', env: 'prod', level: 'info' },
    ns,
    '{"level":"error","msg":"declined"}',
  );
  assert.equal(json.timeMs, Date.parse('2026-10-30T12:00:00.123Z'));
  assert.deepEqual(JSON.parse(json.line), {
    timestamp: '2026-10-30T12:00:00.123Z',
    level: 'error',
    msg: 'declined',
    service: 'checkout',
    service_name: 'checkout',
    env: 'prod',
    'loki.ns': ns,
  });
  const plain = lokiLine({ job: 'nginx' }, ns, '\x1b[33mGET /health 200\x1b[0m', { trace_id: 't1' });
  assert.deepEqual(JSON.parse(plain.line), {
    timestamp: '2026-10-30T12:00:00.123Z',
    message: 'GET /health 200',
    job: 'nginx',
    trace_id: 't1',
    'loki.ns': ns,
  });
});

test('a search pages back through Loki, counts every match when cut short, and lists services by volume', async () => {
  const fake = await startFakeLoki({ lines: asLines(lines(3000)), user: '12345', password: TOKEN });
  try {
    const connector = new LokiConnector(connection(fake.url, { user: '12345', tenant: 'team-a' }), TOKEN, () => 5000);
    assert.match(await connector.test(), /^Loki · 2 labels at 127\.0\.0\.1:\d+$/);
    const range = { fromMs: CONTRACT_START, toMs: CONTRACT_START + 3600000 };
    const result = await connector.fetchLogs({
      query: 'level:error',
      ...range,
      limit: 600,
      order: 'desc',
      countTotal: true,
    });
    assert.equal(result.records.length, 600);
    assert.equal(result.total, 1000, 'every third of 3,000');
    assert.equal(fake.state.requests.at(-1)?.headers['x-scope-orgid'], 'team-a');
    // The pages met at a time without losing or repeating a line.
    const times = result.records.map((record) => record.timeMs!);
    assert.equal(new Set(result.records.map((record) => record.line)).size, 600);
    assert.deepEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
    assert.deepEqual(await connector.services(range.fromMs, range.toMs), [
      { name: 'api', count: 1500 },
      { name: 'checkout', count: 1500 },
    ]);
  } finally {
    await fake.close();
  }
});

test('refused credentials and a query Loki cannot parse are explained', async () => {
  const fake = await startFakeLoki({ lines: asLines(lines(3)), password: TOKEN });
  try {
    await assert.rejects(
      new LokiConnector(connection(fake.url), 'wrong', () => 5000).test(),
      /Loki refused the credentials \(401/,
    );
    const connector = new LokiConnector(connection(fake.url), TOKEN, () => 5000);
    await assert.rejects(
      connector.fetchLogs({ query: '', native: '{job=', limit: 10, order: 'desc' }),
      /^Error: Loki could not run the query: parse error/,
    );
    // Pipeline stages alone read the connection's streams.
    const stages = await connector.fetchLogs({
      query: '',
      native: '|= "log 1"',
      fromMs: CONTRACT_START,
      toMs: CONTRACT_START + 60000,
      limit: 10,
      order: 'desc',
    });
    assert.equal(stages.statement, '{service_name=~".+"} |= "log 1"');
    assert.equal(stages.records.length, 1);
  } finally {
    await fake.close();
  }
});

function lines(count: number): ContractLog[] {
  return Array.from({ length: count }, (_, i) => ({
    timeMs: CONTRACT_START + i * 1000,
    level: i % 3 === 0 ? 'error' : 'info',
    message: `log ${i}`,
    service: i % 2 ? 'api' : 'checkout',
    traceId: `trace${i % 10}`,
  }));
}
