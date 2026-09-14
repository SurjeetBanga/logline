import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from './test/vscode-mock';

let servers: unknown[] = [];
let picks: number[] = [];
let inputs: string[] = [];
const { manageServers } = withVscode({
  ConfigurationTarget: { Workspace: 1 },
  workspace: { getConfiguration: () => ({ get: () => servers, update: async (_key: string, value: unknown[]) => { servers = value; } }) },
  window: { showQuickPick: async (items: unknown[]) => items[picks.shift()!], showInputBox: async () => inputs.shift() }
}, () => require('./vscode/servers') as typeof import('./vscode/servers'));

test('editing and deleting duplicate server labels targets only the selected entry', async () => {
  servers = [{ id: 'api', label: 'Server', command: 'api' }, { id: 'worker', label: 'Server', command: 'worker' }, null];
  picks = [2]; inputs = ['Worker', 'new-worker'];
  await manageServers();
  assert.deepEqual(servers[0], { id: 'api', label: 'Server', command: 'api' });
  assert.deepEqual(servers[1], { id: 'worker', label: 'Worker', command: 'new-worker' });
  assert.equal(servers[2], null, 'unrelated malformed entries are preserved');
  servers[1] = { id: 'worker', label: 'Server', command: 'worker' };
  picks = [3, 1];
  await manageServers();
  assert.deepEqual(servers, [{ id: 'api', label: 'Server', command: 'api' }, null]);
});
