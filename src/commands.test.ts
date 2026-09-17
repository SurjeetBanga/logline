import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

const handlers = new Map<string, (...args: any[]) => any>();
const calls: { name: string; value?: unknown }[] = [];
let trusted = true;
let input: string | undefined = 'node server.js';
const mock = {
  ConfigurationTarget: { Workspace: 1 },
  workspace: {
    get isTrusted() { return trusted; },
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({ update: async (key: string, value: unknown) => calls.push({ name: `config:${key}`, value }) })
  },
  window: {
    showWarningMessage: (message: string) => calls.push({ name: 'warning', value: message }),
    showInformationMessage: (message: string) => calls.push({ name: 'info', value: message }),
    showInputBox: async () => input,
    showWorkspaceFolderPick: async () => undefined,
    showQuickPick: async () => undefined
  },
  commands: {
    registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return { dispose() { handlers.delete(name); } }; },
    executeCommand: async (name: string) => calls.push({ name: 'command', value: name })
  },
  tasks: { fetchTasks: async () => [] }
};
const { registerCommands, startAutoServers } = withVscode(mock, () => require('./vscode/commands') as typeof import('./vscode/commands'));

test('commands register the complete action surface and honor trust/focus/configuration', async () => {
  handlers.clear(); calls.length = 0; trusted = true; input = ' node server.js ';
  const ran: unknown[][] = [];
  const controller = {
    runner: { run: (...args: unknown[]) => { ran.push(args); } },
    stop: () => calls.push({ name: 'stop' }),
    transfer: { exportLogs: async () => calls.push({ name: 'export' }), importLogs: async () => calls.push({ name: 'import' }), exportForAI: async () => calls.push({ name: 'ai' }) },
    shareWithAgent: (...args: unknown[]) => calls.push({ name: 'share', value: args }),
    stopSharing: () => calls.push({ name: 'stopSharing' }),
    askCopilot: async () => { calls.push({ name: 'copilot' }); return true; },
    terminalCapture: { availableTerminals: () => [], toggleSource: () => undefined }
  } as any;
  const guideCalls: string[] = [];
  const registrations = registerCommands(controller, section => guideCalls.push(section));
  assert.equal(handlers.size, 17);
  await handlers.get('logline.runCommand')!();
  for (const name of ['logline.stopCommand', 'logline.export', 'logline.import', 'logline.exportForAI', 'logline.convertTask',
    'logline.captureTask', 'logline.showGuide', 'logline.showWhatsNew', 'logline.showLogs', 'logline.enableTerminalCapture',
    'logline.disableTerminalCapture', 'logline.shareWithAgent', 'logline.shareSpecificRuns', 'logline.stopSharing',
    'logline.askCopilot', 'logline.manageTerminalCapture']) await handlers.get(name)!();
  assert.equal(ran[0][0], 'node server.js');
  assert.deepEqual(guideCalls, ['guide', 'whatsNew']);
  assert.ok(calls.some(call => call.name === 'command' && call.value === 'logline.logs.focus'));
  assert.ok(calls.some(call => call.name === 'config:captureTerminals' && call.value === true));
  assert.ok(calls.some(call => call.name === 'config:captureTerminals' && call.value === false));
  for (const registration of registrations) registration.dispose();
  trusted = false; input = 'blocked';
  registerCommands(controller);
  await handlers.get('logline.runCommand')!();
  assert.ok(calls.some(call => call.name === 'warning' && String(call.value).includes('Trust')));
  assert.equal(ran.length, 1);
});

test('auto-start runs only trusted eligible saved servers with resolved cwd', () => {
  const ran: unknown[][] = [];
  const controller = {
    config: { get: (_key: string, _fallback: unknown) => [{ id: 'api', label: 'API', command: 'npm start', autoStart: true, cwd: '${workspaceFolder}' }, { id: 'off', label: 'Off', command: 'skip', autoStart: false }] },
    runner: { run: (...args: unknown[]) => ran.push(args) }
  } as any;
  trusted = true;
  startAutoServers(controller);
  assert.equal(ran.length, 1);
  assert.equal(ran[0][1], '/workspace');
  trusted = false;
  startAutoServers(controller);
  assert.ok(calls.some(call => call.name === 'warning' && String(call.value).includes('auto-start')));
});
