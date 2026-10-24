import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLogLine } from './log-event';
import { compareSignatures, differingFields, summarizeComparison } from './signature-compare';
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
