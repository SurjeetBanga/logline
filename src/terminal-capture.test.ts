import assert from 'node:assert/strict';
import test from 'node:test';
import { Ingestion } from './capture/ingestion';
import { LogStore } from './core/log-store';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { withVscode } from './test/vscode-mock';

let startListener: ((event: unknown) => void) | undefined;
let endListener: ((event: unknown) => void) | undefined;
let closeListener: ((terminal: unknown) => void) | undefined;
const vscodeMock = { window: {
  terminals: [] as object[],
  onDidStartTerminalShellExecution(listener: (event: unknown) => void) { startListener = listener; return { dispose() { /* test hook */ } }; },
  onDidEndTerminalShellExecution(listener: (event: unknown) => void) { endListener = listener; return { dispose() { /* test hook */ } }; },
  onDidCloseTerminal(listener: (terminal: unknown) => void) { closeListener = listener; return { dispose() { /* test hook */ } }; }
} };

function harness(enabled = true, maxRows = 100000, terminals: object[] = []) {
  startListener = undefined;
  endListener = undefined;
  closeListener = undefined;
  vscodeMock.window.terminals = terminals;
  const loaded = withVscode(vscodeMock, () => require('./vscode/terminal-capture') as typeof import('./vscode/terminal-capture'));
  const store = new LogStore(maxRows);
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

test('existing open terminals are ready to capture their next command', async () => {
  const terminal = { name: 'Existing terminal' };
  const h = harness(true, 100000, [terminal]);
  assert.equal(h.capture.availableTerminals().length, 1);
  const execution = { commandLine: { value: 'npm test' }, cwd: { fsPath: '/workspace' }, async *read() { yield 'captured\n'; } };
  h.start({ terminal, execution });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.store.all().map(event => event.message), ['captured']);
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

test('empty completed terminal runs are pruned while retained runs remain selectable', async () => {
  const h = harness();
  const empty = { commandLine: { value: 'true' }, async *read() { } };
  const terminal = { name: 'Test terminal' };
  h.start({ terminal, execution: empty });
  await new Promise(resolve => setImmediate(resolve));
  h.end({ terminal, execution: empty, exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.registry.records.size, 0);

  const retained = { commandLine: { value: 'echo retained' }, async *read() { yield 'retained\n'; } };
  h.start({ terminal, execution: retained });
  await new Promise(resolve => setImmediate(resolve));
  h.end({ terminal, execution: retained, exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.registry.records.size, 1);
  h.capture.dispose();
});

test('closing a terminal finalizes an active run and removes it from capture management', async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminal = { name: 'Closing terminal' };
  const execution = { commandLine: { value: 'long-running' }, async *read() { yield 'before close\n'; await gate; } };
  h.start({ terminal, execution });
  await new Promise(resolve => setImmediate(resolve));
  closeListener!(terminal);
  const record = [...h.registry.records.values()][0];
  assert.equal(record.status, 'exited');
  assert.equal(record.exitReason, 'terminal closed');
  assert.equal(h.capture.availableTerminals().length, 0);
  release();
  await new Promise(resolve => setImmediate(resolve));
  h.capture.dispose();
});

test('terminal metadata is pruned after retention evicts its final event', async () => {
  const h = harness(true, 1);
  const terminal = { name: 'Evicting terminal' };
  const first = { commandLine: { value: 'first' }, async *read() { yield 'first\n'; } };
  h.start({ terminal, execution: first });
  await new Promise(resolve => setImmediate(resolve));
  h.end({ terminal, execution: first, exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  const firstId = [...h.registry.records.values()][0].id;

  const second = { commandLine: { value: 'second' }, async *read() { yield 'second\n'; } };
  h.start({ terminal, execution: second });
  await new Promise(resolve => setImmediate(resolve));
  h.end({ terminal, execution: second, exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.registry.records.has(firstId), false);
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

test('terminal capture ignores disabled/ignored terminals and records unavailable streams', async () => {
  const terminal = { name: 'Ignored terminal' };
  const h = harness(false, 100000, [terminal]);
  const execution = { commandLine: { value: 'ignored' }, async *read() { yield 'ignored\n'; } };
  h.capture.ignoreTerminal(terminal);
  h.start({ terminal, execution });
  assert.equal(h.registry.records.size, 0);
  h.capture.resetTerminalIgnore(terminal);
  h.capture.setEnabled(true);
  const unavailable = { commandLine: { value: 'unavailable' }, read: () => undefined };
  h.start({ terminal, execution: unavailable });
  assert.equal([...h.registry.records.values()][0].captureStatus, 'unavailable');
  assert.equal(h.capture.status().state, 'attention');
  h.end({ terminal, execution: {} as never, exitCode: 1 });
  h.capture.dispose(); h.capture.dispose();
});
