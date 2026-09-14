import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

const settings = new Map<string, unknown>();
const warnings: string[] = [];
let importUris: { scheme: string; path: string; fsPath: string; }[] = [];
const mock = {
  workspace: {
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings.get(key) ?? fallback }),
    onDidChangeConfiguration: () => ({ dispose() { } }),
    fs: { readFile: () => { throw new Error('Native imports must stream instead of reading the whole file'); } }
  },
  window: {
    showWarningMessage: (message: string) => { warnings.push(message); },
    showInformationMessage() { },
    showOpenDialog: async () => importUris
  }
};
const { LogsController } = withVscode(mock, () => require('./vscode/logs-controller') as typeof import('./vscode/logs-controller'));

function provider() {
  settings.clear(); warnings.length = 0;
  return new LogsController({ globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => { } } } as unknown as import('vscode').ExtensionContext);
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
        p.runner.run(process.execPath, undefined, { id: 'stream-test', label: 'Stream test' }, undefined, undefined, ['-e', program], resolve);
      });
      assert.equal(await Promise.race([done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Child blocked on excluded output')), 3000);
      })]), 0);
      assert.deepEqual(p.store.all().map(event => [event.message, event.stream]), [['done', source]]);
    } finally {
      clearTimeout(timer);
      for (const session of p.runner.sessions) session.child.kill('SIGKILL');
      p.notifications.dispose();
    }
  }
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
    await p.transfer.importLogs();
    assert.ok(tickedDuringImport);
    assert.equal(p.store.total, 3002);
    assert.equal(p.store.find(3001)?.raw?.length, 1024);
    assert.equal(p.store.find(3001)?.truncated, true);
    assert.equal(p.store.find(3001)?.isJson, false);
    assert.equal(p.store.find(3002)?.message, 'last');
    assert.notEqual(p.store.find(1)?.sessionId, p.store.find(3002)?.sessionId);
    assert.equal(warnings.length, 0);
  } finally { p.notifications.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('clear resets completed import status along with retained logs', () => {
  const p = provider();
  p.ingestion.accept('{"message":"imported"}', 'import', { serverId: 'imported', server: 'Imported', sessionId: 'file' });
  p.state.status = 'Imported 19 events';
  p.state.command = 'stale command';

  p.clear();

  assert.equal(p.store.total, 0);
  assert.equal(p.store.size, 0);
  assert.equal(p.state.status, 'Ready — run a server command to begin');
  assert.equal(p.state.command, '');
});

test('snapshot projects selected custom columns and exposes server-scoped payload choices', () => {
  const p = provider();
  p.store.add({ id: 1, level: 'info', serverId: 'api', fields: { service: 'api', logger: 'main', requestId: 'r1', traceId: 't1', method: 'GET', path: '/', custom: 'value' } });
  p.store.add({ id: 2, level: 'info', serverId: 'worker', fields: { workerOnly: true } });
  const messages: Record<string, any>[] = [];

  p.handleMessage(message => { messages.push(message); }, { type: 'snapshot', serverId: 'api', columns: ['custom', 'workerOnly'] });
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

  p.handleMessage(message => { messages.push(message); }, { type: 'snapshot' });
  assert.deepEqual(messages[0].events[0].fields, { service: 'api', status: 201 });
});
