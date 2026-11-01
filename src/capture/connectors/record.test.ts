import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogFields } from './record';

test('a fetched log becomes a JSON line, with its time when it has one', () => {
  const fields = new LogFields(new Set(['message', 'level']));
  fields.put('level', 'error');
  fields.put('service', null);
  fields.message('\x1b[31mpayment declined\x1b[0m');
  // An attribute named like an event field is kept apart, so it cannot replace the event's own.
  fields.attribute('level', 'custom');
  fields.attribute('orderId', 42);
  assert.deepEqual(fields.record('2026-11-01T10:00:00.000Z'), {
    line: JSON.stringify({ level: 'error', message: 'payment declined', 'attributes.level': 'custom', orderId: 42 }),
    timeMs: Date.parse('2026-11-01T10:00:00.000Z'),
  });
  assert.equal(new LogFields(new Set()).record(1_700_000_000_000).timeMs, 1_700_000_000_000);
  assert.equal(new LogFields(new Set()).record('not a time').timeMs, undefined);
  assert.equal(new LogFields(new Set()).record(undefined).timeMs, undefined);
});
