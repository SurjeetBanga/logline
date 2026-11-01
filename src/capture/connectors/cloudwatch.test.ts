import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudWatchConnection } from '../../core/connections';
import { describeConnector, CONTRACT_START, type ContractLog } from '../../test/connector-contract';
import { startFakeCloudWatch, type FakeEvent } from '../../test/fake-cloudwatch';
import { CloudWatchConnector, cloudwatchLine, cloudwatchService } from './cloudwatch';

// Built at runtime: key-shaped literals look like leaked secrets to scanners.
const KEY_ID = ['AKIA', 'TESTKEY0000'].join('');
const credentials = { accessKeyId: KEY_ID, secretAccessKey: ['test', 'secret'].join('-') };

const connection = (endpoint: string, logGroups: string[]): CloudWatchConnection => ({
  id: 'prod',
  label: 'prod',
  type: 'cloudwatch',
  region: 'us-east-1',
  logGroups,
  endpoint,
});

const asEvents = (logs: ContractLog[]): FakeEvent[] =>
  logs.map((log, i) => ({
    group: `/aws/lambda/${log.service}`,
    timestamp: log.timeMs,
    message: JSON.stringify({ level: log.level, message: log.message, traceId: log.traceId }),
    id: `event-${i}`,
  }));

describeConnector('cloudwatch', async (logs) => {
  const fake = await startFakeCloudWatch({ events: asEvents(logs), accessKeyId: KEY_ID });
  const connector = new CloudWatchConnector(
    connection(fake.url, ['/aws/lambda/checkout', '/aws/lambda/api']),
    () => 5000,
    { credentials: async () => credentials, retryMs: [1, 1] },
  );
  // Throttled past every retry of each group read at once, so the search gives up and says when to read again.
  return { connector, rateLimit: () => (fake.state.throttled = 100), close: fake.close };
});

test('an event becomes a line: a JSON message is the log, any other its text, with the group, stream, and id', () => {
  const time = Date.parse('2026-10-30T12:00:00Z');
  assert.deepEqual(
    JSON.parse(
      cloudwatchLine(
        {
          timestamp: time,
          message: '{"level":"error","msg":"declined","service":"pay"}\n',
          logStreamName: 's',
          eventId: '1',
        },
        '/aws/lambda/checkout',
      ).line,
    ),
    {
      timestamp: '2026-10-30T12:00:00.000Z',
      level: 'error',
      msg: 'declined',
      service: 'pay',
      'cloudwatch.logGroup': '/aws/lambda/checkout',
      'cloudwatch.logStream': 's',
      'cloudwatch.eventId': '1',
    },
  );
  const plain = cloudwatchLine(
    { timestamp: time, message: '\x1b[31mSTART RequestId: 7\x1b[0m', eventId: '2' },
    '/ecs/api',
  );
  assert.equal(plain.timeMs, time);
  assert.deepEqual(JSON.parse(plain.line), {
    timestamp: '2026-10-30T12:00:00.000Z',
    message: 'START RequestId: 7',
    service: 'api',
    'cloudwatch.logGroup': '/ecs/api',
    'cloudwatch.eventId': '2',
  });
  assert.equal(cloudwatchService('/aws/ecs/cluster/orders'), 'orders');
  assert.equal(cloudwatchService('arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/pay'), 'pay');
});

test('a test checks each log group and the permission to search, and suggests groups like a missing one', async () => {
  const fake = await startFakeCloudWatch({
    accessKeyId: KEY_ID,
    groups: ['/aws/lambda/checkout', '/aws/lambda/checkout-worker', '/aws/lambda/api'],
  });
  try {
    const open = (groups: string[]) =>
      new CloudWatchConnector(connection(fake.url, groups), () => 5000, { credentials: async () => credentials });
    assert.equal(
      await open(['/aws/lambda/checkout', '/aws/lambda/api']).test(),
      'CloudWatch · 2 log groups readable in us-east-1',
    );
    await assert.rejects(open(['/aws/lambda/chekout']).test(), {
      message:
        'There is no log group /aws/lambda/chekout in us-east-1. Log groups like it: /aws/lambda/api, /aws/lambda/checkout, /aws/lambda/checkout-worker.',
    });
    const signed = String(fake.state.requests[0].headers.authorization);
    assert.match(signed, new RegExp(`^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/us-east-1/logs/aws4_request`));
  } finally {
    await fake.close();
  }
});

test('a service chooses the log groups read, and parts of a search answered with no events are read on', async () => {
  const fake = await startFakeCloudWatch({ events: asEvents(contractLogsFor(40)), accessKeyId: KEY_ID });
  try {
    const connector = new CloudWatchConnector(
      connection(fake.url, ['/aws/lambda/checkout', '/aws/lambda/api']),
      () => 5000,
      { credentials: async () => credentials },
    );
    fake.state.emptyPages = true;
    const result = await connector.fetchLogs({
      query: 'service:checkout level:error',
      fromMs: CONTRACT_START,
      toMs: CONTRACT_START + 60000,
      limit: 100,
      order: 'desc',
    });
    assert.equal(result.records.length, 7, 'the errors of checkout: every sixth log');
    const read = new Set(fake.state.requests.map((request) => request.body.logGroupIdentifier));
    assert.deepEqual([...read], ['/aws/lambda/checkout']);
    assert.match(result.statement, /^\{ \(\$\.level = "error"/);
    assert.deepEqual(
      (await connector.services()).map((service) => service.name),
      ['checkout', 'api'],
    );
  } finally {
    await fake.close();
  }
});

test("a request over the account's rate is sent again after a wait", async () => {
  const fake = await startFakeCloudWatch({ events: asEvents(contractLogsFor(5)), accessKeyId: KEY_ID });
  try {
    const connector = new CloudWatchConnector(connection(fake.url, ['/aws/lambda/checkout']), () => 5000, {
      credentials: async () => credentials,
      retryMs: [1, 1],
    });
    fake.state.throttled = 2;
    const result = await connector.fetchLogs({
      query: '',
      fromMs: CONTRACT_START,
      toMs: CONTRACT_START + 60000,
      limit: 10,
      order: 'desc',
    });
    assert.equal(result.records.length, 3);
  } finally {
    await fake.close();
  }
});

test('expired credentials are read again once, and refusals say which permissions a search needs', async () => {
  const fake = await startFakeCloudWatch({ events: asEvents(contractLogsFor(5)), accessKeyId: KEY_ID });
  try {
    let reads = 0;
    const connector = new CloudWatchConnector(
      { ...connection(fake.url, ['/aws/lambda/checkout']), profile: 'work' },
      () => 5000,
      {
        credentials: async () => {
          reads++;
          return credentials;
        },
      },
    );
    fake.state.expired = 1;
    const result = await connector.fetchLogs({
      query: '',
      fromMs: CONTRACT_START,
      toMs: CONTRACT_START + 60000,
      limit: 10,
      order: 'desc',
    });
    assert.equal(result.records.length, 3);
    assert.equal(reads, 2);
    fake.state.expired = 2;
    await assert.rejects(connector.fetchLogs({ query: '', limit: 10, order: 'desc' }), /aws sso login --profile work/);
  } finally {
    await fake.close();
  }
  const denied = new CloudWatchConnector(connection('http://127.0.0.1:9', ['/x']), () => 5000, {
    fetcher: async () =>
      new Response(JSON.stringify({ __type: 'AccessDeniedException', message: 'not authorized' }), { status: 400 }),
    credentials: async () => credentials,
  });
  await assert.rejects(
    denied.fetchLogs({ query: '', limit: 10, order: 'desc' }),
    /logs:FilterLogEvents and logs:DescribeLogGroups/,
  );
});

function contractLogsFor(count: number): ContractLog[] {
  return Array.from({ length: count }, (_, i) => ({
    timeMs: CONTRACT_START + i * 1000,
    level: i % 3 === 0 ? 'error' : 'info',
    message: `log ${i}`,
    service: i % 2 ? 'api' : 'checkout',
    traceId: `trace${i % 10}`,
  }));
}
