import assert from 'node:assert/strict';
import test from 'node:test';
import { anyValue, isEntrySpan, logLine, normalizeId, readLogs, readSpans, spanLine } from './core/otlp';
import { decodeLogsRequest, decodeTraceRequest, ProtoError } from './core/otlp-proto';
import { buildTrace, SpanStore } from './core/traces';
import { parseLogLine } from './core/log-event';
import { extractExceptions } from './core/exceptions';
import { getField } from './core/query';
import type { Span } from './core/otlp';

// A tiny protobuf encoder for building wire-format fixtures.
const varint = (value: bigint | number): number[] => {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do { let byte = Number(v & 0x7fn); v >>= 7n; if (v) byte |= 0x80; out.push(byte); } while (v);
  return out;
};
const key = (field: number, wire: number) => varint((field << 3) | wire);
const bytes = (field: number, payload: number[] | Uint8Array) => [...key(field, 2), ...varint(payload.length), ...payload];
const str = (field: number, value: string) => bytes(field, [...Buffer.from(value)]);
const num = (field: number, value: bigint | number) => [...key(field, 0), ...varint(value)];
const fixed64 = (field: number, value: bigint) => { const out = [...key(field, 1)]; for (let i = 0; i < 8; i++) out.push(Number((value >> BigInt(i * 8)) & 0xffn)); return out; };
const double = (field: number, value: number) => { const buffer = Buffer.alloc(8); buffer.writeDoubleLE(value); return [...key(field, 1), ...buffer]; };
// A KeyValue message in the given field: 1 in Resource and KeyValueList, 6 in LogRecord, 9 in Span, 3 in Span.Event.
const kv = (name: string, value: number[], field = 1) => bytes(field, [...str(1, name), ...bytes(2, value)]);
const hexBytes = (hex: string) => [...Buffer.from(hex, 'hex')];
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

test('decodes protobuf log requests into the OTLP/JSON shape', () => {
  const record = [
    ...fixed64(1, 1759500000123456789n), ...num(2, 17), ...str(3, 'ERROR'),
    ...bytes(5, str(1, 'payment declined')),
    ...kv('http.response.status_code', num(3, 502), 6), ...kv('retry', num(2, 1), 6), ...kv('ratio', double(4, 0.25), 6),
    ...kv('neg', num(3, -5n), 6), ...kv('tags', bytes(5, [...bytes(1, str(1, 'a')), ...bytes(1, str(1, 'b'))]), 6),
    ...kv('ctx', bytes(6, kv('user', str(1, 'u1'))), 6),
    ...bytes(9, hexBytes(TRACE)), ...bytes(10, hexBytes('00f067aa0ba902b7')), ...num(99, 1)
  ];
  const request = bytes(1, [
    ...bytes(1, kv('service.name', str(1, 'checkout'))),
    ...bytes(2, [...bytes(1, str(1, 'payments')), ...bytes(2, record)])
  ]);
  const [log] = readLogs(decodeLogsRequest(new Uint8Array(request)));
  assert.equal(log.service, 'checkout');
  assert.equal(log.scope, 'payments');
  assert.equal(log.timeMs, 1759500000123.456);
  assert.equal(log.severityNumber, 17);
  assert.equal(log.body, 'payment declined');
  assert.deepEqual(JSON.parse(JSON.stringify(log.attributes)), { 'http.response.status_code': 502, retry: true, ratio: 0.25, neg: -5, tags: ['a', 'b'], ctx: { user: 'u1' } });
  assert.equal(log.traceId, TRACE);
  assert.equal(log.spanId, '00f067aa0ba902b7');
});

test('decodes protobuf trace requests including status and events', () => {
  const span = [
    ...bytes(1, hexBytes(TRACE)), ...bytes(2, hexBytes('1111111111111111')), ...bytes(4, hexBytes('2222222222222222')),
    ...str(5, 'SELECT orders'), ...num(6, 3), ...fixed64(7, 1000000000n), ...fixed64(8, 1250000000n),
    ...kv('db.system', str(1, 'postgresql'), 9),
    ...bytes(11, [...fixed64(1, 1200000000n), ...str(2, 'exception'), ...kv('exception.type', str(1, 'TimeoutError'), 3)]),
    ...bytes(15, [...str(2, 'deadline exceeded'), ...num(3, 2)])
  ];
  const request = bytes(1, [...bytes(1, kv('service.name', str(1, 'orders'))), ...bytes(2, bytes(2, span))]);
  const [decoded] = readSpans(decodeTraceRequest(new Uint8Array(request)));
  assert.deepEqual([decoded.traceId, decoded.spanId, decoded.parentSpanId, decoded.name, decoded.kind], [TRACE, '1111111111111111', '2222222222222222', 'SELECT orders', 3]);
  assert.deepEqual([decoded.startMs, decoded.endMs, decoded.service], [1000, 1250, 'orders']);
  assert.deepEqual(decoded.status, { code: 2, message: 'deadline exceeded' });
  assert.equal(decoded.attributes['db.system'], 'postgresql');
  assert.deepEqual(decoded.events.map(event => [event.timeMs, event.name, event.attributes['exception.type']]), [[1200, 'exception', 'TimeoutError']]);
});

test('rejects truncated or malformed protobuf input', () => {
  assert.throws(() => decodeLogsRequest(new Uint8Array([0x0a, 0x05, 0x01])), ProtoError);
  assert.throws(() => decodeLogsRequest(new Uint8Array([0x00])), ProtoError);
  assert.throws(() => decodeLogsRequest(new Uint8Array([0x0b])), ProtoError);
  // Deep nesting is refused rather than overflowing the stack.
  let value = str(1, 'leaf');
  for (let i = 0; i < 40; i++) value = bytes(5, bytes(1, value));
  const nested = bytes(1, bytes(2, bytes(2, bytes(5, value))));
  assert.throws(() => decodeLogsRequest(new Uint8Array(nested)), ProtoError);
});

test('reads OTLP/JSON with hex or base64 ids and bounded values', () => {
  const request = { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'web' } }] }, scopeLogs: [{ logRecords: [
    { observedTimeUnixNano: '1700000000000000000', severityText: 'WARN', body: { kvlistValue: { values: [{ key: 'event', value: { stringValue: 'cart' } }] } },
      traceId: Buffer.from(TRACE, 'hex').toString('base64'), spanId: '0000000000000000', attributes: [{ key: 'big', value: { intValue: '9007199254740993' } }] },
    null
  ] }] }] };
  const [log] = readLogs(request, 5);
  assert.equal(log.timeMs, 1700000000000);
  assert.equal(log.traceId, TRACE);
  assert.equal(log.spanId, undefined, 'an all-zero span id means none');
  assert.equal(log.attributes.big, '9007199254740993');
  assert.deepEqual({ ...(log.body as object) }, { event: 'cart' });
  assert.equal(readLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] }, 5)[0].timeMs, 5);
  assert.equal(normalizeId('xyz', 8), undefined);
  assert.equal(String(anyValue({ stringValue: 'x'.repeat(10000) })).length, 4096);
});

test('log records become searchable JSON events with exceptions and locations', () => {
  const [log] = readLogs({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }, { key: 'host.name', value: { stringValue: 'box' } }] }, scopeLogs: [{ logRecords: [{
    timeUnixNano: '1700000000000000000', severityNumber: 17, body: { stringValue: 'charge failed' }, traceId: TRACE,
    attributes: [
      { key: 'exception.type', value: { stringValue: 'CardError' } }, { key: 'exception.message', value: { stringValue: 'declined' } },
      { key: 'exception.stacktrace', value: { stringValue: 'CardError: declined\n    at charge (src/pay.ts:12:3)' } },
      { key: 'code.filepath', value: { stringValue: 'src/pay.ts' } }, { key: 'code.lineno', value: { intValue: 12 } },
      { key: 'message', value: { stringValue: 'shadowed' } }
    ]
  }] }] }] });
  const event = parseLogLine(logLine(log), 'otlp', 1, new Date());
  assert.deepEqual([event.level, event.message, event.timestampMs], ['error', 'charge failed', 1700000000000]);
  assert.equal(getField(event, 'service'), 'api');
  assert.equal(getField(event, 'traceId'), TRACE);
  assert.equal(getField(event, 'attributes.message'), 'shadowed');
  assert.equal(getField(event, 'resource.host.name'), 'box');
  assert.equal(getField(event, 'code.lineno'), 12);
  const [exception] = extractExceptions(event);
  assert.equal(exception.title, 'CardError: charge failed');
  assert.deepEqual(exception.lines[1].source, { file: 'src/pay.ts', line: 12, column: 3 });
});

const span = (id: string, parent: string | undefined, start: number, end: number, extra: Partial<Span> = {}): Span => ({
  traceId: TRACE, spanId: id.padEnd(16, '0'), parentSpanId: parent?.padEnd(16, '0'), name: `op ${id}`, kind: 1, startMs: start, endMs: end,
  service: 'svc', attributes: {}, events: [], status: { code: 0 }, ...extra
});

test('span lines summarize requests for the table', () => {
  const root = span('a', undefined, 1000, 1182.5, { kind: 2, name: 'GET /users', status: { code: 2, message: 'boom' }, attributes: { 'http.response.status_code': 500 },
    events: [{ timeMs: 1100, name: 'exception', attributes: { 'exception.type': 'Boom', 'exception.stacktrace': 'Boom\n    at x (a.js:1:1)' } }] });
  const event = parseLogLine(spanLine(root), 'otlp', 1, new Date());
  assert.deepEqual([event.level, event.message, getField(event, 'durationMs'), getField(event, 'status'), getField(event, 'kind')], ['error', 'GET /users (183 ms)', 182.5, 500, 'span']);
  assert.equal(extractExceptions(event)[0].lines[1].source?.file, 'a.js');
  assert.equal(isEntrySpan(root), true);
  assert.equal(isEntrySpan(span('b', 'a', 0, 1, { kind: 3 })), false);
  assert.equal(isEntrySpan(span('c', 'a', 0, 1, { kind: 2 })), true, 'an incoming request from another service');
});

test('builds a depth-first waterfall with the critical path and orphan roots', () => {
  const spans = [
    span('c', 'a', 1050, 1150, { status: { code: 2 } }), span('a', undefined, 1000, 1200, { service: 'web' }), span('b', 'a', 1010, 1040),
    span('d', 'c', 1060, 1140), span('e', 'missing', 1300, 1310, { service: 'worker' })
  ];
  const view = buildTrace(TRACE, spans, [{ id: 7, level: 'info', message: 'hi', timeMs: 1070, spanId: 'd'.padEnd(16, '0') }]);
  assert.deepEqual(view.spans.map(row => [row.name, row.depth, row.offsetMs, row.critical]), [
    ['op a', 0, 0, false], ['op b', 1, 10, false], ['op c', 1, 50, false], ['op d', 2, 60, false], ['op e', 0, 300, true]
  ]);
  assert.deepEqual([view.durationMs, view.errors, view.services], [310, 1, ['svc', 'web', 'worker']]);
  assert.equal(view.logs[0].offsetMs, 70);
  const single = buildTrace(TRACE, spans.slice(0, 4));
  assert.deepEqual(single.spans.filter(row => row.critical).map(row => row.name), ['op a', 'op c', 'op d']);
  assert.equal(buildTrace(TRACE, spans, [], 2).omitted, 3);
  const logsOnly = buildTrace(TRACE, [], [{ id: 1, level: 'info', message: 'x', timeMs: 50 }, { id: 2, level: 'info', message: 'y', timeMs: 80 }]);
  assert.deepEqual([logsOnly.durationMs, logsOnly.logs.map(log => log.offsetMs)], [30, [0, 30]]);
});

test('cyclic parent links cannot loop the waterfall', () => {
  const view = buildTrace(TRACE, [span('a', 'b', 0, 10), span('b', 'a', 1, 5)]);
  assert.equal(view.spans.length, 0, 'a cycle has no root to start from');
  assert.equal(buildTrace(TRACE, [span('a', 'a', 0, 1)]).spans.length, 1);
});

test('span store keeps traces bounded and ignores resent spans', () => {
  const store = new SpanStore(3);
  assert.equal(store.add(span('a', undefined, 0, 1)), true);
  assert.equal(store.add(span('a', undefined, 0, 1)), false);
  store.add(span('b', 'a', 0, 1));
  store.add(span('c', 'a', 0, 1, { traceId: 'f'.repeat(32) }));
  store.add(span('d', 'a', 0, 1));
  assert.equal(store.size, 3);
  assert.deepEqual(store.trace(TRACE.toUpperCase()).map(item => item.spanId[0]), ['b', 'd']);
  store.clear();
  assert.equal(store.trace(TRACE).length, 0);
});
