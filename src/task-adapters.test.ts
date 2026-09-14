import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { withVscode } from './test/vscode-mock';

let folders: vscode.WorkspaceFolder[] = [];
let tasks: unknown[] = [];
let onPick = () => {};
let provider: vscode.TaskProvider;
const errors: string[] = [];
const disposable = () => ({ dispose() {} });
const mock = {
  Task: class {
    constructor(public definition: unknown, public scope: unknown, public name: string, public source: string, public execution: unknown) {}
  },
  CustomExecution: class { constructor(public callback: unknown) {} },
  EventEmitter: class { event = () => disposable(); fire() {} },
  workspace: { isTrusted: true, get workspaceFolders() { return folders; } },
  window: {
    showQuickPick: async (items: unknown[]) => { onPick(); return items[0]; },
    showInformationMessage() {}, showErrorMessage: (message: string) => errors.push(message)
  },
  tasks: {
    fetchTasks: async () => tasks,
    registerTaskProvider: (_type: string, value: vscode.TaskProvider) => { provider = value; return disposable(); },
    onDidStartTask: disposable, onDidStartTaskProcess: disposable, onDidEndTaskProcess: disposable, onDidEndTask: disposable
  }
};
const { convertTask, registerTasks, LogPseudoTerminal } = withVscode(mock, () => ({
  ...require('./vscode/tasks/conversion') as typeof import('./vscode/tasks/conversion'),
  ...require('./vscode/tasks/provider') as typeof import('./vscode/tasks/provider'),
  ...require('./vscode/tasks/terminal') as typeof import('./vscode/tasks/terminal')
}));

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'logline-tasks-'));
  folders = ['api', 'worker'].map((name, index) => {
    const fsPath = path.join(root, name);
    mkdirSync(path.join(fsPath, '.vscode'), { recursive: true });
    return { name, index, uri: { fsPath, toString: () => fsPath } } as vscode.WorkspaceFolder;
  });
  tasks = [{ name: 'Run', source: 'process', scope: folders[1], definition: { type: 'process' },
    execution: { process: process.execPath, args: [], options: {} } }];
  onPick = () => {}; errors.length = 0;
  return { root, file: path.join(folders[1].uri.fsPath, '.vscode/tasks.json') };
}

test('conversion leaves malformed task files untouched', async () => {
  const { root, file } = setup();
  try {
    for (const text of ['{"tasks":[', '{"tasks":{}}', 'null', '[]']) {
      writeFileSync(file, text);
      await convertTask();
      assert.equal(readFileSync(file, 'utf8'), text);
    }
    assert.equal(errors.length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conversion preserves edits made while its task picker is open', async () => {
  const { root, file } = setup();
  try {
    writeFileSync(file, '{"tasks":[]}');
    const changed = '{"tasks":[{"label":"New user task"}]}';
    onPick = () => { writeFileSync(file, changed); };
    await convertTask();
    assert.equal(readFileSync(file, 'utf8'), changed);
    assert.match(errors[0], /changed during conversion/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('task discovery covers all workspace folders and resolution retains its original scope', async () => {
  const { root } = setup();
  try {
    for (const folder of folders) writeFileSync(path.join(folder.uri.fsPath, '.vscode/tasks.json'), JSON.stringify({
      tasks: [null, { type: 'logline', label: folder.name, command: process.execPath }]
    }));
    registerTasks({} as never, {} as never, {} as never);
    const discovered = await provider.provideTasks({} as never);
    assert.deepEqual(discovered?.map(task => task.scope), folders);
    const resolved = await provider.resolveTask(discovered![1], {} as never);
    assert.equal(resolved?.scope, folders[1]);
    folders = [];
    assert.equal(await provider.resolveTask({ definition: { type: 'logline', command: 'node' } } as unknown as vscode.Task, {} as never), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an explicit empty argument array stays in argv mode', () => {
  let actualArgs: unknown;
  const terminal = new LogPseudoTerminal({ run: (...args: unknown[]) => { actualArgs = args[5]; } } as never,
    { dependencyState: () => 'none' } as never, { type: 'logline', command: 'tool', args: [] }, undefined);
  terminal.open();
  assert.deepEqual(actualArgs, []);
});
