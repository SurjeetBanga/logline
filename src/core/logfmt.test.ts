import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogLine } from './log-event';
import { parseLogfmt } from './logfmt';
import { LogStore } from './log-store';

const receivedAt = new Date('2026-10-03T12:00:00Z');

test('logfmt lines become structured events with level, message, time and typed fields', () => {
  const event = parseLogLine(
    'time=2026-10-03T10:00:00.250Z level=warn msg="slow query \\"users\\"" durationMs=212 user=42 db=main',
    'stdout',
    1,
    receivedAt,
  );
  assert.equal(event.level, 'warn');
  assert.equal(event.message, 'slow query "users"');
  assert.equal(event.timestampMs, Date.parse('2026-10-03T10:00:00.250Z'));
  assert.deepEqual(event.fields, { durationMs: 212, user: 42, db: 'main' });
  assert.equal(event.isJson, false, 'logfmt keeps its raw text rather than claiming to be JSON');
});

test('logfmt fields are searchable and analyzable like JSON fields', () => {
  const store = new LogStore();
  store.add(parseLogLine('level=info msg=ok status=200 durationMs=12', 'stdout', 1, receivedAt));
  store.add(parseLogLine('level=error msg="upstream failed" status=502 durationMs=900', 'stdout', 2, receivedAt));
  assert.deepEqual(
    store.page({ query: 'status:5xx durationMs:>500' }).events.map((event) => event.id),
    [2],
  );
  assert.deepEqual(
    store.page({ levels: ['error'] }).events.map((event) => event.message),
    ['upstream failed'],
  );
  assert.ok(store.columnFields().includes('durationMs'));
});

test('ordinary text containing = stays plain text', () => {
  for (const line of [
    'PATH=/usr/bin',
    'hello world a=1 b=2',
    'Compiled 3 files (cache=hit) in 2s',
    'a=1 b="unterminated',
    'key=value "quoted" other=1',
    '[info] x=1 y=2',
    'x="a"b y=2',
  ]) {
    assert.equal(parseLogfmt(line), undefined, line);
    assert.deepEqual(parseLogLine(line, 'stdout', 1, receivedAt).fields, {}, line);
  }
});

test('logfmt parsing keeps the first duplicate key, empty values and special keys safely', () => {
  const fields = parseLogfmt('a=1 a=2 empty= __proto__=x http.method=GET');
  assert.equal(fields?.a, 1);
  assert.equal(fields?.empty, '');
  assert.equal(fields?.['http.method'], 'GET');
  assert.equal(Object.getPrototypeOf(fields), Object.prototype);
  assert.equal(Object.hasOwn(fields!, '__proto__'), true);
});
