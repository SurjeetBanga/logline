import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogLine } from './log-event';
import { appFrames, RuntimeErrorTracker, runtimeErrorText } from './runtime-errors';
import type { LogEvent } from './types';

const json = (id: number, value: object): LogEvent => ({
  ...parseLogLine(JSON.stringify(value), 'stdout', id, new Date(0)),
  timestampMs: 1000 * id,
});
const nodeStack = (message: string, line: number) =>
  [
    `TypeError: ${message}`,
    '    at Object.charge (/srv/app/node_modules/stripe/lib/index.js:10:5)',
    `    at charge (/srv/app/src/lib/payments.ts:${line}:20)`,
    '    at checkout (/srv/app/src/routes/checkout.ts:22:9)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');
const failure = (id: number, line = 40, message = "Cannot read properties of undefined (reading 'card')") =>
  json(id, {
    level: 'error',
    msg: 'checkout failed',
    err: { type: 'TypeError', message, stack: nodeStack(message, line) },
  });

test('the frames of an error are the app code it ran through, innermost first', () => {
  const found = appFrames(failure(1));
  assert.equal(found?.message, "TypeError: Cannot read properties of undefined (reading 'card')");
  assert.deepEqual(
    found?.frames.map((frame) => `${frame.file}:${frame.line}`),
    ['/srv/app/src/lib/payments.ts:40', '/srv/app/src/routes/checkout.ts:22'],
  );
  const python = parseLogLine(
    'Traceback (most recent call last):\n  File "/app/service/orders.py", line 12, in load\n    return db[id]\nKeyError: 7',
    'stderr',
    2,
    new Date(0),
  );
  assert.equal(appFrames({ ...python, level: 'error' })?.frames[0].file, '/app/service/orders.py');
});

test('events without a stack, or below error, mark no line', () => {
  assert.equal(appFrames(json(1, { level: 'error', msg: 'payment declined' })), undefined);
  assert.equal(appFrames({ ...failure(2), level: 'warn' }), undefined);
  const dependencyOnly = json(3, {
    level: 'error',
    err: { message: 'x', stack: 'Error: x\n    at f (/srv/node_modules/a/b.js:1:1)\n    at node:internal/x:2:3' },
  });
  assert.equal(appFrames(dependencyOnly), undefined);
});

test('the tracker counts each error by its line and follows retention', () => {
  const tracker = new RuntimeErrorTracker();
  assert.equal(tracker.process([failure(1), failure(2), failure(3, 41), json(4, { level: 'info', msg: 'ok' })]), true);
  const [newest, older] = tracker.list();
  assert.deepEqual(
    [newest.count, newest.frames[0].line, older.count, older.lastId, older.lastSeen],
    [1, 41, 2, 2, 2000],
  );
  assert.ok(older.query, 'the error has a search for its events');
  // Already counted events are skipped.
  assert.equal(tracker.process([failure(2)]), false);
  const revision = tracker.revision;
  assert.equal(tracker.evict(2), true);
  assert.equal(tracker.list().find((error) => error.frames[0].line === 40)?.count, 1);
  assert.equal(tracker.evict(4), true);
  assert.equal(tracker.list().length, 0);
  assert.ok(tracker.revision > revision);
  tracker.reset();
  assert.equal(tracker.watermark, 0);
});

test('the marked line says the error, how often, and how long ago', () => {
  const tracker = new RuntimeErrorTracker();
  tracker.process([failure(1), failure(2)]);
  assert.equal(
    runtimeErrorText(tracker.list()[0], 7000),
    "TypeError: Cannot read properties of undefined (reading 'card') · 2× · 5s ago",
  );
  assert.equal(runtimeErrorText(tracker.list()[0], 7000, 12), 'TypeError: … · 2× · 5s ago');
});
