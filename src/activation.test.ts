import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

const registeredCommands: string[] = [];
const mock = {
  ConfigurationTarget: { Workspace: 1 },
  ViewColumn: { Beside: 2 },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    terminals: [],
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showWarningMessage: () => undefined,
    showInformationMessage: () => undefined,
    showErrorMessage: () => undefined,
  },
  commands: {
    registerCommand: (name: string) => {
      registeredCommands.push(name);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
  tasks: {
    registerTaskProvider: () => ({ dispose() {} }),
    onDidStartTask: () => ({ dispose() {} }),
    onDidStartTaskProcess: () => ({ dispose() {} }),
    onDidEndTaskProcess: () => ({ dispose() {} }),
    onDidEndTask: () => ({ dispose() {} }),
  },
};
const { activate, deactivate } = withVscode(mock, () => require('./extension') as typeof import('./extension'));

test('activation registers the provider, command/task surfaces, autostart, and idempotent shutdown', async () => {
  registeredCommands.length = 0;
  // Activation starts the agent bridge, which writes under the home directory: HOME on Unix, USERPROFILE on Windows.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = mkdtempSync(join(tmpdir(), 'logline-home-'));
  process.env.HOME = process.env.USERPROFILE = home;
  try {
    const extensionPath = mkdtempSync(join(tmpdir(), 'logline-extension-'));
    mkdirSync(join(extensionPath, 'out'));
    writeFileSync(join(extensionPath, 'out', 'mcp.js'), '// stand-in for the bundled MCP server\n');
    const context = {
      extensionUri: { fsPath: extensionPath },
      subscriptions: [],
      globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
    } as any;
    const result = activate(context);
    assert.ok(result.provider);
    assert.equal(registeredCommands.length, 24);
    assert.ok(context.subscriptions.length >= 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(join(home, '.logline', 'mcp.js')), 'the MCP server script is installed at a stable path');
    assert.equal(readdirSync(join(home, '.logline', 'agents')).length, 1, 'the window publishes how agents reach it');
    await deactivate();
    await deactivate();
    for (const disposable of context.subscriptions) disposable.dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      readdirSync(join(home, '.logline', 'agents')).length,
      0,
      'closing the window removes its discovery file',
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('activation adds editor features where the host supports them, and follows the agents setting', async () => {
  const disposable = () => ({ dispose() {} });
  const settings: Record<string, unknown> = {};
  let configurationChanged: ((event: { affectsConfiguration: (key: string) => boolean }) => void) | undefined;
  const rich = {
    ...mock,
    EventEmitter: class {
      event = () => disposable();
      fire() {}
      dispose() {}
    },
    OverviewRulerLane: { Right: 4 },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {},
    CodeActionKind: { QuickFix: 'quickfix' },
    languages: {
      registerCodeLensProvider: disposable,
      registerHoverProvider: disposable,
      registerCodeActionsProvider: disposable,
      createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
    },
    extensions: { getExtension: () => undefined },
    debug: { addBreakpoints() {}, removeBreakpoints() {}, breakpoints: [], onDidChangeBreakpoints: disposable },
    workspace: {
      ...mock.workspace,
      textDocuments: [],
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
        update: async () => undefined,
      }),
      onDidChangeConfiguration: (listener: typeof configurationChanged) => {
        configurationChanged = listener;
        return disposable();
      },
      onDidChangeTextDocument: disposable,
      onDidSaveTextDocument: disposable,
      onDidChangeWorkspaceFolders: disposable,
      createFileSystemWatcher: () => ({
        onDidChange: disposable,
        onDidCreate: disposable,
        onDidDelete: disposable,
        dispose() {},
      }),
      findFiles: async () => [],
    },
    window: {
      ...mock.window,
      visibleTextEditors: [],
      createTextEditorDecorationType: disposable,
      onDidChangeVisibleTextEditors: disposable,
      onDidChangeActiveTextEditor: disposable,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    },
  };
  // Every module must load again with this VS Code, not come from the first test's cache.
  for (const key of Object.keys(require.cache))
    if (/[\\/]out-tests[\\/]/.test(key) && !/\.test\.js$|vscode-mock/.test(key)) delete require.cache[key];
  const extension = withVscode(rich, () => require('./extension') as typeof import('./extension'));

  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'logline-home-'));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const extensionPath = mkdtempSync(join(tmpdir(), 'logline-extension-'));
    mkdirSync(join(extensionPath, 'out'));
    writeFileSync(join(extensionPath, 'out', 'mcp.js'), '// stand-in for the bundled MCP server\n');
    const context = {
      extensionUri: { fsPath: extensionPath },
      subscriptions: [] as { dispose?: () => unknown }[],
      globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
    } as any;
    extension.activate(context);
    const controller = (context.subscriptions as any[]).find((item) => item?.constructor?.name === 'LogsController');
    assert.ok(controller.lens, 'CodeLens hosts get log lenses');
    assert.ok(controller.doctor, 'hosts with diagnostics get the log doctor');
    assert.ok(controller.gitChanges, 'hosts with extensions get changed-line tracking');
    assert.ok(controller.breakpoints, 'hosts with breakpoints get log breakpoints');
    assert.equal(typeof controller.debug.onEvent, 'function', 'debug output reaches log breakpoints');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    assert.equal(controller.agentBridge.running, true);

    // Other settings leave the bridge alone; turning external agents off stops it.
    settings.externalAgents = false;
    configurationChanged?.({ affectsConfiguration: (key) => key === 'logline.otlp.port' });
    await settle();
    assert.equal(controller.agentBridge.running, true);
    configurationChanged?.({ affectsConfiguration: (key) => key === 'logline.externalAgents' });
    await settle();
    assert.equal(controller.agentBridge.running, false);

    // Turned back on without the bundled MCP script: the failure is reported, not thrown.
    rmSync(join(extensionPath, 'out', 'mcp.js'));
    settings.externalAgents = true;
    configurationChanged?.({ affectsConfiguration: (key) => key === 'logline.externalAgents' });
    await settle();
    assert.match(warnings.join('\n'), /Logline could not start the agent bridge/);
    assert.equal(controller.agentBridge.running, false);

    await extension.deactivate();
    for (const item of context.subscriptions) item.dispose?.();
  } finally {
    console.warn = warn;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
