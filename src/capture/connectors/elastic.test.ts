import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElasticConnection, LogTableMapping } from '../../core/connections';
import { CONTRACT_START, describeConnector, type ContractLog } from '../../test/connector-contract';
import { startFakeElastic, type FakeDocument } from '../../test/fake-elastic';
import { ElasticConnector, elasticLine } from './elastic';

// Built at runtime: key-shaped literals look like leaked secrets to scanners.
const API_KEY = ['es', 'api', 'key'].join('-');

const mapping: LogTableMapping = {
  table: 'logs-*',
  timestamp: '@timestamp',
  level: 'log.level',
  message: 'message',
  service: 'service.name',
  traceId: 'trace.id',
};
const connection = (url: string, extra: Partial<ElasticConnection> = {}): ElasticConnection => ({
  id: 'prod',
  label: 'prod',
  type: 'elasticsearch',
  url,
  logs: mapping,
  ...extra,
});
const asDocuments = (logs: ContractLog[]): FakeDocument[] =>
  logs.map((log, i) => ({
    index: `logs-app-2026.10.${30 + (i % 2)}`,
    id: `doc-${i}`,
    source: {
      '@timestamp': new Date(log.timeMs).toISOString(),
      log: { level: log.level },
      message: log.message,
      service: { name: log.service },
      trace: { id: log.traceId },
    },
  }));
const options = { textFields: ['message'], dateFields: ['@timestamp'] };

describeConnector('elasticsearch', async (logs) => {
  const fake = await startFakeElastic({ documents: asDocuments(logs), password: API_KEY, ...options });
  const connector = new ElasticConnector(connection(fake.url), API_KEY, () => 5000);
  return { connector, rateLimit: () => (fake.state.rateLimited = 1), close: fake.close };
});

test('a hit becomes a line: the mapped fields first, then the rest of the document, with its index and id', () => {
  const line = elasticLine(
    {
      _index: 'logs-app',
      _id: '7',
      _source: {
        '@timestamp': '2026-10-30T12:00:00Z',
        log: { level: 'error' },
        msg: '\x1b[31mdeclined\x1b[0m',
        message: 'kept apart',
        user: 'ana',
      },
    },
    { table: 'logs-*', timestamp: '@timestamp', level: 'log.level', message: 'msg' },
  );
  assert.equal(line.timeMs, Date.parse('2026-10-30T12:00:00Z'));
  assert.deepEqual(JSON.parse(line.line), {
    timestamp: '2026-10-30T12:00:00Z',
    level: 'error',
    message: 'declined',
    '@timestamp': '2026-10-30T12:00:00Z',
    log: { level: 'error' },
    msg: '\x1b[31mdeclined\x1b[0m',
    'attributes.message': 'kept apart',
    user: 'ana',
    'elasticsearch.index': 'logs-app',
    'elasticsearch.id': '7',
  });
});

test('a test names the cluster, and the form lists index patterns, their fields, and a preview', async () => {
  const fake = await startFakeElastic({
    documents: asDocuments(lines(4)),
    user: 'reader',
    password: 'pw',
    distribution: 'opensearch',
    ...options,
  });
  try {
    const connector = new ElasticConnector(connection(fake.url, { user: 'reader' }), 'pw', () => 5000);
    assert.match(await connector.test(), /^OpenSearch 2\.17\.0 at 127\.0\.0\.1:\d+$/);
    assert.deepEqual(await connector.tables(), ['logs-app-*', 'logs-app-2026.10.30', 'logs-app-2026.10.31']);
    const columns = await connector.columns('logs-app-*');
    assert.deepEqual(
      columns.map((column) => `${column.name}:${column.type}`),
      [
        '@timestamp:date',
        'log.level:keyword',
        'message:text',
        'message.keyword:keyword',
        'service.name:keyword',
        'trace.id:keyword',
      ],
    );
    const [row] = await connector.sample('logs-app-*', 1);
    assert.equal(row['service.name'], 'checkout');
    await assert.rejects(
      new ElasticConnector(connection(fake.url, { user: 'reader' }), 'wrong', () => 5000).test(),
      /refused the request \(401: unable to authenticate user\)\. Searches need the read privilege/,
    );
  } finally {
    await fake.close();
  }
});

test('a search pages through the index newest first, counts every match when cut short, and lists services', async () => {
  const fake = await startFakeElastic({ documents: asDocuments(lines(3000)), password: API_KEY, ...options });
  try {
    const connector = new ElasticConnector(connection(fake.url), API_KEY, () => 5000);
    const range = { fromMs: CONTRACT_START, toMs: CONTRACT_START + 3600000 };
    const result = await connector.fetchLogs({
      query: 'level:error service:checkout',
      ...range,
      limit: 300,
      order: 'desc',
      countTotal: true,
    });
    assert.equal(result.records.length, 300);
    assert.equal(result.total, 500, 'every sixth of 3,000');
    const preview = await connector.preview('level:error service:checkout', range.fromMs, range.toMs);
    assert.equal(preview.statement, result.statement);
    const search = fake.state.requests.find(
      (request) => request.path.endsWith('/_search') && request.body.search_after,
    );
    assert.ok(!search || search.body.track_total_hits === false, 'the total is counted once');
    assert.deepEqual(await connector.services(range.fromMs, range.toMs), [
      { name: 'checkout', count: 1500 },
      { name: 'api', count: 1500 },
    ]);
    await assert.rejects(
      new ElasticConnector(
        connection(fake.url, { logs: { ...mapping, table: 'missing' } }),
        API_KEY,
        () => 5000,
      ).fetchLogs({ query: '', limit: 1, order: 'desc' }),
      /No index matches missing\./,
    );
  } finally {
    await fake.close();
  }
});

test('Amazon OpenSearch requests are signed with AWS credentials for the region in the host', async () => {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const connector = new ElasticConnector(
    connection('https://search-logs-abc.eu-west-1.es.amazonaws.com', { auth: { kind: 'iam', profile: 'work' } }),
    undefined,
    () => 5000,
    {
      fetcher: async (url, init) => {
        sent.push({ url, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ version: { number: '2.13.0', distribution: 'opensearch' } }));
      },
      credentials: async () => ({ accessKeyId: ['AKIA', 'TEST'].join(''), secretAccessKey: ['s', 'k'].join('') }),
    },
  );
  assert.equal(await connector.test(), 'OpenSearch 2.13.0 at search-logs-abc.eu-west-1.es.amazonaws.com');
  assert.match(
    sent[0].headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-west-1\/es\/aws4_request/,
  );
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
