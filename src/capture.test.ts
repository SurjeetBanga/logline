import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Ingestion } from './capture/ingestion';
import { ProcessRunner } from './capture/process-runner';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { LogStore } from './core/log-store';
import { LogPersistence } from './storage/log-persistence';

test('capture sources share IDs while preserving persistence and session boundaries', () => {
  const store = new LogStore(100), persisted: string[] = [];
  const ingestion = new Ingestion(store, line => persisted.push(line));
  const live = { serverId: 'api', server: 'API', sessionId: 'live', persist: true, jsonOnly: true };
  assert.equal(ingestion.accept('build output', 'stdout', live), undefined);
  ingestion.accept('  \u001b[32m{"message":"live"}\u001b[0m  ', 'stdout', live);
  ingestion.accept('imported', 'import', { serverId: 'imported', server: 'Imported', sessionId: 'file' });
  const task = ingestion.create('{"message":"task"}', 'task');
  ingestion.commit(task, true);
  assert.deepEqual(store.all().map(event => event.id), [2, 3, 4]);
  assert.deepEqual(persisted, ['  \u001b[32m{"message":"live"}\u001b[0m  ', '{"message":"task"}']);
  assert.deepEqual(store.context(2).events.map(event => event.id), [2]);
  assert.equal(ingestion.sequence, 4);
});

test('process disposal captures the final partial line before flushing disk writes', { timeout: 10000 }, async () => {
  const config = { get<T>(key: string, fallback: T): T { return (key === 'persistLogs' ? true : fallback) as T; } };
  const persistence = new LogPersistence(config, () => undefined, () => { });
  const batches: string[] = [];
  persistence.writeBatch = async batch => { batches.push(batch); };
  const store = new LogStore(100);
  const runner = new ProcessRunner(config, new SessionRegistry(), new Ingestion(store, raw => persistence.persist(raw)), new RuntimeState(() => { }));
  runner.run(process.execPath, undefined, { id: 'test', label: 'Test' }, undefined, undefined,
    ['-e', 'process.stdout.write("final partial line"); setInterval(() => {}, 1000);']);
  const session = [...runner.sessions][0];
  try {
    await once(session.child.stdout, 'data');
    await runner.dispose();
    await persistence.dispose();
    assert.equal(runner.sessions.size, 0);
    assert.deepEqual(store.all().map(event => event.message), ['final partial line']);
    assert.deepEqual(batches, ['final partial line\n']);
  } finally { session.child.kill('SIGKILL'); await persistence.dispose(); }
});

test('stopping an old session ID leaves a later run alone', { timeout: 10000 }, async () => {
  const store = new LogStore(100);
  const runner = new ProcessRunner({ get: (_key, fallback) => fallback }, new SessionRegistry(), new Ingestion(store, () => { }), new RuntimeState(() => { }));
  let ended!: () => void;
  const done = new Promise<void>(resolve => { ended = resolve; });
  const oldId = runner.run(process.execPath, undefined, { id: 'api', label: 'API' }, undefined, undefined, ['-e', ''], ended)!;
  await done;
  const newId = runner.run(process.execPath, undefined, { id: 'api', label: 'API' }, undefined, undefined, ['-e', 'setInterval(() => {}, 1000)'])!;
  try {
    runner.stopSessionById(oldId);
    assert.notEqual(oldId, newId);
    assert.equal([...runner.sessions][0].stopping, false);
  } finally { await runner.dispose(); }
});
