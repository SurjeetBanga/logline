import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { LogStore } from './log-store';
import { parseLogLine } from './log-event';

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
try { LogsProvider = (require('./extension') as typeof import('./extension')).LogsProvider; }
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
  assert.deepEqual(messages[1].events.map((event: { id: number }) => event.id), [1, 2]);
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
