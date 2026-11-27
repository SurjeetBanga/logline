import assert from 'node:assert/strict';
import test from 'node:test';
import { LogStore } from '../core/log-store';
import type { SessionSummary } from '../core/types';
import { Ingestion } from './ingestion';
import { SessionRegistry } from './session-registry';
import { TestRuns } from './test-runs';

function harness() {
  const store = new LogStore(10000);
  const ingestion = new Ingestion(store, () => {});
  const registry = new SessionRegistry();
  const runs = new TestRuns(registry, store, ingestion);
  let next = 1;
  /** A terminal run of `command` that printed `lines`, finished unless told otherwise. */
  const run = (command: string, lines: string[], status: SessionSummary['status'] = 'exited') => {
    const record: SessionSummary = {
      id: `run${next++}`,
      serverId: 'terminal-1',
      server: 'zsh · terminal-1',
      status,
      startedAt: Date.now(),
      events: 0,
      sourceKind: 'terminal',
      owned: false,
      canStop: false,
      captureComplete: status !== 'running',
      command,
    };
    registry.records.set(record.id, record);
    for (const line of lines)
      ingestion.accept(line, 'terminal', { serverId: record.serverId, server: record.server, sessionId: record.id });
    return record;
  };
  const failures = (sessionId: string) =>
    store.all({ sessionId }).filter((event) => event.fields?.kind === 'test-failure');
  return { runs, run, failures, registry };
}

const vitestFailing = [
  ' FAIL  src/cart.test.ts > cart > adds tax to the total',
  'AssertionError: expected 10 to be 10.8',
  ' ❯ src/cart.test.ts:16:25',
  ' FAIL  src/cart.test.ts > cart > empty cart is free',
];

test('a finished test run records each test it failed, where the runner says it is', () => {
  const h = harness();
  const record = h.run('npx vitest run', vitestFailing);
  const [result] = h.runs.check();
  assert.deepEqual(result.failed, ['cart › adds tax to the total', 'cart › empty cart is free']);
  assert.deepEqual(result.fixed, []);
  const [first] = h.failures(record.id);
  assert.equal(first.level, 'error');
  assert.equal(first.serverId, 'terminal-1');
  assert.deepEqual(
    [first.message, first.fields?.scope, first.fields?.command, first.fields?.file, first.fields?.line],
    ['Test failed: cart › adds tax to the total', 'local', 'npx vitest run', 'src/cart.test.ts', 16],
  );
  assert.deepEqual(h.runs.check(), [], 'a run is read once');
});

test('a later run of the same command says which failed tests it passed', () => {
  const h = harness();
  h.run('npx vitest run', vitestFailing);
  h.runs.check();
  h.run('npx vitest run', [' FAIL  src/cart.test.ts > cart > empty cart is free']);
  const [result] = h.runs.check();
  assert.deepEqual(result.failed, ['cart › empty cart is free']);
  assert.deepEqual(result.fixed, ['cart › adds tax to the total']);
  // Another command's runs are their own.
  h.run('npm test', ['✖ cart total (2.1ms)']);
  assert.deepEqual(h.runs.check()[0].fixed, []);
});

test('runs still going, and commands that do not run tests, are not read', () => {
  const h = harness();
  h.run('npx vitest run', vitestFailing, 'running');
  h.run('node server.js', vitestFailing);
  h.run('', vitestFailing);
  assert.deepEqual(h.runs.check(), []);
});

test('after logs are cleared, runs already read stay read, and nothing earlier counts as fixed', () => {
  const h = harness();
  h.run('npx vitest run', vitestFailing);
  h.runs.check();
  h.runs.reset();
  assert.deepEqual(h.runs.check(), []);
  h.run('npx vitest run', []);
  assert.deepEqual(h.runs.check()[0].fixed, []);
});
