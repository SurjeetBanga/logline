import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
