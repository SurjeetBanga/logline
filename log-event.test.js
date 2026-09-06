const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLogLine, normalizeLevel, stripAnsi } = require('./log-event');
const now = new Date('2026-09-06T18:00:00.123Z');

test('extracts common fields from JSON logs', () => {
  const event = parseLogLine('{"level":"warn","message":"Slow request","requestId":"abc"}', 'stdout', 7, now);
  assert.equal(event.id, 7); assert.equal(event.level, 'warn');
  assert.equal(event.message, 'Slow request'); assert.equal(event.isJson, true);
  assert.equal(JSON.parse(event.raw).requestId, 'abc');
});
test('keeps plain logs and treats stderr as errors', () => {
  const event = parseLogLine('Connection failed', 'stderr', 1, now);
  assert.equal(event.level, 'error'); assert.equal(event.message, 'Connection failed');
  assert.equal(event.isJson, false);
});
test('normalizes levels and strips ANSI', () => {
  assert.equal(normalizeLevel('WARNING', 'stdout'), 'warn');
  assert.equal(normalizeLevel('critical', 'stdout'), 'fatal');
  assert.equal(stripAnsi('\u001b[31merror\u001b[0m'), 'error');
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
test('extracts only known primitive fields', () => {
  const event = parseLogLine('{"service":"api","status":500,"ok":true,"nested":{"a":1},"junk":"ignored key"}', 'stdout', 1, now);
  assert.deepEqual(event.fields, { service: 'api', status: 500 });
});
test('truncates very long messages', () => {
  const event = parseLogLine(JSON.stringify({ message: 'x'.repeat(1000) }), 'stdout', 1, now);
  assert.equal(event.message.length, 512);
});
