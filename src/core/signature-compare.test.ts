import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLogLine } from './log-event';
import { matchesQuery } from './query';
import {
  compareSignatures,
  compareTestFailures,
  differingFields,
  hasTestFailures,
  summarizeComparison,
} from './signature-compare';
import type { LogEvent } from './types';

let id = 0;
const event = (level: string, message: string, fields: Record<string, unknown> = {}): LogEvent =>
  parseLogLine(JSON.stringify({ level, message, ...fields }), 'stdout', ++id, new Date('2026-10-23T09:00:00Z'));
const repeat = (count: number, make: () => LogEvent) => Array.from({ length: count }, make);

test('production errors are reproduced, fixed, new, local only, or not seen', () => {
  const timeout = (ms: number) => event('error', `TimeoutError: payment gateway after ${ms} ms`, { region: 'eu' });
  const currency = () => event('error', "KeyError: 'currency' in apply_discount");
  const production = [...repeat(3, () => timeout(5000)), currency(), event('info', 'order placed')];
  const run14 = [timeout(800), timeout(800), event('error', 'ValueError: negative quantity 7')];
  const run15 = [event('error', 'ValueError: negative quantity 2'), event('error', 'cache miss for user 12')];
  const rows = compareSignatures(production, [run14, run15]);
  assert.deepEqual(
    rows.map((row) => [row.pattern, row.baseline, row.runs, row.status]),
    [
      // The timeout stopped in the newest run: fixed. Numbers in a message never split a signature.
      ['TimeoutError: payment gateway after * ms', 3, [2, 0], 'fixed'],
      ['cache miss for user *', 0, [0, 1], 'new'],
      ['ValueError: negative quantity *', 0, [1, 1], 'localOnly'],
      ["KeyError: 'currency' in apply_discount", 1, [0, 0], 'notSeen'],
    ],
  );
  assert.ok(rows[0].baselineSample! < rows[0].localSample!, 'a sample from each side');
  assert.match(rows[0].query ?? '', /payment gateway/);
  const reproduced = compareSignatures(production, [run14]);
  assert.equal(reproduced[0].status, 'reproduced');
  // With one local run, an error production does not have is local only, not new.
  assert.equal(reproduced.find((row) => row.pattern.startsWith('ValueError'))?.status, 'localOnly');
  assert.deepEqual(compareSignatures([], []), []);
});

test('the same failure matches across machines, whatever its stack paths and lines', () => {
  const crash = (file: string, line: number) =>
    event('error', 'TypeError: Cannot read properties of undefined', {
      stack: `TypeError: Cannot read properties of undefined\n    at charge (${file}:${line}:9)`,
    });
  const rows = compareSignatures([crash('/srv/app/dist/pay.js', 88)], [[crash('/Users/me/shop/dist/pay.js', 91)]]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reproduced');
  // Where the local run threw it, without directories.
  assert.equal(rows[0].location, 'pay.js:91');
});

test('new errors from changed code are marked, and the summary says what a run did', () => {
  const production = [event('error', 'TimeoutError: payment gateway after 5000 ms')];
  const before = [event('error', 'TimeoutError: payment gateway after 800 ms')];
  const fromChange = event('error', 'ValueError: negative quantity 3', { 'code.filepath': 'cart.ts' });
  const elsewhere = event('error', 'cache miss for user 12');
  const rows = compareSignatures(
    production,
    [before, [fromChange, elsewhere]],
    (candidate) => candidate === fromChange,
  );
  assert.deepEqual(
    rows.map((row) => [row.status, row.changed ?? false]),
    [
      ['fixed', false],
      ['new', false],
      ['new', true],
    ],
  );
  assert.equal(summarizeComparison(rows), '1 production error fixed locally · 2 new local errors, 1 from your changes');
  assert.equal(
    summarizeComparison(compareSignatures(production, [before, [fromChange]], () => true)),
    '1 production error fixed locally · 1 new local error from your changes',
  );
  assert.equal(summarizeComparison(compareSignatures(production, [before])), '1 production error reproduced');
  assert.equal(summarizeComparison([]), 'No errors in production or the newest run.');
  assert.equal(
    summarizeComparison(compareSignatures(production, [[event('info', 'ok')]])),
    'None of the production errors occurred in the newest run.',
  );
  assert.equal(compareSignatures(production, [before, [fromChange, elsewhere]], undefined, 1).length, 1);
});

test('fields that differ between two events are listed for highlighting', () => {
  const prod = event('error', 'timeout', { region: 'eu-west', retries: 3, gateway: 'adyen', timeoutMs: 5000 });
  const local = event('error', 'timeout', { retries: 0, gateway: 'adyen', timeoutMs: 800 });
  assert.deepEqual(differingFields(prod, local).sort(), ['region', 'retries', 'timeoutMs']);
  assert.deepEqual(differingFields(local, local), []);
});

const ciFailure = (testName: string, fields: Record<string, unknown> = {}) =>
  event('error', `✕ ${testName}`, { kind: 'test-failure', test: testName, file: 'out-tests/cart.test.js', ...fields });
const output = (...lines: string[]) => event('info', lines.join('\n'));

test('CI test failures are told apart from errors', () => {
  assert.equal(hasTestFailures([event('error', 'x'), ciFailure('a')]), true);
  assert.equal(hasTestFailures([event('error', 'x', { kind: 'ci' })]), false);
});

test('tests that failed in CI are matched with the failures local runner output names', () => {
  const baseline = [
    ciFailure('adds items', { line: 12, file: 'src/cart.test.ts' }),
    ciFailure('adds items'),
    ciFailure('removes items'),
    ciFailure('totals'),
    ciFailure('refunds'),
    // The job's own lines are not read again, so counts are not doubled.
    event('error', '✖ adds items (1ms)', { kind: 'ci' }),
  ];
  const run1 = [output('✖ totals (3ms)', 'ok 2 - fine'), output('not ok 1 - brand new')];
  const run2 = [
    output('✖ adds items (1ms)', 'FAILED tests/t.py::test_total - boom'),
    output('not ok 3 - brand new'),
    output('not ok 4 - only now'),
  ];
  const rows = compareTestFailures(baseline, [run1, run2]);
  const byName = Object.fromEntries(rows.map((row) => [row.signature, row]));
  assert.deepEqual(
    rows.map((row) => [row.signature, row.baseline, row.runs, row.status]),
    [
      ['adds items', 2, [0, 1], 'reproduced'],
      ['totals', 1, [1, 0], 'fixed'],
      ['only now', 0, [0, 1], 'new'],
      ['test_total', 0, [0, 1], 'new'],
      ['brand new', 0, [1, 1], 'localOnly'],
      ['refunds', 1, [0, 0], 'notSeen'],
      ['removes items', 1, [0, 0], 'notSeen'],
    ],
  );
  assert.equal(byName['adds items'].query, 'kind:test-failure test:"adds items" OR "adds items"');
  const query = byName['adds items'].query!;
  const local = run2.filter((event) => matchesQuery(event, query));
  assert.ok(local.length > 0, "the query finds the local run's failure");
  assert.equal(byName['adds items'].message, '✕ adds items');
  assert.equal(byName['adds items'].location, 'cart.test.ts:12');
  assert.ok(byName['adds items'].baselineSample! < byName['adds items'].localSample!);
  assert.equal(byName['totals'].localSample !== undefined, true);
  assert.equal(byName['refunds'].localSample, undefined);
  assert.equal(byName['brand new'].baselineSample, undefined);
});

test('a local failure with a place wins over the CI one, and one local run makes new tests local only', () => {
  const rows = compareTestFailures(
    [
      ciFailure('test_x', { file: 'src/a/cart.test.ts', line: 3 }),
      ciFailure('lonely', { file: 'src/a/lonely.test.ts', line: 3 }),
    ],
    [[output('FAILED tests/test_cart.py::test_x'), output('FAILED tests/test_cart.py::test_y')]],
  );
  assert.deepEqual(
    rows.map((row) => [row.signature, row.status, row.location]),
    [
      ['test_x', 'reproduced', 'test_cart.py'],
      ['test_y', 'localOnly', 'test_cart.py'],
      ['lonely', 'notSeen', 'lonely.test.ts:3'],
    ],
  );
  assert.deepEqual(compareTestFailures([], []), []);
  assert.equal(compareTestFailures([ciFailure('a'), ciFailure('b')], [], 1).length, 1);
});

test('the summary of a CI comparison speaks of tests', () => {
  const rows = (...statuses: string[]) =>
    statuses.map((status) => ({ status, baseline: 1, runs: [], changed: false }) as never);
  assert.equal(summarizeComparison(rows('reproduced', 'reproduced'), 'ci'), '2 CI test failures reproduced');
  assert.equal(summarizeComparison(rows('fixed'), 'ci'), '1 CI test failure fixed locally');
  assert.equal(
    summarizeComparison(rows('notSeen'), 'ci'),
    'None of the tests that failed in CI failed in the newest run.',
  );
  assert.equal(summarizeComparison([], 'ci'), 'No failed tests in CI or the newest run.');
  assert.equal(summarizeComparison(rows('reproduced')), '1 production error reproduced');
  assert.equal(summarizeComparison([]), 'No errors in production or the newest run.');
});
