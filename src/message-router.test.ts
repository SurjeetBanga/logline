import assert from 'node:assert/strict';
import test from 'node:test';
import { LogStore } from './core/log-store';
import { withVscode } from './test/vscode-mock';

const calls: { name: string; value?: unknown }[] = [];
let trusted = true;
let commandConfig: unknown[] = [{ id: 'api', label: 'API', command: 'npm start' }];
const mockVscode = {
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => undefined })
  },
  window: {
    showWarningMessage: (message: string) => { calls.push({ name: 'warning', value: message }); },
    showInformationMessage: (message: string) => { calls.push({ name: 'info', value: message }); },
    showErrorMessage: (message: string) => { calls.push({ name: 'error', value: message }); },
    showQuickPick: async () => undefined
  },
  env: { clipboard: { writeText: async (text: string) => { calls.push({ name: 'clipboard', value: text }); } } },
  commands: { executeCommand: async (name: string) => { calls.push({ name: 'command', value: name }); } }
};

const { handleMessage } = withVscode(mockVscode, () => require('./vscode/message-router') as typeof import('./vscode/message-router'));

function services() {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', sessionId: 'run', level: 'error', message: 'failed', raw: '{"message":"failed"}', isJson: true });
  const saved = { savedSearches: () => [] } as any;
  const config = { get: (key: string, fallback: unknown) => key === 'servers' ? commandConfig : fallback } as any;
  const runner = { run: (...args: unknown[]) => calls.push({ name: 'run', value: args }) } as any;
  const transfer = {
    exportLogs: async (value: unknown) => { calls.push({ name: 'export', value }); },
    exportForAI: async (value: unknown) => { calls.push({ name: 'exportForAI', value }); },
    copyFiltered: async (value: unknown) => { calls.push({ name: 'copyFiltered', value }); },
    exportContext: async (value: unknown) => { calls.push({ name: 'exportContext', value }); },
    importLogs: async () => { calls.push({ name: 'import' }); }
  } as any;
  const searches = {
    saveSearch: (...args: unknown[]) => { calls.push({ name: 'saveSearch', value: args }); return { id: 'saved' }; },
    deleteSavedSearch: (id: string) => calls.push({ name: 'deleteSavedSearch', value: id }),
    savedSearches: () => saved.savedSearches()
  } as any;
  return {
    store, config, runner, transfer, searches,
    snapshot: (request: unknown) => ({ type: 'snapshot', request }),
    clear: () => calls.push({ name: 'clear' }),
    stop: (...args: unknown[]) => calls.push({ name: 'stop', value: args }),
    showGuide: (section: string) => calls.push({ name: 'guide', value: section }),
    agentAccess: {} as any,
    shareWithAgent: async (...args: unknown[]) => { calls.push({ name: 'share', value: args }); },
    stopSharing: () => calls.push({ name: 'stopSharing' }),
    askCopilot: async (anchor?: number) => { calls.push({ name: 'copilot', value: anchor }); return true; },
    toggleTerminalCapture: async (enabled: boolean) => { calls.push({ name: 'terminalCapture', value: enabled }); }
  };
}

test('message router dispatches every public action and preserves normalized inputs', async () => {
  calls.length = 0;
  const service = services();
  const sent: unknown[] = [];
  const requests: unknown[] = [
    { type: 'snapshot', page: 1 }, { type: 'context', id: 1 }, { type: 'openSource', id: 99, block: 0, line: 0 },
    { type: 'saveSearch', name: 'Errors', query: 'level:error', levels: ['error'], serverId: 'api' },
    { type: 'deleteSavedSearch', id: 'saved' }, { type: 'autocomplete', input: 'sta', serverId: 'api' },
    { type: 'analysis', query: 'failed' }, { type: 'export', query: 'failed' }, { type: 'exportForAI' },
    { type: 'copyFiltered', serverId: 'api' }, { type: 'exportContext', ids: [1, 99] },
    { type: 'shareWithAgent', sourceIds: ['api'], anchor: 1, sessionIds: ['run'], chooseRuns: true },
    { type: 'stopSharing' }, { type: 'askCopilot', anchor: 1 }, { type: 'shareEvent', id: 1 },
    { type: 'toggleTerminalCapture', enabled: true }, { type: 'showGuide', section: 'whatsNew' },
    { type: 'import' }, { type: 'details', id: 1, target: 'context' }, { type: 'copy', id: 1 },
    { type: 'clear' }, { type: 'stop', serverId: 'api', sessionId: 'run' }, { type: 'config' },
    { type: 'manageServers' }
  ];
  for (const request of requests) await handleMessage(service as any, message => sent.push(message), request);
  assert.ok(sent.some(message => (message as any).type === 'snapshot'));
  assert.ok(sent.some(message => (message as any).type === 'context' && (message as any).id === 1));
  assert.ok(sent.some(message => (message as any).type === 'details' && (message as any).target === 'context'));
  for (const name of ['saveSearch', 'deleteSavedSearch', 'export', 'exportForAI', 'copyFiltered', 'exportContext', 'share',
    'stopSharing', 'copilot', 'terminalCapture', 'guide', 'import', 'clipboard', 'clear', 'stop', 'command'])
    assert.ok(calls.some(call => call.name === name), `missing routed action ${name}`);
  assert.equal((mockVscode.workspace as any).isTrusted, true);
});

test('message router enforces workspace trust for run and ignores malformed requests', async () => {
  calls.length = 0;
  const service = services();
  (mockVscode.workspace as any).isTrusted = false;
  await handleMessage(service as any, () => undefined, { type: 'run', serverId: 'api' });
  assert.ok(calls.some(call => call.name === 'warning'));
  assert.equal(calls.some(call => call.name === 'run'), false);
  await handleMessage(service as any, () => undefined, { type: 'run', serverId: 'api', command: 'rm -rf /' });
  await handleMessage(service as any, () => undefined, { type: 'unknown' });
  assert.equal(calls.filter(call => call.name === 'warning').length, 2);
  (mockVscode.workspace as any).isTrusted = trusted;
});
