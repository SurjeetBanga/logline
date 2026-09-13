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
