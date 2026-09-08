import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLine, normalizeLevel, stripAnsi } from './log-event';
const now = new Date('2026-09-06T18:00:00.123Z');

test('extracts common fields from JSON logs', () => {
  const event = parseLogLine('{"level":"warn","message":"Slow request","requestId":"abc"}', 'stdout', 7, now);
  assert.equal(event.id, 7); assert.equal(event.level, 'warn');
  assert.equal(event.message, 'Slow request'); assert.equal(event.isJson, true);
  assert.equal(JSON.parse(event.raw!).requestId, 'abc');
});
test('keeps plain logs and treats stderr as errors', () => {
  const event = parseLogLine('Connection failed', 'stderr', 1, now);
  assert.equal(event.level, 'error'); assert.equal(event.message, 'Connection failed');
  assert.equal(event.isJson, false);
});
test('normalizes levels and strips ANSI', () => {
  assert.equal(normalizeLevel('WARNING', 'stdout'), 'warn');
  assert.equal(normalizeLevel('critical', 'stdout'), 'fatal');
  assert.equal(stripAnsi('[31merror[0m'), 'error');
});
test('prefers an explicit timestamp field over the received time', () => {
  const event = parseLogLine('{"time":"2026-01-01T00:00:00.000Z","message":"hi"}', 'stdout', 1, now);
  assert.equal(event.timestampMs, Date.parse('2026-01-01T00:00:00.000Z'));
});
test('falls back to the received time when the timestamp field is unparseable', () => {
  const event = parseLogLine('{"timestamp":"not a date","message":"hi"}', 'stdout', 1, now);
  assert.equal(event.timestampMs, now.getTime());
});
test('derives a message for non-object JSON and array payloads', () => {
  assert.equal(parseLogLine('"just a string"', 'stdout', 1, now).message, 'just a string');
  assert.equal(parseLogLine('42', 'stdout', 1, now).message, 'JSON event');
  assert.equal(parseLogLine('[1,2,3]', 'stdout', 1, now).message, 'Array (3 items)');
  assert.equal(parseLogLine('{"unrelated":"field"}', 'stdout', 1, now).message, 'JSON event');
});
test('extracts primitive payload fields and skips nested objects', () => {
  const event = parseLogLine('{"service":"api","status":500,"ok":true,"nested":{"a":1},"junk":"ignored key"}', 'stdout', 1, now);
  assert.deepEqual(event.fields, { service: 'api', status: 500, ok: true, 'nested.a': 1, a: 1, junk: 'ignored key' });
});
test('truncates very long messages', () => {
  const event = parseLogLine(JSON.stringify({ message: 'x'.repeat(1000) }), 'stdout', 1, now);
  assert.equal(event.message!.length, 512);
});
test('reads Log4j2 JsonLayout timeMillis when there is no other timestamp field', () => {
  const event = parseLogLine('{"timeMillis":1735689600000,"message":"hi"}', 'stdout', 1, now);
  assert.equal(event.timestampMs, 1735689600000);
});
test('flattens Log4j2 contextMap (MDC) values into searchable fields', () => {
  const event = parseLogLine(
    '{"level":"INFO","message":"hi","contextMap":{"runId":"r1","traceId":"t1","big":{"a":1},"count":3}}',
    'stdout', 1, now);
  assert.deepEqual(event.fields, { runId: 'r1', traceId: 't1', count: 3 });
});
test('a top-level field wins over the same key in contextMap', () => {
  const event = parseLogLine('{"traceId":"top","contextMap":{"traceId":"nested"}}', 'stdout', 1, now);
  assert.equal(event.fields!.traceId, 'top');
});
test('nested field flattening stops after four levels to bound extraction cost', () => {
  const shallow = parseLogLine('{"a":{"b":{"c":{"d":5}}}}', 'stdout', 1, now);
  assert.equal(shallow.fields!.d, 5);
  assert.equal(shallow.fields!['a.b.c.d'], 5);
  const deep = parseLogLine('{"a":{"b":{"c":{"d":{"e":5}}}}}', 'stdout', 2, now);
  assert.equal(deep.fields!.e, undefined);
  assert.equal(deep.fields!['a.b.c.d.e'], undefined);
});
