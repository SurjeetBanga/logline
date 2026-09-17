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
    onDidChangeConfiguration: () => ({ dispose() {} })
  },
  window: {
    terminals: [],
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showWarningMessage: () => undefined,
    showInformationMessage: () => undefined,
    showErrorMessage: () => undefined
  },
  commands: {
    registerCommand: (name: string) => { registeredCommands.push(name); return { dispose() {} }; },
    executeCommand: async () => undefined
  },
  tasks: {
    registerTaskProvider: () => ({ dispose() {} }),
    onDidStartTask: () => ({ dispose() {} }),
    onDidStartTaskProcess: () => ({ dispose() {} }),
    onDidEndTaskProcess: () => ({ dispose() {} }),
    onDidEndTask: () => ({ dispose() {} })
  }
};
const { activate, deactivate } = withVscode(mock, () => require('./extension') as typeof import('./extension'));

test('activation registers the provider, command/task surfaces, autostart, and idempotent shutdown', async () => {
  registeredCommands.length = 0;
  const context = { extensionUri: { fsPath: process.cwd() }, subscriptions: [], globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } } as any;
  const result = activate(context);
  assert.ok(result.provider);
  assert.equal(registeredCommands.length, 17);
  assert.ok(context.subscriptions.length >= 20);
  await deactivate();
  await deactivate();
});
