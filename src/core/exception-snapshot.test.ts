import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SNAPSHOT_LIMITS, snapshotPlace, snapshotRecord, snapshotSummary } from './exception-snapshot';

const frame = {
  name: 'charge',
  file: '/w/src/payments.py',
  line: 42,
  variables: [
    { name: 'total', value: '19.9' },
    { name: 'ok', value: 'false' },
    { name: 'note', value: "'card missing'" },
    {
      name: 'user',
      value: "{'id': 'u_42', 'token': 'abc'}",
      children: [
        { name: 'id', value: "'u_42'" },
        { name: 'token', value: "'abc'" },
        { name: 'special variables', value: '' },
      ],
    },
    { name: 'function variables', value: '' },
  ],
};

test('a snapshot records the exception and the innermost locals as values, redacted', () => {
  const record = snapshotRecord({ type: 'KeyError', message: "'card'", frames: [frame] });
  assert.deepEqual(record, {
    level: 'error',
    message: "Exception: KeyError 'card' · charge() payments.py:42",
    kind: 'exception-snapshot',
    exception: { type: 'KeyError', message: "'card'" },
    function: 'charge',
    file: '/w/src/payments.py',
    line: 42,
    locals: { total: 19.9, ok: false, note: 'card missing', user: { id: 'u_42', token: '[REDACTED]' } },
  });
});

test('callers are kept up to three frames, and dropped first when a snapshot is too big', () => {
  const caller = (line: number) => ({ name: 'outer', file: '/w/src/api.py', line, variables: [] });
  const kept = snapshotRecord({ frames: [frame, caller(1), caller(2), caller(3)] });
  assert.equal((kept.callers as unknown[]).length, 2);
  assert.match(String(kept.message), /^Exception: raised · charge\(\)/);

  const big = (name: string) => ({ name, value: 'x'.repeat(SNAPSHOT_LIMITS.value) });
  const huge = snapshotRecord({
    frames: [
      { ...frame, variables: Array.from({ length: 30 }, (_, i) => big(`v${i}`)) },
      { ...caller(1), variables: [big('outer')] },
    ],
  });
  assert.ok(JSON.stringify(huge).length <= SNAPSHOT_LIMITS.bytes);
  assert.equal(huge.callers, undefined);
  assert.ok(Object.keys(huge.locals as object).length > 0, 'the innermost frame keeps what fits');
});

test("a snapshot's summary names its frame and locals, and its place matches a stack's", () => {
  const record = snapshotRecord({ type: 'KeyError', frames: [frame] });
  assert.deepEqual(snapshotSummary(record), {
    place: 'payments.py:42',
    text: 'in charge(): total = 19.9, ok = false, note = card missing, user = {"id":"u_42","token":"[REDACTED]"}',
  });
  assert.equal(snapshotPlace('C:\\w\\src\\payments.py', 42), 'payments.py:42');
  assert.equal(snapshotSummary({ kind: 'other' }), undefined);
});
