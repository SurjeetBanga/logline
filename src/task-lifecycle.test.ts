import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ingestion } from './capture/ingestion';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { LogStore } from './core/log-store';
import { TaskLifecycle } from './vscode/tasks/lifecycle';
function setup() {
  const store = new LogStore(100), registry = new SessionRegistry();
  return { store, registry, tasks: new TaskLifecycle(registry, new Ingestion(store, () => { }), new RuntimeState(() => { }), () => false) };
}

test('stopping one task execution leaves another task running', () => {
  const provider = setup();
  const terminated: string[] = [];
  const execution = (name: string) => ({
    task: { name, source: 'npm', definition: { type: 'shell' } },
    terminate() { terminated.push(name); }
  }) as unknown as import('vscode').TaskExecution;
  const first = execution('First');
  const second = execution('Second');
  provider.tasks.captureTaskStart(first);
  provider.tasks.captureTaskStart(second);
  const firstId = provider.tasks.executions.get(first)!.id;

  provider.tasks.stopSessionById(firstId);

  assert.deepEqual(terminated, ['First']);
  assert.equal(provider.tasks.executions.get(first)!.status, 'stopping');
  assert.equal(provider.tasks.executions.get(second)!.status, 'running');
});

test('task lifecycle records names, dependencies, process ids, and exit reasons', () => {
  const provider = setup();
  const execution = {
    task: {
      name: 'Build API', source: 'npm', definition: {
        type: 'shell', dependsOn: ['Lint', 'Generate types']
      }
    }
  } as unknown as import('vscode').TaskExecution;
  provider.tasks.captureTaskStart(execution);
  provider.tasks.captureTaskProcessStart(execution, 42);
  provider.tasks.captureTaskProcessEnd(execution, 7);
  assert.ok(provider.tasks.executions);
  provider.tasks.captureTaskEnd(execution);
  const record = [...provider.registry.records.values()].find(value => value.taskName === 'Build API')!;
  assert.equal(record.status, 'failed');
  assert.equal(record.pid, 42);
  assert.equal(record.exitReason, 'exit code 7');
  assert.deepEqual(record.dependencies, ['Lint', 'Generate types']);
  // Neither named dependency has actually run in this test, so it can't be ready yet.
  assert.equal(record.dependencyState, 'pending');
  const events = provider.store.all({ serverId: record.serverId });
  assert.ok(events.some(event => event.message?.includes('Task started')));
  assert.ok(events.some(event => event.message?.includes('exit code 7')));
});

test('dependencyState turns ready only once every named dependency has finished', () => {
  const provider = setup();
  const build = {
    task: {
      name: 'Build API', source: 'npm', definition: {
        type: 'shell', dependsOn: ['Lint', 'Generate types']
      }
    }
  } as unknown as import('vscode').TaskExecution;
  const lint = { task: { name: 'Lint', source: 'npm', definition: { type: 'shell' } } } as unknown as import('vscode').TaskExecution;
  const generate = { task: { name: 'Generate types', source: 'npm', definition: { type: 'shell' } } } as unknown as import('vscode').TaskExecution;
  provider.tasks.captureTaskStart(build);
  const buildRecord = [...provider.registry.records.values()].find(value => value.taskName === 'Build API')!;
  assert.equal(buildRecord.dependencyState, 'pending');
  provider.tasks.captureTaskStart(lint);
  provider.tasks.captureTaskEnd(lint);
  assert.equal(buildRecord.dependencyState, 'pending');
  provider.tasks.captureTaskStart(generate);
  provider.tasks.captureTaskEnd(generate);
  assert.equal(buildRecord.dependencyState, 'ready');
});

test('task identities distinguish workspace roots and labels with identical slugs', () => {
  const { tasks, registry } = setup();
  const execution = (name: string, folder: string) => ({ task: { name, source: 'shell', definition: { type: 'shell' },
    scope: { uri: { toString: () => folder } } } }) as unknown as import('vscode').TaskExecution;
  for (const task of [execution('Build API', 'root-a'), execution('Build-API', 'root-a'), execution('Build API', 'root-b')]) tasks.captureTaskStart(task);
  assert.equal(new Set([...registry.records.values()].map(record => record.serverId)).size, 3);
  tasks.captureTaskStart(execution('Build API', 'root-a'));
  assert.equal(new Set([...registry.records.values()].map(record => record.serverId)).size, 3, 'reruns reuse identity');
});

test('dependencies follow the latest run in the same scope and recognize converted labels', () => {
  const { tasks, registry } = setup();
  const execution = (name: string, folder: string, dependsOn?: string[]) => ({ task: { name, source: 'shell', definition: { type: 'shell', dependsOn },
    scope: { uri: { toString: () => folder } } } }) as unknown as import('vscode').TaskExecution;
  const lint = execution('Lint', 'root-a');
  tasks.captureTaskStart(lint); tasks.captureTaskEnd(lint);
  const build = execution('Build', 'root-a', ['Lint']);
  tasks.captureTaskStart(build);
  const buildRecord = tasks.executions.get(build)!;
  assert.equal(buildRecord.dependencyState, 'ready');
  const rerun = execution('Lint', 'root-a');
  tasks.captureTaskStart(rerun);
  assert.equal(buildRecord.dependencyState, 'pending');
  const other = execution('Lint', 'root-b');
  tasks.captureTaskStart(other); tasks.captureTaskEnd(other);
  assert.equal(buildRecord.dependencyState, 'pending');
  const record = tasks.executions.get(rerun)!;
  record.taskLabel = 'Logline: Lint';
  assert.equal(registry.dependencyState(['Logline: Lint'], 'root-a'), 'pending');
  tasks.captureTaskEnd(rerun);
  assert.equal(buildRecord.dependencyState, 'ready');
  assert.equal(registry.dependencyState(['Logline: Lint'], 'root-a'), 'ready');
});
