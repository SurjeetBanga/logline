import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { withVscode } from '../../test/vscode-mock';

let folders: vscode.WorkspaceFolder[] = [];
let tasks: unknown[] = [];
let onPick = () => {};
let provider: vscode.TaskProvider;
const errors: string[] = [];
const notices: string[] = [];
let trusted = true;
let fetchError: Error | undefined;
const disposable = () => ({ dispose() {} });
const mock = {
  Task: class {
    constructor(
      public definition: unknown,
      public scope: unknown,
      public name: string,
      public source: string,
      public execution: unknown,
    ) {}
  },
  CustomExecution: class {
    constructor(public callback: unknown) {}
  },
  EventEmitter: class {
    event = () => disposable();
    fire() {}
  },
  workspace: {
    get isTrusted() {
      return trusted;
    },
    get workspaceFolders() {
      return folders;
    },
  },
  window: {
    showQuickPick: async (items: unknown[]) => {
      onPick();
      return items[0];
    },
    showInformationMessage: (message: string) => notices.push(message),
    showWarningMessage: (message: string) => notices.push(message),
    showErrorMessage: (message: string) => errors.push(message),
  },
  tasks: {
    fetchTasks: async () => {
      if (fetchError) throw fetchError;
      return tasks;
    },
    registerTaskProvider: (_type: string, value: vscode.TaskProvider) => {
      provider = value;
      return disposable();
    },
    onDidStartTask: disposable,
    onDidStartTaskProcess: disposable,
    onDidEndTaskProcess: disposable,
    onDidEndTask: disposable,
  },
};
const { convertTask, registerTasks, LogPseudoTerminal } = withVscode(mock, () => ({
  ...(require('./conversion') as typeof import('./conversion')),
  ...(require('./provider') as typeof import('./provider')),
  ...(require('./terminal') as typeof import('./terminal')),
}));

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'logline-tasks-'));
  folders = ['api', 'worker'].map((name, index) => {
    const fsPath = path.join(root, name);
    mkdirSync(path.join(fsPath, '.vscode'), { recursive: true });
    return { name, index, uri: { fsPath, toString: () => fsPath } } as vscode.WorkspaceFolder;
  });
  tasks = [
    {
      name: 'Run',
      source: 'process',
      scope: folders[1],
      definition: { type: 'process' },
      execution: { process: process.execPath, args: [], options: {} },
    },
  ];
  onPick = () => {};
  errors.length = 0;
  notices.length = 0;
  trusted = true;
  fetchError = undefined;
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conversion preserves edits made while its task picker is open', async () => {
  const { root, file } = setup();
  try {
    writeFileSync(file, '{"tasks":[]}');
    const changed = '{"tasks":[{"label":"New user task"}]}';
    onPick = () => {
      writeFileSync(file, changed);
    };
    await convertTask();
    assert.equal(readFileSync(file, 'utf8'), changed);
    assert.match(errors[0], /changed during conversion/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conversion writes a captured process task into tasks.json', async () => {
  const { root, file } = setup();
  try {
    writeFileSync(file, '{"version":"2.0.0","tasks":[]}');
    await convertTask();
    const text = readFileSync(file, 'utf8');
    assert.match(text, /"type": "logline"/);
    assert.match(text, /node|process/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task discovery covers all workspace folders and resolution retains its original scope', async () => {
  const { root } = setup();
  try {
    for (const folder of folders)
      writeFileSync(
        path.join(folder.uri.fsPath, '.vscode/tasks.json'),
        JSON.stringify({
          tasks: [null, { type: 'logline', label: folder.name, command: process.execPath }],
        }),
      );
    registerTasks({} as never, {} as never, {} as never);
    const discovered = await provider.provideTasks({} as never);
    assert.deepEqual(
      discovered?.map((task) => task.scope),
      folders,
    );
    const resolved = await provider.resolveTask(discovered![1], {} as never);
    assert.equal(resolved?.scope, folders[1]);
    folders = [];
    assert.equal(
      await provider.resolveTask(
        { definition: { type: 'logline', command: 'node' } } as unknown as vscode.Task,
        {} as never,
      ),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit empty argument array stays in argv mode', () => {
  let actualArgs: unknown;
  const terminal = new LogPseudoTerminal(
    {
      run: (...args: unknown[]) => {
        actualArgs = args[5];
      },
    } as never,
    { dependencyState: () => 'none' } as never,
    { type: 'logline', command: 'tool', args: [] },
    undefined,
  );
  terminal.open();
  assert.deepEqual(actualArgs, []);
});

test('task provider rejects unsupported definitions and pseudo terminals stop their own session', async () => {
  const disposables = registerTasks({} as never, {} as never, {} as never);
  assert.equal(disposables.length, 5);
  const missingFolder = {
    uri: { fsPath: path.join(tmpdir(), 'missing-logline-tasks'), toString: () => 'missing' },
  } as unknown as vscode.WorkspaceFolder;
  folders = [missingFolder];
  assert.deepEqual(await provider.provideTasks({} as never), []);
  assert.equal(
    await provider.resolveTask(
      { definition: { type: 'shell', command: 'echo' } } as unknown as vscode.Task,
      {} as never,
    ),
    undefined,
  );
  let stopped: string | undefined;
  const terminal = new LogPseudoTerminal(
    {
      run: () => 'session-1',
      stopSessionById: (id: string) => {
        stopped = id;
      },
    } as never,
    { dependencyState: () => 'none' } as never,
    { type: 'logline', command: 'tool' },
    undefined,
  );
  terminal.open();
  terminal.handleInput();
  terminal.close();
  assert.equal(stopped, 'session-1');
});

/** A process task in a workspace folder, as VS Code reports it. */
const processTask = (name: string, scope: unknown, dependsOn?: string | string[]) => ({
  name,
  source: 'Workspace',
  scope,
  definition: { type: 'process', label: name, ...(dependsOn ? { dependsOn } : {}) },
  execution: { process: process.execPath, args: [name.toLowerCase()], options: {} },
});
const written = (file: string) =>
  (JSON.parse(readFileSync(file, 'utf8')).tasks as { label: string; dependsOn?: unknown }[]).filter((task) =>
    task.label.startsWith('Logline: '),
  );

test('conversion explains why it cannot start or has nothing to do', async () => {
  const { root, file } = setup();
  try {
    trusted = false;
    await convertTask();
    trusted = true;
    const saved = folders;
    folders = [];
    await convertTask();
    folders = saved;
    fetchError = new Error('the task system is busy');
    await convertTask();
    fetchError = undefined;
    tasks = [{ name: 'Custom', source: 'Workspace', scope: folders[1], definition: { type: 'custom' } }];
    await convertTask();
    assert.deepEqual(notices, [
      'Trust this workspace before converting a task.',
      'Open a workspace before converting a task.',
      'No shell, process, node-terminal, or launch pre-task was found.',
    ]);
    assert.deepEqual(errors, ['Could not read VS Code tasks: the task system is busy']);

    // A shell task with shellArgs is offered, so the user learns why it is refused.
    tasks = [
      {
        name: 'Quoted',
        source: 'Workspace',
        scope: folders[1],
        definition: { type: 'shell' },
        execution: { commandLine: 'echo hi', options: { shellArgs: ['-c'] } },
      },
    ];
    await convertTask();
    assert.match(errors[1], /uses shellArgs/);

    // Converting the same task twice adds it once.
    tasks = [processTask('Run', folders[1])];
    await convertTask();
    await convertTask();
    assert.equal(written(file).length, 1);
    assert.equal(notices.at(-1), 'Logline task already exists for Run.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conversion brings dependencies in the same folder along, and keeps others by name', async () => {
  const { root, file } = setup();
  try {
    const [api, worker] = folders;
    tasks = [
      processTask('Start', worker, ['Build', 'Migrate', 'Lint']),
      processTask('Build', worker, 'Start'), // a cycle must not recurse forever
      processTask('Migrate', api), // another folder: kept by name
      processTask('Lint', worker),
      processTask('Lint', worker), // two tasks share the name: ambiguous, kept by name
    ];
    writeFileSync(file, '{"version":"2.0.0","tasks":[]}');
    await convertTask();
    assert.deepEqual(errors, []);
    assert.deepEqual(
      written(file).map((task) => [task.label, task.dependsOn]),
      [
        ['Logline: Start', ['Logline: Build', 'Migrate', 'Lint']],
        ['Logline: Build', 'Logline: Start'],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dependsOn written only in tasks.json is followed', async () => {
  const { root, file } = setup();
  try {
    const worker = folders[1];
    // VS Code's task omits dependsOn; the folder's tasks.json declares it.
    tasks = [processTask('Serve', worker), processTask('Compile', worker)];
    writeFileSync(
      file,
      JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Serve', type: 'process', dependsOn: 'Compile' }] }),
    );
    await convertTask();
    assert.deepEqual(
      written(file).map((task) => [task.label, task.dependsOn]),
      [
        ['Logline: Serve', 'Logline: Compile'],
        ['Logline: Compile', undefined],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
