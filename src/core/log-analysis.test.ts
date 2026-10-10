import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeEvents, findPatterns, groupErrors, normalizeMessage, patternText, templateQuery } from './log-analysis';
import { matchesQuery } from './query';
import type { LogEvent } from './types';

const start = Date.parse('2026-10-04T12:00:00Z');
let nextId = 0;
function event(message: string, extra: Partial<LogEvent> & { at?: number } = {}): LogEvent {
  const { at = nextId, ...rest } = extra;
  return {
    id: ++nextId,
    level: 'info',
    message,
    raw: message,
    timestamp: '',
    timestampMs: start + at * 1000,
    fields: {},
    ...rest,
  };
}

test('numbers with units do not split one message into many patterns or error groups', () => {
  assert.equal(
    normalizeMessage('timeout after 48ms for order 1234'),
    normalizeMessage('timeout after 1.5s for order 98'),
  );
  assert.equal(normalizeMessage('request 9f1c2d3e-0a1b-4c5d-8e9f-001122334455 done'), 'request <id> done');
  assert.equal(patternText('POST /api/orders/12 completed in 48ms (2 waiting)'), 'POST * completed in * (* waiting)');
  const events = [48, 110, 1130, 7].map((ms) => event(`Payment provider timeout after ${ms}ms`, { level: 'error' }));
  assert.equal(findPatterns(events).length, 1);
  assert.equal(groupErrors(events).length, 1);
});

test('an error logged with and without its stack is one group', () => {
  const stack = 'Error: Database connection refused\n    at connect (/srv/db.js:12:3)';
  const events = [
    event('Database connection refused', { level: 'error', raw: stack, fields: { stack } }),
    event('Database connection refused', { level: 'error' }),
    event('Database connection refused', { level: 'error' }),
  ];
  const groups = groupErrors(events);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].location, '/srv/db.js:12');
});

test('a few far-away timestamps do not stretch the time charts, and the real edges stay in', () => {
  nextId = 0;
  const events = Array.from({ length: 1000 }, (_, i) => event('steady', { at: i }));
  // Plain lines stamped on arrival, hours after the replayed logs.
  events.push(...Array.from({ length: 3 }, () => event('cache warmed', { timestampMs: start + 6 * 3600_000 })));
  const analysis = analyzeEvents(events);
  assert.equal(analysis.range.from, start);
  assert.equal(analysis.range.to, start + 999_000);
  assert.equal(analysis.summary!.outside, 3);
  assert.equal(
    analysis.rate.reduce((sum, item) => sum + item.count, 0),
    1000,
  );
  assert.equal(analysis.summary!.events, 1003, 'the outliers still count everywhere else');
});

test('the summary reports errors, sources and latency percentiles', () => {
  const events = Array.from({ length: 100 }, (_, i) =>
    event('GET /api done', {
      level: i < 5 ? 'error' : 'info',
      serverId: i % 2 ? 'api' : 'worker',
      fields: { durationMs: i + 1, status: i === 99 ? 503 : 200 },
    }),
  );
  const { summary, statusCodes } = analyzeEvents(events);
  assert.equal(summary!.errors, 6, 'error levels and 5xx statuses');
  assert.equal(summary!.sources, 2);
  assert.deepEqual(summary!.latency, { p50: 51, p95: 96, p99: 100, count: 100 });
  assert.deepEqual(statusCodes, [
    { code: '200', count: 99 },
    { code: '503', count: 1 },
  ]);
});

test('top values break results down by categorical fields, not by ids or prose', () => {
  const events = Array.from({ length: 200 }, (_, i) =>
    event('handled', {
      serverId: i % 4 ? 'api' : 'worker',
      server: i % 4 ? 'API' : 'Worker',
      fields: {
        service: i % 3 ? 'api' : 'billing',
        requestId: `req-${i}`,
        region: 'eu',
        path: `/items/${i % 2}`,
        note: 'x'.repeat(100),
        level: 'info',
      },
    }),
  );
  const facets = analyzeEvents(events).topValues!;
  assert.deepEqual(
    facets.map((facet) => facet.field),
    ['serverId', 'service', 'path'],
  );
  assert.deepEqual(facets[0].values[0], { value: 'api', label: 'API', count: 150 });
  assert.deepEqual(facets[1].values, [
    { value: 'api', count: 133 },
    { value: 'billing', count: 67 },
  ]);
});

test('patterns and error groups carry a search for their events and say when they are new', () => {
  nextId = 0;
  const events = [
    ...Array.from({ length: 50 }, (_, i) => event(`POST /api/orders/${i} completed in ${i}ms`, { at: i * 10 })),
    ...Array.from({ length: 5 }, (_, i) => event(`Cache miss for key user:${i}`, { level: 'error', at: 450 + i })),
  ];
  const patterns = findPatterns(events);
  const [completed, miss] = patterns;
  assert.equal(completed.query, 'message:"post" message:"completed in"');
  assert.equal(completed.isNew, false);
  assert.equal(miss.isNew, true);
  for (const pattern of patterns) {
    assert.equal(events.filter((item) => matchesQuery(item, pattern.query!)).length, pattern.count, pattern.key);
  }
  assert.equal(groupErrors(events)[0].isNew, true);
  assert.equal(templateQuery('<n> <id>'), undefined, 'nothing literal to search for');
});
