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
    get isTrusted() {
      return trusted;
    },
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({
      update: async (key: string, value: unknown) => calls.push({ name: `config:${key}`, value }),
    }),
    findFiles: async () => [{ scheme: 'file', fsPath: '/workspace/deploy/compose.yaml' }],
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
  },
  window: {
    showWarningMessage: (message: string) => calls.push({ name: 'warning', value: message }),
    showInformationMessage: (message: string) => calls.push({ name: 'info', value: message }),
    showInputBox: async () => input,
    showWorkspaceFolderPick: async () => undefined,
    showQuickPick: async (_items?: unknown): Promise<unknown> => undefined,
    showOpenDialog: async () => [{ scheme: 'file', fsPath: '/workspace/app.log' }],
  },
  commands: {
    registerCommand: (name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, handler);
      return {
        dispose() {
          handlers.delete(name);
        },
      };
    },
    executeCommand: async (name: string) => calls.push({ name: 'command', value: name }),
  },
  tasks: { fetchTasks: async () => [] },
};
const { registerCommands, startAutoServers } = withVscode(
  mock,
  () => require('./commands') as typeof import('./commands'),
);

test('commands register the complete action surface and honor trust/focus/configuration', async () => {
  handlers.clear();
  calls.length = 0;
  trusted = true;
  input = ' node server.js ';
  const ran: unknown[][] = [];
  const controller = {
    runner: {
      run: (...args: unknown[]) => {
        ran.push(args);
      },
    },
    stop: () => calls.push({ name: 'stop' }),
    transfer: {
      exportLogs: async () => calls.push({ name: 'export' }),
      importLogs: async () => calls.push({ name: 'import' }),
      exportForAI: async () => calls.push({ name: 'ai' }),
    },
    shareWithAgent: (...args: unknown[]) => calls.push({ name: 'share', value: args }),
    stopSharing: () => calls.push({ name: 'stopSharing' }),
    askCopilot: async () => {
      calls.push({ name: 'copilot' });
      return true;
    },
    terminalCapture: { availableTerminals: () => [], toggleSource: () => undefined },
    files: {
      follow: async (file: string) => {
        calls.push({ name: 'follow', value: file });
        return 'run';
      },
    },
  } as any;
  const guideCalls: string[] = [];
  const registrations = registerCommands(controller, (section) => guideCalls.push(section));
  assert.equal(handlers.size, 24);
  await handlers.get('logline.runCommand')!();
  for (const name of [
    'logline.stopCommand',
    'logline.export',
    'logline.import',
    'logline.exportForAI',
    'logline.convertTask',
    'logline.captureTask',
    'logline.showGuide',
    'logline.showWhatsNew',
    'logline.showLogs',
    'logline.enableTerminalCapture',
    'logline.disableTerminalCapture',
    'logline.shareWithAgent',
    'logline.shareSpecificRuns',
    'logline.stopSharing',
    'logline.askCopilot',
    'logline.manageTerminalCapture',
    'logline.followFile',
    'logline.followCompose',
  ])
    await handlers.get(name)!();
  assert.ok(calls.some((call) => call.name === 'follow' && call.value === '/workspace/app.log'));
  assert.equal(ran[0][0], 'node server.js');
  // Compose is followed without a shell, from the project's folder, with Docker timestamps.
  assert.deepEqual(ran[1].slice(0, 3), [
    'docker',
    '/workspace/deploy',
    { id: 'compose:/workspace/deploy/compose.yaml', label: 'Compose · deploy' },
  ]);
  assert.deepEqual(ran[1][5], [
    'compose',
    '-f',
    '/workspace/deploy/compose.yaml',
    'logs',
    '--follow',
    '--no-color',
    '--timestamps',
    '--tail',
    '200',
  ]);
  assert.deepEqual(guideCalls, ['guide', 'whatsNew']);
  assert.ok(calls.some((call) => call.name === 'command' && call.value === 'logline.logs.focus'));
  assert.ok(calls.some((call) => call.name === 'config:captureTerminals' && call.value === true));
  assert.ok(calls.some((call) => call.name === 'config:captureTerminals' && call.value === false));
  for (const registration of registrations) registration.dispose();
  trusted = false;
  input = 'blocked';
  registerCommands(controller);
  await handlers.get('logline.runCommand')!();
  assert.ok(calls.some((call) => call.name === 'warning' && String(call.value).includes('Trust')));
  assert.equal(ran.length, 2);
});

test('auto-start runs only trusted eligible saved servers with resolved cwd', () => {
  const ran: unknown[][] = [];
  const controller = {
    config: {
      get: (_key: string, _fallback: unknown) => [
        { id: 'api', label: 'API', command: 'npm start', autoStart: true, cwd: '${workspaceFolder}' },
        { id: 'off', label: 'Off', command: 'skip', autoStart: false },
      ],
    },
    runner: { run: (...args: unknown[]) => ran.push(args) },
  } as any;
  trusted = true;
  startAutoServers(controller);
  assert.equal(ran.length, 1);
  assert.equal(ran[0][1], '/workspace');
  trusted = false;
  startAutoServers(controller);
  assert.ok(calls.some((call) => call.name === 'warning' && String(call.value).includes('auto-start')));
});

test('commands stop at untrusted workspaces, cancelled pickers, and files Logline cannot follow', async () => {
  const ran: unknown[][] = [];
  const followed: string[] = [];
  const traces: string[] = [];
  const toggled: unknown[] = [];
  const toggledSources: string[] = [];
  const controller = {
    runner: { run: (...args: unknown[]) => ran.push(args) },
    files: { follow: async (file: string) => followed.push(file) },
    showTrace: async (id: string) => traces.push(id),
    toggleOtlp: (enabled: boolean) => toggled.push(enabled),
    connectAgent: async () => toggled.push('connect'),
    terminalCapture: {
      availableTerminals: () => [
        { id: 'zsh', label: 'zsh', ignored: false },
        { id: 'bash', label: 'bash', ignored: true },
      ],
      toggleSource: (id: string) => toggledSources.push(id),
    },
  } as any;
  const saved = { ...mock.window, folders: mock.workspace.workspaceFolders, findFiles: mock.workspace.findFiles };
  const run = (name: string, ...args: unknown[]) => handlers.get(name)!(...args);
  const warnings = () => calls.filter((call) => call.name === 'warning').map((call) => String(call.value));
  try {
    handlers.clear();
    calls.length = 0;
    registerCommands(controller);

    // Untrusted: nothing runs, is followed, or is opened.
    trusted = false;
    await run('logline.followFile');
    await run('logline.followCompose');
    assert.deepEqual(warnings(), [
      'Trust this workspace before following a log file.',
      'Trust this workspace before following a Docker Compose project.',
    ]);
    trusted = true;

    // Run command: a blank command, and a cancelled folder pick with several folders, run nothing.
    input = '   ';
    await run('logline.runCommand');
    input = 'npm start';
    mock.workspace.workspaceFolders = [{ uri: { fsPath: '/a' } }, { uri: { fsPath: '/b' } }];
    mock.window.showWorkspaceFolderPick = async () => undefined;
    await run('logline.runCommand');
    assert.equal(ran.length, 0);
    mock.window.showWorkspaceFolderPick = async () => ({ uri: { fsPath: '/b' } }) as any;
    await run('logline.runCommand');
    assert.deepEqual(ran.pop()!.slice(0, 2), ['npm start', '/b']);

    // Follow file: remote files are refused, and a cancelled dialog does nothing.
    mock.window.showOpenDialog = async () => [{ scheme: 'vscode-remote', fsPath: '/remote.log' }] as any;
    await run('logline.followFile');
    assert.equal(warnings().at(-1), 'Logline can only follow files on the local filesystem.');
    mock.window.showOpenDialog = async () => undefined as any;
    await run('logline.followFile');
    assert.deepEqual(followed, []);

    // Follow Compose: none found, several to choose from, and a cancelled choice.
    mock.workspace.findFiles = async () => [];
    await run('logline.followCompose');
    assert.equal(warnings().at(-1), 'Logline found no compose.yaml or docker-compose.yml in this workspace.');
    mock.workspace.findFiles = async () =>
      [
        { scheme: 'file', fsPath: '/workspace/compose.yaml' },
        { scheme: 'file', fsPath: '/workspace/api/docker-compose.yml' },
      ] as any;
    mock.window.showQuickPick = async (items: any) => items[1];
    await run('logline.followCompose');
    assert.deepEqual(ran.pop()!.slice(0, 2), ['docker', '/workspace/api']);
    mock.window.showQuickPick = async () => undefined;
    await run('logline.followCompose');
    assert.equal(ran.length, 0);

    // Show trace: an id from a link, one typed in, and one that is not a trace id.
    await run('logline.showTrace', '4bf92f3577b34da6a3ce929d0e0e4736');
    input = ' abc-123 ';
    await run('logline.showTrace');
    input = 'not a trace';
    await run('logline.showTrace');
    assert.deepEqual(traces, ['4bf92f3577b34da6a3ce929d0e0e4736', 'abc-123']);

    // The receiver and agent commands delegate to the controller.
    await run('logline.startOtlpReceiver');
    await run('logline.stopOtlpReceiver');
    await run('logline.connectAgent');
    assert.deepEqual(toggled, [true, false, 'connect']);

    // Manage terminal capture offers the opposite of each terminal's state and reports the change.
    let offered: { label: string }[] = [];
    mock.window.showQuickPick = async (items: any) => {
      offered = items;
      return items[1];
    };
    await run('logline.manageTerminalCapture');
    assert.deepEqual(
      offered.map((item) => item.label),
      ['Ignore · zsh', 'Enable · bash'],
    );
    assert.deepEqual(toggledSources, ['bash']);
    assert.ok(calls.some((call) => call.name === 'info' && call.value === 'Terminal capture enabled for bash.'));
  } finally {
    Object.assign(mock.window, saved);
    mock.workspace.workspaceFolders = saved.folders;
    mock.workspace.findFiles = saved.findFiles;
    trusted = true;
  }
});
