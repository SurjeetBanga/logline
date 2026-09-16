import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

let importUris: { scheme: string; path: string; fsPath: string; }[] = [];
let pickedRun = '';
const notices: string[] = [];
const mock = {
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() { } })
  },
  window: {
    showOpenDialog: async () => importUris,
    showWarningMessage: async (_message: string, _options: unknown, ...actions: string[]) => actions[0],
    showInformationMessage: async (message: string) => { notices.push(message); },
    showQuickPick: async (items: { runId: string }[]) => items.filter(item => item.runId === pickedRun)
  }
};
const { LogsController } = withVscode(mock, () => require('./vscode/logs-controller') as typeof import('./vscode/logs-controller'));

test('imported files can be shared as all runs, one run, or one exact event', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'logline-import-sharing-'));
  const controller = new LogsController({ globalState: {
    get: (_key: string, fallback: unknown) => fallback,
    update: async () => { }
  } } as unknown as import('vscode').ExtensionContext);
  t.after(async () => { await controller.dispose(); await rm(directory, { recursive: true, force: true }); });

  const first = path.join(directory, 'first.jsonl');
  const second = path.join(directory, 'second.jsonl');
  await writeFile(first, '{"message":"first","token":"secret-one"}\n');
  await writeFile(second, '{"message":"second","token":"secret-two"}\n');
  importUris = [first, second].map(file => ({ scheme: 'file', path: file, fsPath: file }));
  await controller.transfer.importLogs();

  const snapshot = controller.snapshot({ type: 'snapshot' });
  assert.equal(snapshot.sessions.length, 2);
  assert.ok(snapshot.sessions.every(session => session.sourceKind === 'import'));
  assert.ok(snapshot.sessions.every(session => session.command?.startsWith('Imported · ')));
  const importedSources = snapshot.sessions.map(session => session.serverId);
  assert.equal(new Set(importedSources).size, 2);

  await controller.handleMessage(() => { }, { type: 'shareWithAgent' });
  const all = controller.agentAccess.status();
  assert.equal(all.active, true);
  assert.equal(all.scope, 'all');
  assert.equal(all.sources.reduce((count, source) => count + source.runs.length, 0), 2);
  assert.deepEqual(controller.agentAccess.search({ shareId: all.shareId! }).events.map(event => event.message), ['second', 'first']);
  assert.doesNotMatch(JSON.stringify(controller.agentAccess.search({ shareId: all.shareId! })), /secret-/);

  const third = path.join(directory, 'third.jsonl');
  await writeFile(third, '{"message":"third","token":"secret-three"}\n');
  importUris = [{ scheme: 'file', path: third, fsPath: third }];
  await controller.transfer.importLogs();
  assert.deepEqual(controller.agentAccess.search({ shareId: all.shareId! }).events.map(event => event.message), ['third', 'second', 'first']);

  controller.stopSharing();
  pickedRun = snapshot.sessions[0].id;
  await controller.handleMessage(() => { }, { type: 'shareWithAgent', chooseRuns: true });
  const selected = controller.agentAccess.status();
  assert.equal(selected.scope, 'selected');
  assert.deepEqual(selected.sources.flatMap(source => source.runs.map(run => run.id)), [pickedRun]);
  assert.deepEqual(controller.agentAccess.search({ shareId: selected.shareId! }).events.map(event => event.message), ['first']);

  const fourth = path.join(directory, 'fourth.jsonl');
  await writeFile(fourth, '{"message":"fourth"}\n');
  importUris = [{ scheme: 'file', path: fourth, fsPath: fourth }];
  await controller.transfer.importLogs();
  assert.deepEqual(controller.agentAccess.search({ shareId: selected.shareId! }).events.map(event => event.message), ['first']);

  controller.stopSharing();
  await controller.handleMessage(() => { }, { type: 'shareEvent', id: 2 });
  const exact = controller.agentAccess.status();
  assert.deepEqual(exact.sources.flatMap(source => source.runs.map(run => run.id)), [snapshot.sessions[1].id]);
  assert.deepEqual(controller.agentAccess.search({ shareId: exact.shareId! }).events.map(event => event.message), ['second']);
  controller.stopSharing();
  assert.equal(controller.agentAccess.status().active, false);
});
