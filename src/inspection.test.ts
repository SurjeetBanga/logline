import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { LogStore } from './log-store';
import { parseLogLine } from './log-event';
import { parseJsonc } from './jsonc';

// Exercise the extension's actual message handlers without launching VS Code.
// Only editor/workspace I/O is replaced; parsing, retention and routing are real.
const workspaceRoot = path.resolve('inspection-fixture');
const uri = (file: string) => ({ fsPath: file, path: file.replace(/\\/g, '/'), toString: () => file });
const files = new Set<string>();
const notices: string[] = [];
const opened: { document: unknown; options: unknown }[] = [];
let lookup: ReturnType<typeof uri>[] = [];
let choices: unknown[] = [];
class Position { constructor(public line: number, public character: number) {} }
class Range { constructor(public start: Position, public end: Position) {} }
const mock = {
  Position, Range, Uri: { file: uri }, FileType: { File: 1 },
  workspace: {
    workspaceFolders: [{ uri: uri(workspaceRoot) }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    fs: { stat: async (value: ReturnType<typeof uri>) => {
      if (!files.has(value.fsPath)) throw new Error('missing');
      return { type: 1 };
    } },
    findFiles: async () => lookup,
    asRelativePath: (value: ReturnType<typeof uri>) => path.relative(workspaceRoot, value.fsPath),
    openTextDocument: async (value: ReturnType<typeof uri>) => ({ uri: value, lineCount: 100, lineAt: () => ({ text: ' '.repeat(80) }) })
  },
  window: {
    showInformationMessage: (message: string) => { notices.push(message); },
    showTextDocument: async (document: unknown, options: unknown) => { opened.push({ document, options }); },
    showQuickPick: async (items: unknown[]) => { choices = items; return items[0]; }
  }
};
const moduleLoader = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, ...args) => name === 'vscode' ? mock : originalLoad(name, ...args);
let LogsProvider: typeof import('./extension').LogsProvider;
let taskToLoglineDefinition: typeof import('./extension').taskToLoglineDefinition;
let appendTasksToJsonc: typeof import('./extension').appendTasksToJsonc;
try { ({ LogsProvider, taskToLoglineDefinition, appendTasksToJsonc } = require('./extension') as typeof import('./extension')); }
finally { moduleLoader._load = originalLoad; }

function setup(stack = 'Error: Failed\n    at run (src/main.ts:42:9)') {
  notices.length = 0; opened.length = 0; files.clear(); lookup = []; choices = [];
  const provider = Object.create(LogsProvider.prototype) as import('./extension').LogsProvider;
  provider.store = new LogStore(100);
  const event = parseLogLine(JSON.stringify({ message: 'Failed', err: { stack } }), 'stderr', 2, new Date());
  provider.store.add({ id: 1, level: 'debug', message: 'Preparing' });
  provider.store.add(event);
  return provider;
}

test('details and context messages return bounded structured data to the right view', () => {
  const provider = setup();
  const messages: Record<string, any>[] = [];
  const view = { webview: { postMessage: (message: Record<string, any>) => messages.push(message) } } as unknown as import('vscode').WebviewView;
  provider.handleMessage(view, { type: 'details', id: 2, target: 'context' });
  assert.equal(messages[0].target, 'context');
  assert.equal(messages[0].exceptions[0].lines[1].source.file, 'src/main.ts');
  assert.equal(JSON.parse(messages[0].text).message, 'Failed');
  provider.handleMessage(view, { type: 'context', id: 2, levels: ['error'], query: 'Failed' });
  assert.deepEqual(messages[1].events.map((event: { id: number }) => event.id), [2]);
  provider.store.clear();
  provider.handleMessage(view, { type: 'details', id: 2, target: 'context' });
  assert.deepEqual(messages[2].exceptions, []);
  assert.match(messages[2].text, /discarded/);
  provider.handleMessage(view, { type: 'context', id: 2 });
  assert.equal(messages[3].missing, true);
});

test('source links use the retained frame, not a supplied path or command', async () => {
  const provider = setup();
  files.add(path.join(workspaceRoot, 'src/main.ts'));
  await provider.openSource({ id: 2, block: 0, line: 1, file: '/other/private.ts', command: 'malicious' });
  assert.equal(opened.length, 1);
  const result = opened[0] as { document: { uri: ReturnType<typeof uri> }; options: { selection: Range } };
  assert.equal(result.document.uri.fsPath, path.join(workspaceRoot, 'src/main.ts'));
  assert.deepEqual(result.options.selection.start, new Position(41, 8));
  await provider.openSource({ id: 2, block: -1, line: 1 });
  assert.equal(opened.length, 1);
});

test('ambiguous Java frames prompt for a workspace file; missing files stay unopened', async () => {
  const provider = setup('    at app.Service.run(Service.java:27)');
  lookup = [uri(path.join(workspaceRoot, 'api/Service.java')), uri(path.join(workspaceRoot, 'worker/Service.java'))];
  await provider.openSource({ id: 2, block: 0, line: 0 });
  assert.equal(choices.length, 2);
  assert.equal(opened.length, 1);
  lookup = [];
  await provider.openSource({ id: 2, block: 0, line: 0 });
  assert.equal(opened.length, 1);
  assert.match(notices.at(-1)!, /not found/);
  provider.store.clear();
  await provider.openSource({ id: 2, block: 0, line: 0 });
  assert.match(notices.at(-1)!, /discarded/);
});

test('absolute paths outside the workspace are never opened directly', async () => {
  const outside = path.resolve(workspaceRoot, '../outside/main.ts');
  const provider = setup(`    at run (${outside}:1:1)`);
  files.add(outside);
  await provider.openSource({ id: 2, block: 0, line: 0 });
  assert.equal(opened.length, 0);
  assert.match(notices.at(-1)!, /not found/);
});

test('task lifecycle records names, dependencies, process ids, and exit reasons', () => {
  const provider = setup();
  const execution = { task: { name: 'Build API', source: 'npm', definition: {
    type: 'shell', dependsOn: ['Lint', 'Generate types']
  } } } as unknown as import('vscode').TaskExecution;
  provider.captureTaskStart(execution);
  provider.captureTaskProcessStart(execution, 42);
  provider.captureTaskProcessEnd(execution, 7);
  assert.ok(provider.taskExecutions);
  provider.captureTaskEnd(execution);
  const record = [...provider.sessionRegistry.values()].find(value => value.taskName === 'Build API')!;
  assert.equal(record.status, 'failed');
  assert.equal(record.pid, 42);
  assert.equal(record.exitReason, 'exit code 7');
  assert.deepEqual(record.dependencies, ['Lint', 'Generate types']);
  // Neither named dependency has actually run in this test, so it can't be ready yet.
  assert.equal(record.dependencyState, 'pending');
  const events = provider.store.all({ serverId: record.serverId });
  assert.ok(events.some(event => event.message?.includes('Task started')));
  assert.ok(events.some(event => event.message?.includes('exit code 7')));
});

test('dependencyState turns ready only once every named dependency has finished', () => {
  const provider = setup();
  const build = { task: { name: 'Build API', source: 'npm', definition: {
    type: 'shell', dependsOn: ['Lint', 'Generate types']
  } } } as unknown as import('vscode').TaskExecution;
  const lint = { task: { name: 'Lint', source: 'npm', definition: { type: 'shell' } } } as unknown as import('vscode').TaskExecution;
  const generate = { task: { name: 'Generate types', source: 'npm', definition: { type: 'shell' } } } as unknown as import('vscode').TaskExecution;
  provider.captureTaskStart(build);
  const buildRecord = [...provider.sessionRegistry.values()].find(value => value.taskName === 'Build API')!;
  assert.equal(buildRecord.dependencyState, 'pending');
  provider.captureTaskStart(lint);
  provider.captureTaskEnd(lint);
  assert.equal(buildRecord.dependencyState, 'pending');
  provider.captureTaskStart(generate);
  provider.captureTaskEnd(generate);
  assert.equal(buildRecord.dependencyState, 'ready');
});

test('process and shell task executions become captured Logline definitions', () => {
  const process = taskToLoglineDefinition({ name: 'Compile', source: 'npm', definition: { type: 'process' },
    execution: { process: 'node', args: ['script.js', 'path with spaces'], options: { cwd: '${workspaceFolder}' } }
  } as unknown as import('vscode').Task)!;
  assert.equal(process.shell, false);
  assert.deepEqual(process.args, ['script.js', 'path with spaces']);
  assert.equal(process.options?.cwd, '${workspaceFolder}');
  const shell = taskToLoglineDefinition({ name: 'Watch', source: 'shell', definition: { type: 'shell' },
    execution: { commandLine: 'npm run watch -- --verbose', options: {} }
  } as unknown as import('vscode').Task)!;
  assert.equal(shell.shell, true);
  assert.equal(shell.command, 'npm run watch -- --verbose');
});

test('a shell command/args pair is rejoined into one quoted command line', () => {
  const shell = taskToLoglineDefinition({ name: 'Grep', source: 'shell', definition: { type: 'shell' },
    execution: { command: 'grep', args: ['a value with spaces', { value: 'literal"quote', quoting: 'strong' }], options: {} }
  } as unknown as import('vscode').Task)!;
  assert.equal(shell.shell, true);
  assert.equal(shell.command, 'grep "a value with spaces" "literal\\"quote"');
});

test('appendTasksToJsonc inserts the first entry into an empty tasks array', () => {
  const result = appendTasksToJsonc('{\n  "version": "2.0.0",\n  "tasks": []\n}', [{ label: 'Logline: New' }])!;
  const parsed = JSON.parse(result) as { tasks: { label: string }[] };
  assert.deepEqual(parsed.tasks.map(task => task.label), ['Logline: New']);
});

test('appendTasksToJsonc adds a separating comma only when one is not already present', () => {
  const withoutComma = appendTasksToJsonc('{"tasks": [{"label": "Existing"}]}', [{ label: 'New' }])!;
  assert.deepEqual(JSON.parse(withoutComma).tasks.map((t: { label: string }) => t.label), ['Existing', 'New']);
  const withComma = appendTasksToJsonc('{"tasks": [{"label": "Existing"},]}', [{ label: 'New' }])!;
  assert.equal(/"Existing"\s*,\s*\{/.test(withComma), false, 'a pre-existing trailing comma must not be doubled');
  assert.deepEqual((parseJsonc(withComma) as { tasks: { label: string }[] }).tasks.map(t => t.label), ['Existing', 'New']);
});

test('appendTasksToJsonc ignores a commented-out tasks property and nested arrays in existing tasks', () => {
  const text = [
    '{',
    '  // "tasks": ["not this one"]',
    '  "version": "2.0.0",',
    '  "tasks": [',
    '    { "label": "Existing", "problemMatcher": ["$tsc", "$eslint-stylish"] }',
    '  ]',
    '}'
  ].join('\n');
  const result = appendTasksToJsonc(text, [{ label: 'New' }])!;
  const parsed = parseJsonc(result) as { tasks: { label: string }[] };
  assert.deepEqual(parsed.tasks.map(task => task.label), ['Existing', 'New']);
});

test('appendTasksToJsonc returns undefined when there is no tasks array to preserve', () => {
  assert.equal(appendTasksToJsonc('{"version": "2.0.0"}', [{ label: 'New' }]), undefined);
});

test('saveSearch dedupes by query and server, caps history at 50, and falls back to the query as a name', () => {
  const provider = setup();
  const first = provider.saveSearch(undefined, 'status:500', ['error'], 'api')!;
  assert.equal(first.name, 'status:500');
  const renamed = provider.saveSearch('Server errors', 'status:500', ['error'], 'api')!;
  assert.equal(provider.savedSearches().length, 1, 'saving the same query/server again replaces the old entry');
  assert.equal(renamed.name, 'Server errors');
  provider.saveSearch('Other server', 'status:500', ['error'], 'worker');
  assert.equal(provider.savedSearches().length, 2, 'the same query against a different server is a distinct entry');
  for (let i = 0; i < 60; i++) provider.saveSearch(undefined, `q${i}`);
  assert.equal(provider.savedSearches().length, 50);
  assert.equal(provider.saveSearch(undefined, '   '), undefined, 'a blank query with no server is not worth saving');
});

test('deleteSavedSearch removes only the matching entry', () => {
  const provider = setup();
  const a = provider.saveSearch(undefined, 'a')!;
  provider.saveSearch(undefined, 'b');
  provider.deleteSavedSearch(a.id);
  assert.deepEqual(provider.savedSearches().map(search => search.query), ['b']);
});

test('CSV imports round-trip a Logline export and accept foreign files', () => {
  const { parseCsvRecords, parseCsv } = require('./extension') as typeof import('./extension');
  // A Logline CSV export carries `raw`, which replays the original line exactly.
  const exported = 'id,timestamp,level,message,raw,field:service\n'
    + '7,10:00:00.000,error,Boom,"{""level"":""error"",""message"":""Boom"",""service"":""api""}",api\n';
  assert.deepEqual(parseCsvRecords(exported), ['{"level":"error","message":"Boom","service":"api"}']);

  // A CSV from anywhere else becomes a record built from its own headers.
  const foreign = 'level,message,service\nwarn,"Disk ""nearly"" full, 91%",storage\ninfo,Started,storage\n';
  assert.deepEqual(parseCsvRecords(foreign), [
    { level: 'warn', message: 'Disk "nearly" full, 91%', service: 'storage' },
    { level: 'info', message: 'Started', service: 'storage' }
  ]);

  // Quoted cells may span newlines, and blank rows are skipped.
  assert.deepEqual(parseCsv('a,b\n"line one\nline two",second\n\n'),
    [['a', 'b'], ['line one\nline two', 'second'], ['']]);
  assert.deepEqual(parseCsvRecords('level,message\n\ninfo,ok\n'), [{ level: 'info', message: 'ok' }]);
  assert.deepEqual(parseCsvRecords(''), []);
  assert.deepEqual(parseCsvRecords('id,timestampMs,message\n5,1700000000000,hi\n'), [{ message: 'hi' }],
    'ids and epoch columns are re-derived on ingest rather than carried over');
});
