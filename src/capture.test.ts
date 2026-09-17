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

test('stopping one active session leaves its sibling running', { timeout: 10000 }, async () => {
  const store = new LogStore(100);
  const runner = new ProcessRunner({ get: (_key, fallback) => fallback }, new SessionRegistry(), new Ingestion(store, () => { }), new RuntimeState(() => { }));
  const firstId = runner.run(process.execPath, undefined, { id: 'first', label: 'First' }, undefined, undefined,
    ['-e', 'setInterval(() => {}, 1000)'])!;
  const secondId = runner.run(process.execPath, undefined, { id: 'second', label: 'Second' }, undefined, undefined,
    ['-e', 'setInterval(() => {}, 1000)'])!;
  try {
    runner.stopSessionById(firstId);
    const first = [...runner.sessions].find(session => session.record.id === firstId)!;
    const second = [...runner.sessions].find(session => session.record.id === secondId)!;
    assert.equal(first.stopping, true);
    assert.equal(second.stopping, false);
  } finally { await runner.dispose(); }
});

test('process runner records spawn errors, rejects duplicate saved servers, and shuts down when idle', { timeout: 10000 }, async () => {
  const registry = new SessionRegistry();
  const state = new RuntimeState(() => { });
  const runner = new ProcessRunner({ get: (_key, fallback) => fallback }, registry, new Ingestion(new LogStore(), () => { }), state);
  let errorExit!: (code: number) => void;
  const done = new Promise<number>(resolve => { errorExit = resolve; });
  const id = runner.run('/definitely/not/a/real/logline-command', undefined, { id: 'broken', label: 'Broken' }, undefined, undefined, [], errorExit);
  assert.ok(id);
  const record = registry.records.get(id!);
  await done;
  assert.equal(record?.status, 'failed');
  assert.match(record?.error ?? '', /ENOENT|not found/i);
  const running = runner.run(process.execPath, undefined, { id: 'single', label: 'Single' }, undefined, undefined, ['-e', 'setInterval(() => {}, 1000)']);
  assert.ok(running);
  assert.equal(runner.run(process.execPath, undefined, { id: 'single', label: 'Single' }, undefined, undefined, []), undefined);
  runner.stopSessionById('missing');
  await runner.dispose();
  await runner.dispose();
});
