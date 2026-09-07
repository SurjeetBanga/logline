import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery } from './query';
import type { LogEvent } from './types';

const now = Date.now();
const event: LogEvent = { id: 1, level: 'info', message: 'recent', raw: '{}', timestamp: '12:00:00.000', timestampMs: now - 5 * 60000, fields: {} };
test('supports relative and absolute time ranges', () => {
  assert.equal(matchesQuery(event, 'last:15m'), true);
  assert.equal(matchesQuery(event, '-last:1m'), true);
  assert.equal(matchesQuery({ ...event, timestampMs: now - 3600000 }, 'last:15m'), false);
  const start = new Date(now - 10 * 60000).toISOString();
  const end = new Date(now).toISOString();
  assert.equal(matchesQuery(event, `@timestamp:[${start} TO ${end}]`), true);
});
