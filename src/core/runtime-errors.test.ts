import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogLine } from './log-event';
import { appFrames, RuntimeErrorTracker, runtimeErrorText, testFailureFrames } from './runtime-errors';
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

const ciFailure = (id: number, fields: Record<string, unknown> = {}) =>
  json(id, {
    level: 'error',
    msg: '✕ cart › adds items',
    kind: 'test-failure',
    test: 'cart › adds items',
    file: 'src/cart.test.ts',
    line: 12,
    run: 1,
    job: 'build',
    ...fields,
  });

test('a failed CI test is placed by its file, with a compiled file mapped to its source at line 0', () => {
  const found = testFailureFrames(ciFailure(1));
  assert.deepEqual(found, {
    message: '✕ cart › adds items',
    frames: [{ file: 'src/cart.test.ts', line: 12, column: 0 }],
    test: 'cart › adds items',
    ci: 'CI #1 · build',
  });
  assert.equal(testFailureFrames(ciFailure(2, { line: undefined }))?.frames[0].line, 0);
  for (const file of [
    'out-tests/capture/x.test.js',
    'out/capture/x.test.js',
    'dist/capture/x.test.cjs',
    'build/capture/x.test.mjs',
    'lib/capture/x.test.js',
  ])
    assert.deepEqual(
      testFailureFrames(ciFailure(3, { file }))?.frames.map((frame) => `${frame.file}:${frame.line}`),
      ['ts', 'tsx', 'mts', 'js'].map((extension) => `src/capture/x.test.${extension}:0`),
      file,
    );
  assert.equal(testFailureFrames(ciFailure(4, { run: undefined, job: undefined }))?.ci, 'CI');
  assert.equal(testFailureFrames(ciFailure(5, { kind: 'ci' })), undefined);
  assert.equal(testFailureFrames(ciFailure(6, { test: 7 })), undefined);
  assert.equal(testFailureFrames(ciFailure(7, { file: undefined })), undefined);
});

test('the same failed test in two CI runs is one error, with the newest run and a search for it', () => {
  const tracker = new RuntimeErrorTracker();
  tracker.process([ciFailure(1), ciFailure(2, { run: 2, job: 'test' }), failure(3)]);
  const errors = tracker.list();
  assert.equal(errors.length, 2);
  const ci = errors.find((error) => error.test)!;
  assert.deepEqual(
    [ci.count, ci.ci, ci.test, ci.query, ci.message, ci.lastId],
    [2, 'CI #2 · test', 'cart › adds items', 'kind:test-failure test:"cart › adds items"', '✕ cart › adds items', 2],
  );
  const ordinary = errors.find((error) => !error.test)!;
  assert.deepEqual([ordinary.count, ordinary.ci], [1, undefined]);
  tracker.process([ciFailure(4, { test: 'cart › removes items' })]);
  assert.equal(tracker.list().length, 3, 'another test is another error');
});

test('a CI failure says where it failed, and how often only when more than once', () => {
  const tracker = new RuntimeErrorTracker();
  tracker.process([ciFailure(1)]);
  assert.equal(runtimeErrorText(tracker.list()[0], 6000), '✕ cart › adds items · failed in CI #1 · build · 5s ago');
  tracker.process([ciFailure(2)]);
  assert.equal(
    runtimeErrorText(tracker.list()[0], 6000),
    '✕ cart › adds items · failed in CI #1 · build · 2× · 4s ago',
  );
});

test('a test failing on this machine says the command it failed in, apart from the same test failing in CI', () => {
  const tracker = new RuntimeErrorTracker();
  const local = (id: number) => ciFailure(id, { run: undefined, job: undefined, scope: 'local', command: 'npm test' });
  tracker.process([local(1), ciFailure(2)]);
  const errors = tracker.list();
  assert.equal(errors.length, 2, 'a local failure and a CI failure of one test are two marks');
  const mark = errors.find((error) => error.local)!;
  assert.deepEqual([mark.local, mark.ci], ['npm test', undefined]);
  assert.equal(runtimeErrorText(mark, 6000), '✕ cart › adds items · failed locally · npm test · 5s ago');
});

test("an exception snapshot's locals join the error raised at its place, before or after it", () => {
  const snapshot = (id: number, total: number) =>
    json(id, {
      level: 'error',
      message: 'Exception: TypeError boom · charge() payments.ts:40',
      kind: 'exception-snapshot',
      function: 'charge',
      file: '/home/me/app/src/lib/payments.ts',
      line: 40,
      locals: { total },
    });
  const crash = (id: number) =>
    json(id, {
      level: 'error',
      msg: 'failed',
      err: {
        type: 'TypeError',
        message: 'boom',
        stack: 'TypeError: boom\n    at charge (/srv/app/src/lib/payments.ts:40:20)',
      },
    });
  const tracker = new RuntimeErrorTracker();
  tracker.process([snapshot(1, 19.9)]);
  assert.equal(tracker.list().length, 0, 'a snapshot is not an error of its own');
  tracker.process([crash(2)]);
  assert.equal(tracker.list()[0].locals, 'in charge(): total = 19.9');
  assert.equal(tracker.list()[0].count, 1);
  tracker.process([snapshot(3, 5)]);
  assert.equal(tracker.list()[0].locals, 'in charge(): total = 5', 'a newer snapshot updates the error already marked');
});
