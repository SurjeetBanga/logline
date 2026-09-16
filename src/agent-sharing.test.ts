import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

type Choice = { sourceId: string; runId: string };
const notices: string[] = [];
let choices: Choice[] = [];
let pick: (items: Choice[]) => Choice[] | undefined = items => items;
let confirm: () => string | undefined | Promise<string | undefined> = () => 'Share logs';
const warnings: { message: string; options: { modal: boolean; detail: string }; actions: string[] }[] = [];
const preferences = new Map<string, unknown>();
const mock = {
  workspace: {
    onDidChangeConfiguration: () => ({ dispose() { } }),
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
  },
  window: {
    showWarningMessage: async (message: string, options: { modal: boolean; detail: string }, ...actions: string[]) => {
      warnings.push({ message, options, actions }); return confirm();
    },
    showInformationMessage: async (message: string) => { notices.push(message); },
    showQuickPick: async (items: Choice[]) => { choices = items; return pick(items); }
  }
};
const { LogsController } = withVscode(mock, () => require('./vscode/logs-controller') as typeof import('./vscode/logs-controller'));

function setup(t: { after(fn: () => Promise<void>): void }) {
  notices.length = 0; choices = []; pick = items => items;
  warnings.length = 0; preferences.clear(); confirm = () => 'Share logs';
  const controller = new LogsController({ globalState: {
    get: (key: string, fallback: unknown) => preferences.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { preferences.set(key, value); }
  } } as unknown as import('vscode').ExtensionContext);
  t.after(() => controller.dispose());
  return controller;
}

test('sharing an idle selected server explains how to capture logs without throwing', async t => {
  const controller = setup(t);
  await controller.handleMessage(() => {}, { type: 'shareWithAgent', sourceIds: ['idle-server'] });
  assert.equal(controller.agentAccess.status().active, false);
  assert.equal(choices.length, 0);
  assert.match(notices[0], /no command runs.*capture/i);
});

test('sharing a selected server offers its runs and grants only the chosen run', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  controller.store.add({ level: 'info', id: 2, serverId: 'api', sessionId: 'b', message: 'second' });
  controller.store.add({ level: 'info', id: 3, serverId: 'web', sessionId: 'w', message: 'other' });
  pick = items => items.filter(item => item.runId === 'a');
  await controller.handleMessage(() => {}, { type: 'shareWithAgent', sourceIds: ['api'] });
  assert.equal(choices.length, 2);
  assert.ok(choices.every(item => item.sourceId === 'api'));
  const status = controller.agentAccess.status();
  assert.deepEqual(status.sources.flatMap(source => source.runs.map(run => run.id)), ['a']);
});

test('sharing a stale selected run leaves the existing grant intact', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  const previous = controller.agentAccess.share(['api'], undefined, ['a']);
  await controller.handleMessage(() => {}, { type: 'shareWithAgent', sourceIds: ['api'], sessionIds: ['removed'] });
  assert.equal(controller.agentAccess.status().shareId, previous.shareId);
  assert.match(notices[0], /no longer available/i);
});

test('sharing a selected run with all servers selected preserves the run scope', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  controller.store.add({ level: 'info', id: 2, serverId: 'web', sessionId: 'w', message: 'other' });
  await controller.handleMessage(() => {}, { type: 'shareWithAgent', sessionIds: ['a'] });
  assert.deepEqual(controller.agentAccess.status().sources.map(source => source.id), ['api']);
  assert.equal(choices.length, 0);
});

test('cancelling the run picker preserves the existing grant', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  const previous = controller.agentAccess.share(['api']);
  pick = () => undefined;
  await controller.shareWithAgent(['api']);
  assert.equal(controller.agentAccess.status().shareId, previous.shareId);
});

test('clearing logs while the run picker is open cancels sharing', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  pick = items => { controller.clear(); return items; };
  await controller.shareWithAgent(undefined, undefined, undefined, true);
  assert.equal(controller.agentAccess.status().active, false);
});

test('sharing an event grants its exact run without opening a picker', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  controller.store.add({ level: 'info', id: 2, serverId: 'api', sessionId: 'b', message: 'second' });
  await controller.handleMessage(() => {}, { type: 'shareEvent', id: 1 });
  const status = controller.agentAccess.status();
  assert.deepEqual(status.sources.flatMap(source => source.runs.map(run => run.id)), ['a']);
  assert.equal(controller.agentAccess.getAnchor(), 1);
  assert.equal(choices.length, 0);
});


test('share all confirms once and starts without a run picker, even before capture', async t => {
  const controller = setup(t);
  await controller.handleMessage(() => {}, { type: 'shareWithAgent' });
  assert.equal(controller.agentAccess.status().active, true);
  assert.equal(controller.agentAccess.status().scope, 'all');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].options.modal, true);
  assert.match(warnings[0].options.detail, /new command runs/);
  assert.match(warnings[0].options.detail, /sensitive information/);
  assert.deepEqual(warnings[0].actions, ['Share logs', 'Choose specific runs…']);
  assert.equal(choices.length, 0);
  controller.stopSharing();
  assert.equal(controller.agentAccess.status().active, false);
  await controller.shareWithAgent();
  assert.equal(controller.agentAccess.status().scope, 'all');
  assert.equal(warnings.length, 1);
});

test('cancelling the warning preserves access and does not remember acceptance', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a' });
  const previous = controller.agentAccess.share(['api']);
  confirm = () => undefined;
  await controller.shareWithAgent();
  assert.equal(controller.agentAccess.status().shareId, previous.shareId);
  assert.equal(preferences.size, 0);
  await controller.shareWithAgent();
  assert.equal(warnings.length, 2);
});

test('choosing specific runs from the warning grants only the selection and leaves confirmation pending', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a' });
  controller.store.add({ level: 'info', id: 2, serverId: 'web', sessionId: 'w' });
  confirm = () => 'Choose specific runs…';
  pick = items => items.filter(item => item.runId === 'a');
  await controller.shareWithAgent();
  const status = controller.agentAccess.status();
  assert.equal(status.scope, 'selected');
  assert.deepEqual(status.sources.map(source => source.id), ['api']);
  assert.equal(preferences.size, 0);
});

test('the secondary action can narrow all sharing without another warning', async t => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a' });
  controller.store.add({ level: 'info', id: 2, serverId: 'web', sessionId: 'w' });
  await controller.shareWithAgent();
  pick = items => items.filter(item => item.runId === 'a');
  await controller.handleMessage(() => {}, { type: 'shareWithAgent', chooseRuns: true });
  assert.equal(warnings.length, 1);
  assert.equal(controller.agentAccess.status().scope, 'selected');
  assert.deepEqual(controller.agentAccess.status().sources.map(source => source.id), ['api']);
});

test('duplicate sharing clicks use one warning and revocation prevents a pending grant', async t => {
  const controller = setup(t);
  let resolve!: (value: string) => void;
  confirm = () => new Promise<string>(done => { resolve = done; });
  const first = controller.shareWithAgent();
  const second = controller.shareWithAgent();
  assert.equal(warnings.length, 1);
  controller.stopSharing();
  resolve('Share logs');
  await Promise.all([first, second]);
  assert.equal(controller.agentAccess.status().active, false);
  assert.equal(preferences.size, 0);
});
