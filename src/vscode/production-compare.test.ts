import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ingestion } from '../capture/ingestion';
import { SessionRegistry } from '../capture/session-registry';
import { LogStore } from '../core/log-store';
import type { SessionSummary } from '../core/types';
import type { CompareView } from '../protocol/messages';
import { ProductionCompare } from './production-compare';

function setup() {
  const store = new LogStore(1000);
  const registry = new SessionRegistry();
  const ingestion = new Ingestion(store, () => undefined);
  const finished: CompareView[] = [];
  const compare = new ProductionCompare(store, registry, (view) => finished.push(view));
  let started = 0;
  const run = (serverId: string, server: string, id: string, lines: object[], extra: Partial<SessionSummary> = {}) => {
    const record: SessionSummary = {
      id,
      serverId,
      server,
      status: 'exited',
      startedAt: ++started,
      events: 0,
      command: id,
      sourceKind: 'process',
      ...extra,
    };
    registry.records.set(id, record);
    for (const line of lines) ingestion.accept(JSON.stringify(line), 'stdout', { serverId, server, sessionId: id });
    return record;
  };
  return { store, registry, compare, finished, run };
}

const timeout = (ms: number, region?: string) => ({
  level: 'error',
  message: `payment gateway timed out after ${ms} ms`,
  ...(region ? { region } : {}),
});

test('a production run is compared with the newest local runs, with an event of each side to read', () => {
  const { compare, run } = setup();
  run(
    'conn:prod',
    'SQLite · prod',
    'p1',
    [timeout(5000, 'eu'), timeout(5000, 'eu'), { level: 'info', message: 'ok' }],
    {
      sourceKind: 'remote',
      command: 'level:error · last 1h',
    },
  );
  for (const id of ['r1', 'r2', 'r3']) run('npm-test', 'npm test', id, [{ level: 'info', message: 'start' }]);
  run('npm-test', 'npm test', 'r4', [timeout(800)]);
  const view = compare.build({ baselineServerId: 'conn:prod', baselineSessionId: 'p1', localServerId: 'npm-test' });
  assert.equal(view.baseline.label, 'SQLite · prod · level:error · last 1h');
  assert.equal(view.baseline.events, 3);
  assert.deepEqual(
    view.runs.map((r) => r.id),
    ['r2', 'r3', 'r4'],
    'the three newest runs, oldest first',
  );
  assert.equal(view.rows.length, 1);
  const [row] = view.rows;
  assert.deepEqual([row.baseline, row.runs, row.status], [2, [0, 0, 1], 'reproduced']);
  assert.equal(row.samples.baseline?.fields.region, 'eu');
  assert.deepEqual(row.samples.baseline?.differs, ['region']);
  assert.deepEqual(row.samples.local?.differs, ['region']);
  assert.equal(row.samples.local?.sessionId, 'r4', 'a sample names its run');
  assert.equal(view.summary, '1 production error reproduced');
});

test('a local run that finishes after the comparison is reported once', () => {
  const { compare, run, finished, registry } = setup();
  run('conn:prod', 'SQLite · prod', 'p1', [timeout(5000)], { sourceKind: 'remote' });
  run('npm-test', 'npm test', 'r1', [timeout(800)]);
  compare.check();
  assert.equal(finished.length, 0, 'nothing is compared until asked');
  compare.build({ baselineServerId: 'conn:prod', baselineSessionId: 'p1', localServerId: 'npm-test' });
  compare.check();
  assert.equal(finished.length, 0, 'runs that finished before are not reported');
  const fix = run('npm-test', 'npm test', 'r2', [{ level: 'info', message: 'ok' }], { status: 'running' });
  compare.check();
  assert.equal(finished.length, 0, 'a running run is not reported');
  fix.status = 'exited';
  run('other', 'Other', 'o1', [timeout(1)]);
  compare.check();
  compare.check();
  assert.equal(finished.length, 1);
  assert.equal(finished[0].summary, '1 production error fixed locally');
  compare.unpin();
  run('npm-test', 'npm test', 'r3', []);
  compare.check();
  assert.equal(finished.length, 1, 'clearing logs stops reporting');
  assert.ok(registry.records.has('r3'));
});

test('imported files compare by their events when the registry has no runs for them', () => {
  const { compare, store } = setup();
  const ingestion = new Ingestion(store, () => undefined);
  ingestion.accept(JSON.stringify(timeout(5000)), 'import', {
    serverId: 'prod.log',
    server: 'Imported · prod.log',
    sessionId: 'file',
  });
  ingestion.accept(JSON.stringify(timeout(900)), 'import', {
    serverId: 'local.log',
    server: 'Imported · local.log',
    sessionId: 'file',
  });
  const view = compare.build({ baselineServerId: 'prod.log', localServerId: 'local.log' });
  assert.deepEqual(view.runs, [{ id: 'file', label: 'Imported · local.log', startedAt: 0 }]);
  assert.equal(view.rows[0].status, 'reproduced');
  assert.equal(view.baseline.label, 'Imported · prod.log');
});
