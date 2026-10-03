import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Ingestion } from './capture/ingestion';
import { OtlpReceiver } from './capture/otlp-receiver';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { LogStore } from './core/log-store';
import { SpanStore } from './core/traces';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
function harness(settings: Record<string, unknown> = {}, decodeThreshold?: number) {
  const store = new LogStore();
  const registry = new SessionRegistry();
  const spans = new SpanStore();
  const persisted: string[] = [];
  const receiver = new OtlpReceiver({ get<T>(key: string, fallback: T): T { return (key in settings ? settings[key] : fallback) as T; } },
    registry, new Ingestion(store, raw => persisted.push(raw)), new RuntimeState(() => { }), spans, decodeThreshold);
  return { receiver, store, registry, spans, persisted };
}

function post(endpoint: string, path: string, body: string | Buffer, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${endpoint}${path}`, { method, headers: { 'content-type': 'application/json', ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), type: response.headers['content-type'] }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const logs = { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] }, scopeLogs: [{ logRecords: [
  { timeUnixNano: '1700000000000000000', severityText: 'INFO', body: { stringValue: 'order placed' }, traceId: TRACE, spanId: '00f067aa0ba902b7' }
] }] }] };
const traces = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] }, scopeSpans: [{ spans: [
  { traceId: TRACE, spanId: '00f067aa0ba902b7', name: 'POST /orders', kind: 2, startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000150000000' },
  { traceId: TRACE, spanId: '1111111111111111', parentSpanId: '00f067aa0ba902b7', name: 'INSERT', kind: 3, startTimeUnixNano: '1700000000010000000', endTimeUnixNano: '1700000000090000000' }
] }] }] };

test('receives OTLP/JSON logs and traces as Logline sources', async t => {
  const h = harness();
  const status = await h.receiver.start(0);
  t.after(() => h.receiver.stop());
  assert.equal(status.running, true);
  assert.match(status.endpoint!, /^http:\/\/127\.0\.0\.1:\d+$/);
  const logReply = await post(status.endpoint!, '/v1/logs', JSON.stringify(logs));
  assert.deepEqual([logReply.status, logReply.body, logReply.type], [200, '{}', 'application/json']);
  const traceReply = await post(status.endpoint!, '/v1/traces', gzipSync(JSON.stringify(traces)), { 'content-encoding': 'gzip' });
  assert.equal(traceReply.status, 200);
  assert.equal(h.spans.trace(TRACE).length, 2);
  // Only the entry span becomes a row by default.
  assert.deepEqual(h.store.all().map(event => [event.message, event.serverId, event.server]), [
    ['order placed', 'otel:checkout', 'OTel · checkout'], ['POST /orders (150 ms)', 'otel:checkout', 'OTel · checkout']
  ]);
  const [record] = h.registry.records.values();
  assert.deepEqual([record.sourceKind, record.events, record.canStop], ['otel', 2, false]);
  assert.equal((await post(status.endpoint!, '/v1/metrics', '{}')).status, 200);
  assert.equal((await post(status.endpoint!, '/', '', {}, 'GET')).status, 200);
  await h.receiver.stop();
  assert.equal(record.status, 'exited');
  assert.equal(h.receiver.running, false);
});

test('accepts protobuf and reports a protobuf response', async t => {
  const h = harness({ 'otlp.showSpans': 'all' });
  const { endpoint } = await h.receiver.start(0);
  t.after(() => h.receiver.stop());
  // ExportTraceServiceRequest with one span: resource_spans { scope_spans { spans { trace_id, span_id, name, start } } }
  const span = Buffer.concat([Buffer.from([0x0a, 16]), Buffer.from(TRACE, 'hex'), Buffer.from([0x12, 8]), Buffer.from('1111111111111111', 'hex'),
    Buffer.from([0x2a, 1]), Buffer.from('x'), Buffer.from([0x39]), Buffer.from(new BigUint64Array([1700000000000000000n]).buffer)]);
  const scope = Buffer.concat([Buffer.from([0x12, span.length]), span]);
  const resource = Buffer.concat([Buffer.from([0x12, scope.length]), scope]);
  const body = Buffer.concat([Buffer.from([0x0a, resource.length]), resource]);
  const reply = await post(endpoint!, '/v1/traces', body, { 'content-type': 'application/x-protobuf' });
  assert.deepEqual([reply.status, reply.body, reply.type], [200, '', 'application/x-protobuf']);
  assert.equal(h.store.all()[0].message, 'x (0.00 ms)');
});

test('refuses browser, rebinding, malformed, and unsupported requests', async t => {
  const h = harness();
  const { endpoint } = await h.receiver.start(0);
  t.after(() => h.receiver.stop());
  const port = new URL(endpoint!).port;
  assert.equal((await post(endpoint!, '/v1/logs', JSON.stringify(logs), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(endpoint!, '/v1/logs', JSON.stringify(logs), { host: `evil.example:${port}` })).status, 403);
  assert.equal((await post(endpoint!, '/v1/logs', JSON.stringify(logs), { host: `localhost:${port}` })).status, 200);
  assert.equal((await post(endpoint!, '/v1/logs', 'hello', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(endpoint!, '/v1/logs', '{nope')).status, 400);
  assert.equal((await post(endpoint!, '/v1/traces', Buffer.from([0x0a, 0x05]), { 'content-type': 'application/x-protobuf' })).status, 400);
  assert.equal((await post(endpoint!, '/v1/logs', 'x', { 'content-encoding': 'br' })).status, 415);
  assert.equal((await post(endpoint!, '/v1/logs', 'not gzip', { 'content-encoding': 'gzip' })).status, 400);
  assert.equal((await post(endpoint!, '/v1/logs', '{}', {}, 'PUT')).status, 405);
  assert.equal((await post(endpoint!, '/other', '{}')).status, 404);
  assert.equal(h.store.all().length, 1, 'only the loopback request was accepted');
});

test('falls back to another port instead of taking one that is in use', async t => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const taken = (blocker.address() as AddressInfo).port;
  const h = harness();
  const status = await h.receiver.start(taken);
  t.after(() => h.receiver.stop());
  assert.equal(status.running, true);
  assert.notEqual(new URL(status.endpoint!).port, String(taken));
  assert.match(status.error!, new RegExp(`Port ${taken} is in use`));
});

test('services that only send spans are still sources', () => {
  const h = harness({ 'otlp.showSpans': 'none' });
  assert.equal(h.receiver.acceptSpans(traces), 2);
  assert.equal(h.store.all().length, 0);
  assert.deepEqual([...h.registry.records.values()].map(record => [record.serverId, record.events]), [['otel:checkout', 0]]);
});

test('large requests are decoded on a worker thread and added in steps', async t => {
  const h = harness({}, 1);
  const { endpoint } = await h.receiver.start(0);
  t.after(() => h.receiver.stop());
  const records = Array.from({ length: 1200 }, (_, index) => ({ timeUnixNano: '1700000000000000000', body: { stringValue: `record ${index}` } }));
  const request = { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'bulk' } }] }, scopeLogs: [{ logRecords: records }] }] };
  let turns = 0;
  const ticker = setInterval(() => turns++, 0);
  const reply = await post(endpoint!, '/v1/logs', JSON.stringify(request));
  clearInterval(ticker);
  assert.equal(reply.status, 200);
  assert.equal(h.store.all().length, 1200);
  assert.equal(h.store.all().at(-1)?.message, 'record 1199');
  assert.equal(h.persisted.length, 1200, 'received records are written to latest.log when persistence is on');
  assert.ok(turns > 0, 'the event loop keeps turning while a large request is processed');
  assert.equal((await post(endpoint!, '/v1/logs', '{nope')).status, 400, 'malformed bodies are reported from the worker');
  const span = Buffer.concat([Buffer.from([0x0a, 16]), Buffer.from(TRACE, 'hex'), Buffer.from([0x12, 8]), Buffer.from('1111111111111111', 'hex'),
    Buffer.from([0x39]), Buffer.from(new BigUint64Array([1700000000000000000n]).buffer)]);
  const scope = Buffer.concat([Buffer.from([0x12, span.length]), span]);
  const resource = Buffer.concat([Buffer.from([0x12, scope.length]), scope]);
  const body = Buffer.concat([Buffer.from([0x0a, resource.length]), resource]);
  assert.equal((await post(endpoint!, '/v1/traces', body, { 'content-type': 'application/x-protobuf' })).status, 200);
  assert.equal(h.spans.trace(TRACE).length, 1);
});
