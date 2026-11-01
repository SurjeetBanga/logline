import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GcpConnection } from '../../core/connections';
import { CONTRACT_START, describeConnector, type ContractLog } from '../../test/connector-contract';
import { startFakeGcp } from '../../test/fake-gcp';
import { GcpConnector, gcpLine } from './gcp';

// Built at runtime: token-shaped literals look like leaked secrets to scanners.
const TOKEN = ['ya29', 'test'].join('.');
const token = async () => ({ token: TOKEN, expiresAtMs: Date.now() + 3600000 });

const connection = (endpoint: string, extra: Partial<GcpConnection> = {}): GcpConnection => ({
  id: 'prod',
  label: 'prod',
  type: 'gcp',
  project: 'shop-prod',
  endpoint,
  ...extra,
});

const asEntries = (logs: ContractLog[]) =>
  logs.map((log, i) => ({
    timestamp: new Date(log.timeMs).toISOString(),
    severity: log.level === 'error' ? 'ERROR' : 'INFO',
    jsonPayload: { message: log.message },
    trace: `projects/shop-prod/traces/${log.traceId}`,
    resource: { type: 'cloud_run_revision', labels: { service_name: log.service } },
    logName: 'projects/shop-prod/logs/run.googleapis.com%2Fstdout',
    insertId: `entry-${i}`,
  }));

describeConnector('gcp', async (logs) => {
  const fake = await startFakeGcp({ entries: asEntries(logs), token: TOKEN });
  const connector = new GcpConnector(connection(fake.url), () => 5000, { token });
  return { connector, rateLimit: () => (fake.state.rateLimited = 1), close: fake.close };
});

test('an entry becomes a line with its severity as the level, its payload, service, trace, and request', () => {
  const line = gcpLine({
    timestamp: '2026-11-01T12:00:00.123456Z',
    severity: 'WARNING',
    jsonPayload: { message: 'slow checkout', level: 'kept apart?', cart: { items: 3 }, service: 'from-payload' },
    httpRequest: { requestMethod: 'POST', status: 503, latency: '1.250s' },
    trace: 'projects/shop-prod/traces/abc123',
    spanId: '00f067aa0ba902b7',
    resource: { type: 'cloud_run_revision', labels: { service_name: 'checkout', revision_name: 'checkout-0042' } },
    labels: { instanceId: 'i-1' },
    logName: 'projects/shop-prod/logs/run.googleapis.com%2Fstdout',
    insertId: 'x1',
  });
  assert.equal(line.timeMs, Date.parse('2026-11-01T12:00:00.123Z'));
  const fields = JSON.parse(line.line);
  assert.equal(fields.level, 'warn');
  assert.equal(fields.message, 'slow checkout');
  assert.equal(fields.service, 'checkout');
  assert.equal(fields.traceId, 'abc123');
  assert.equal(fields.status, 503);
  assert.equal(fields.durationMs, 1250);
  assert.deepEqual(fields.cart, { items: 3 });
  assert.equal(fields['attributes.service'], 'from-payload');
  assert.equal(fields['gcp.insertId'], 'x1');
  // Text, with the default severity, keeps the level its payload would have named.
  const text = JSON.parse(
    gcpLine({
      timestamp: '2026-11-01T12:00:00Z',
      textPayload: 'GET /health 200',
      resource: { labels: { container_name: 'nginx' } },
    }).line,
  );
  assert.deepEqual([text.level, text.message, text.service], ['info', 'GET /health 200', 'nginx']);
});

test('a search narrows by the connection’s filter and the range, and a token that stopped working is asked for again', async () => {
  const fake = await startFakeGcp({ entries: asEntries(lines(30)), token: TOKEN });
  try {
    let asked = 0;
    const connector = new GcpConnector(
      connection(fake.url, { filter: 'resource.type="cloud_run_revision"' }),
      () => 5000,
      {
        token: async () => {
          asked++;
          return { token: TOKEN, expiresAtMs: Date.now() + 3600000, quotaProject: 'billing' };
        },
      },
    );
    assert.equal(await connector.test(), 'Cloud Logging · shop-prod readable');
    fake.state.expired = 1;
    const result = await connector.fetchLogs({
      query: 'service:checkout level:error',
      fromMs: CONTRACT_START,
      toMs: CONTRACT_START + 60000,
      limit: 100,
      order: 'desc',
    });
    assert.equal(result.records.length, 5, 'the errors of checkout: every sixth log');
    assert.equal(asked, 2);
    const sent = fake.state.requests.at(-1)!;
    assert.deepEqual(sent.body.resourceNames, ['projects/shop-prod']);
    assert.equal(sent.headers['x-goog-user-project'], 'billing');
    assert.match(
      String(sent.body.filter),
      /^\(resource\.type="cloud_run_revision"\) AND timestamp>="2026-10-30T12:00:00\.000Z" AND timestamp<="2026-10-30T12:01:00\.000Z" AND \(/,
    );
  } finally {
    await fake.close();
  }
});

test('refusals say which role reading logs needs, and a query Cloud Logging cannot parse is explained', async () => {
  const forbidden = new GcpConnector(connection('http://127.0.0.1:9'), () => 5000, {
    token,
    fetcher: async () =>
      new Response(
        JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied' } }),
        { status: 403 },
      ),
  });
  await assert.rejects(forbidden.test(), /needs the Logs Viewer role \(roles\/logging\.viewer\)/);
  const fake = await startFakeGcp({ entries: [], token: TOKEN });
  try {
    const connector = new GcpConnector(connection(fake.url), () => 5000, { token });
    await assert.rejects(
      connector.fetchLogs({ query: '', native: 'severity>=', limit: 5, order: 'desc' }),
      /^Error: Cloud Logging could not run the query: Unparseable filter/,
    );
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
