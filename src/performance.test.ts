import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const settings = new Map<string, unknown>();
const warnings: string[] = [];
let importUris: { scheme: string; path: string; fsPath: string }[] = [];
const mock = {
  workspace: {
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.get(key) ?? fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    fs: { readFile: () => { throw new Error('Native imports must stream instead of reading the whole file'); } }
  },
  window: {
    showWarningMessage: (message: string) => { warnings.push(message); },
    showInformationMessage() {},
    showOpenDialog: async () => importUris
  }
};
const loader = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = (name, ...args) => name === 'vscode' ? mock : original(name, ...args);
let LogsProvider: typeof import('./extension').LogsProvider;
try { ({ LogsProvider } = require('./extension') as typeof import('./extension')); }
finally { loader._load = original; }

function provider() {
  settings.clear(); warnings.length = 0;
  return new LogsProvider({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
}

test('single-stream capture drains excluded output so the child can finish', { timeout: 10000 }, async () => {
  for (const source of ['stdout', 'stderr']) {
    const p = provider();
    settings.set('source', source);
    const excluded = source === 'stdout' ? 'stderr' : 'stdout';
    const program = `const stream = process.${excluded}; let remaining = 64;
      function write() { while (remaining-- > 0) {
        if (!stream.write('x'.repeat(65536))) { stream.once('drain', write); return; }
      } process.${source}.write('done\\n'); } write();`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = new Promise<number>(resolve => {
        p.run(process.execPath, undefined, { id: 'stream-test', label: 'Stream test' }, undefined, undefined, ['-e', program], resolve);
      });
      assert.equal(await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Child blocked on excluded output')), 3000);
      })]), 0);
      assert.deepEqual(p.store.all().map(event => [event.message, event.stream]), [['done', source]]);
    } finally {
      clearTimeout(timer);
      for (const session of p.sessions) session.child.kill('SIGKILL');
      clearTimeout(p.notifyTimer);
    }
  }
});

test('disk backlog stays bounded, reports overflow once, and resumes in order', async () => {
  const p = provider();
  settings.set('persistLogs', true);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const batches: string[] = [];
  p.writeBatch = async batch => { await blocked; batches.push(batch); };
  const accepted: string[] = [];
  for (let i = 0; i < 300; i++) {
    const line = `${i}:` + 'x'.repeat(32768);
    const dropped = p.persistDropped;
    p.persist(line);
    if (p.persistDropped === dropped) accepted.push(line);
    assert.ok(p.queuedWriteBytes <= 8 * 1024 * 1024);
  }
  p.flushPersist();
  assert.ok(p.persistDropped > 0);
  assert.equal(warnings.length, 1);
  assert.equal(batches.length, 0);
  release();
  await p.persistChain;
  assert.equal(p.queuedWriteBytes, 0);
  assert.equal(batches.join(''), accepted.join('\n') + '\n');
  p.persist('recovered'); p.flushPersist();
  await p.persistChain;
  assert.equal(batches.at(-1), 'recovered\n');
  assert.equal(p.queuedWriteBytes, 0);
});

test('disk writes stay ordered during disposal and oversized lines cannot fill the queue', async () => {
  const p = provider();
  settings.set('persistLogs', true);
  const batches: string[] = [];
  p.writeBatch = async batch => { await yieldToHost(); batches.push(batch); };
  p.persist('x'.repeat(8 * 1024 * 1024));
  assert.equal(p.queuedWriteBytes, 0);
  assert.equal(p.persistDropped, 1);
  p.persist('first'); p.flushPersist(); p.persist('last');
  await p.dispose();
  assert.equal(batches.join(''), 'first\nlast\n');
  assert.equal(p.queuedWriteBytes, 0);
});

test('native imports stream, yield to the host, retain session boundaries and truncate oversized records', async () => {
  const p = provider();
  settings.set('maxLineLength', 1024);
  const dir = await mkdtemp(path.join(tmpdir(), 'logline-import-'));
  try {
    const a = path.join(dir, 'a.jsonl'); const b = path.join(dir, 'b.json');
    await writeFile(a, Array.from({ length: 3000 }, (_, i) => JSON.stringify({ message: `log ${i}` })).join('\n')
      + '\n' + 'x'.repeat(2048));
    await writeFile(b, '[{"message":"last"}]');
    importUris = [a, b].map(file => ({ scheme: 'file', path: file, fsPath: file }));
    let ticked = false;
    setImmediate(() => { ticked = true; });
    let tickedDuringImport = false;
    const add = p.store.add.bind(p.store);
    p.store.add = event => { if (ticked) tickedDuringImport = true; add(event); };
    await p.importLogs();
    assert.ok(tickedDuringImport);
    assert.equal(p.store.total, 3002);
    assert.equal(p.store.find(3001)?.raw?.length, 1024);
    assert.equal(p.store.find(3001)?.truncated, true);
    assert.equal(p.store.find(3001)?.isJson, false);
    assert.equal(p.store.find(3002)?.message, 'last');
    assert.notEqual(p.store.find(1)?.sessionId, p.store.find(3002)?.sessionId);
    assert.equal(warnings.length, 0);
  } finally { clearTimeout(p.notifyTimer); await rm(dir, { recursive: true, force: true }); }
});

test('snapshot projects selected custom columns and exposes server-scoped payload choices', () => {
  const p = provider();
  p.store.add({ id: 1, level: 'info', serverId: 'api', fields: { service: 'api', logger: 'main', requestId: 'r1', traceId: 't1', method: 'GET', path: '/', custom: 'value' } });
  p.store.add({ id: 2, level: 'info', serverId: 'worker', fields: { workerOnly: true } });
  const messages: Record<string, any>[] = [];
  const view = { webview: { postMessage: (message: Record<string, any>) => messages.push(message) } } as unknown as import('vscode').WebviewView;
  p.handleMessage(view, { type: 'snapshot', serverId: 'api', columns: ['custom', 'workerOnly'] });
  assert.ok(messages[0].columnFields.includes('custom'));
  assert.ok(!messages[0].columnFields.includes('workerOnly'));
  assert.equal(messages[0].events[0].fields.custom, 'value');
  assert.equal(messages[0].events[0].fields.workerOnly, undefined);
  assert.ok(!messages[0].columns.includes('custom'), 'the selected field is outside the automatic six');
});

test('configured canonical columns resolve aliases in structured payloads', () => {
  const p = provider();
  settings.set('columns', ['service', 'status']);
  p.store.add({ id: 1, level: 'info', fields: { 'service.name': 'api', 'http.response.status_code': 201 } });
  const messages: Record<string, any>[] = [];
  const view = { webview: { postMessage: (message: Record<string, any>) => messages.push(message) } } as unknown as import('vscode').WebviewView;
  p.handleMessage(view, { type: 'snapshot' });
  assert.deepEqual(messages[0].events[0].fields, { service: 'api', status: 201 });
});
