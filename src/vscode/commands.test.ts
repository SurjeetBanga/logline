import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

const handlers = new Map<string, (...args: any[]) => any>();
const calls: { name: string; value?: unknown }[] = [];
let trusted = true;
let input: string | undefined = 'node server.js';
const mock = {
  ConfigurationTarget: { Workspace: 1 },
  workspace: {
    get isTrusted() { return trusted; },
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({ update: async (key: string, value: unknown) => calls.push({ name: `config:${key}`, value }) }),
    findFiles: async () => [{ scheme: 'file', fsPath: '/workspace/deploy/compose.yaml' }],
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath
  },
  window: {
    showWarningMessage: (message: string) => calls.push({ name: 'warning', value: message }),
    showInformationMessage: (message: string) => calls.push({ name: 'info', value: message }),
    showInputBox: async () => input,
    showWorkspaceFolderPick: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => [{ scheme: 'file', fsPath: '/workspace/app.log' }]
  },
  commands: {
    registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return { dispose() { handlers.delete(name); } }; },
    executeCommand: async (name: string) => calls.push({ name: 'command', value: name })
  },
  tasks: { fetchTasks: async () => [] }
};
const { registerCommands, startAutoServers } = withVscode(mock, () => require('./commands') as typeof import('./commands'));

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
    terminalCapture: { availableTerminals: () => [], toggleSource: () => undefined },
    files: { follow: async (file: string) => { calls.push({ name: 'follow', value: file }); return 'run'; } }
  } as any;
  const guideCalls: string[] = [];
  const registrations = registerCommands(controller, section => guideCalls.push(section));
  assert.equal(handlers.size, 24);
  await handlers.get('logline.runCommand')!();
  for (const name of ['logline.stopCommand', 'logline.export', 'logline.import', 'logline.exportForAI', 'logline.convertTask',
    'logline.captureTask', 'logline.showGuide', 'logline.showWhatsNew', 'logline.showLogs', 'logline.enableTerminalCapture',
    'logline.disableTerminalCapture', 'logline.shareWithAgent', 'logline.shareSpecificRuns', 'logline.stopSharing',
    'logline.askCopilot', 'logline.manageTerminalCapture', 'logline.followFile', 'logline.followCompose']) await handlers.get(name)!();
  assert.ok(calls.some(call => call.name === 'follow' && call.value === '/workspace/app.log'));
  assert.equal(ran[0][0], 'node server.js');
  // Compose is followed without a shell, from the project's folder, with Docker timestamps.
  assert.deepEqual(ran[1].slice(0, 3), ['docker', '/workspace/deploy', { id: 'compose:/workspace/deploy/compose.yaml', label: 'Compose · deploy' }]);
  assert.deepEqual(ran[1][5], ['compose', '-f', '/workspace/deploy/compose.yaml', 'logs', '--follow', '--no-color', '--timestamps', '--tail', '200']);
  assert.deepEqual(guideCalls, ['guide', 'whatsNew']);
  assert.ok(calls.some(call => call.name === 'command' && call.value === 'logline.logs.focus'));
  assert.ok(calls.some(call => call.name === 'config:captureTerminals' && call.value === true));
  assert.ok(calls.some(call => call.name === 'config:captureTerminals' && call.value === false));
  for (const registration of registrations) registration.dispose();
  trusted = false; input = 'blocked';
  registerCommands(controller);
  await handlers.get('logline.runCommand')!();
  assert.ok(calls.some(call => call.name === 'warning' && String(call.value).includes('Trust')));
  assert.equal(ran.length, 2);
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
