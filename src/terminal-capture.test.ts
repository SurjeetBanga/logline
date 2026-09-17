import assert from 'node:assert/strict';
import test from 'node:test';
import { Ingestion } from './capture/ingestion';
import { LogStore } from './core/log-store';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { withVscode } from './test/vscode-mock';

let startListener: ((event: unknown) => void) | undefined;
let endListener: ((event: unknown) => void) | undefined;
const vscodeMock = { window: {
  onDidStartTerminalShellExecution(listener: (event: unknown) => void) { startListener = listener; return { dispose() { /* test hook */ } }; },
  onDidEndTerminalShellExecution(listener: (event: unknown) => void) { endListener = listener; return { dispose() { /* test hook */ } }; },
  onDidCloseTerminal() { return { dispose() { /* test hook */ } }; }
} };

function harness(enabled = true) {
  startListener = undefined;
  endListener = undefined;
  const loaded = withVscode(vscodeMock, () => require('./vscode/terminal-capture') as typeof import('./vscode/terminal-capture'));
  const store = new LogStore();
  const registry = new SessionRegistry();
  const capture = new loaded.TerminalCapture({ get<T>(_key: string, fallback: T): T { return (_key === 'captureTerminals' ? enabled : fallback) as T; } }, new Ingestion(store, () => { }), registry, new RuntimeState(() => { }));
  return { capture, store, registry, start: startListener!, end: endListener! };
}

test('terminal capture stops accepting a running stream when disabled', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execution = { commandLine: { value: 'npm test' }, cwd: { fsPath: '/workspace' }, async *read() { yield 'first\n'; await gate; yield 'second\n'; } };
  const terminal = { name: 'Test terminal' };
  h.start({ terminal, execution });
  await new Promise(resolve => setImmediate(resolve));
  h.capture.setEnabled(false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  h.end({ terminal, execution, exitCode: 0 });
  assert.deepEqual(h.store.all().map(event => event.message), ['first']);
  assert.equal([...h.registry.records.values()][0].captureStatus, 'interrupted');
  h.capture.dispose();
});

test('terminal capture records stream failures as failed capture', async () => {
  const h = harness();
  const execution = { commandLine: { value: 'broken' }, async *read() { throw new Error('reader closed'); } };
  const terminal = { name: 'Test terminal' };
  h.start({ terminal, execution });
  await new Promise(resolve => setImmediate(resolve));
  const record = [...h.registry.records.values()][0];
  assert.equal(record.captureStatus, 'failed');
  assert.match(record.captureReason ?? '', /reader closed/);
  h.capture.dispose();
});

test('terminal capture prunes completed session history', async () => {
  const h = harness();
  const terminal = { name: 'Test terminal' };
  for (let id = 0; id < 105; id++) {
    const execution = { commandLine: { value: `echo ${id}` }, async *read() { yield 'line\n'; } };
    h.start({ terminal, execution });
    await new Promise(resolve => setImmediate(resolve));
    h.end({ terminal, execution, exitCode: 0 });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(h.registry.records.size <= 100);
  h.capture.dispose();
});
