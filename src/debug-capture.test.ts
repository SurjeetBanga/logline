import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugCapture, locationOf, type DebugSessionInfo } from './capture/debug-capture';
import { Ingestion } from './capture/ingestion';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { LogStore } from './core/log-store';
import { withVscode } from './test/vscode-mock';

function harness(settings: Record<string, unknown> = {}, terminalCapture = false) {
  const store = new LogStore();
  const registry = new SessionRegistry();
  const persisted: string[] = [];
  const capture = new DebugCapture({ get<T>(key: string, fallback: T): T { return (key in settings ? settings[key] : fallback) as T; } },
    registry, new Ingestion(store, raw => persisted.push(raw)), new RuntimeState(() => { }), () => terminalCapture);
  return { capture, store, registry, persisted };
}
const session = (overrides: Partial<DebugSessionInfo> = {}): DebugSessionInfo => ({ id: 's1', name: 'Launch API', type: 'node', ...overrides });

test('debug output chunks are framed into lines per category', () => {
  const h = harness({ joinStackTraces: false });
  h.capture.start(session());
  h.capture.output('s1', { category: 'stdout', output: 'server listening on ' });
  h.capture.output('s1', { category: 'stdout', output: '3000\n{"level":"warn","msg":"slow"}\n' });
  h.capture.output('s1', { category: 'stderr', output: 'boom\n' });
  h.capture.output('s1', { category: 'telemetry', output: 'ignored\n' });
  h.capture.output('s1', { output: 'Debugger attached.\n' });
  const events = h.store.all();
  assert.deepEqual(events.map(event => [event.message, event.stream, event.level]), [
    ['server listening on 3000', 'stdout', 'info'], ['slow', 'stdout', 'warn'], ['boom', 'stderr', 'error'], ['Debugger attached.', 'console', 'info']
  ]);
  assert.equal(events[0].serverId, 'debug:Launch API');
  assert.equal(events[0].server, 'Debug · Launch API');
  assert.deepEqual(h.persisted.length, 4);
});

test('a debug run is created on first output and completed when the session ends', () => {
  const h = harness();
  h.capture.start(session({ id: 'parent' }));
  h.capture.start(session({ id: 'child', command: 'node · app.js' }));
  h.capture.end('parent');
  assert.equal(h.registry.records.size, 0, 'a silent session leaves no run');
  h.capture.output('child', { category: 'stdout', output: 'unterminated' });
  assert.equal(h.capture.active, 1);
  h.capture.exited('child', 3);
  h.capture.end('child');
  const [record] = h.registry.records.values();
  assert.equal(record.sourceKind, 'debug');
  assert.equal(record.command, 'node · app.js');
  assert.equal(record.status, 'failed');
  assert.equal(record.exitReason, 'exit code 3');
  assert.equal(record.events, 1);
  assert.deepEqual(h.store.all().map(event => event.message), ['unterminated']);
  h.capture.output('child', { category: 'stdout', output: 'late\n' });
  assert.equal(h.store.all().length, 1);
});

test('adapter-reported code locations are attached and survive stack joining', () => {
  const h = harness();
  h.capture.start(session());
  h.capture.output('s1', { category: 'stdout', output: 'user 42 logged in\n', source: { path: '/work/src/auth.ts' }, line: 18, column: 5 });
  h.capture.output('s1', { category: 'stderr', output: 'Error: nope\n', source: { path: 'file:///work/src/db.ts' }, line: 7 });
  h.capture.output('s1', { category: 'stderr', output: '    at query (/work/src/db.ts:7:9)\n' });
  h.capture.end('s1');
  const [login, error] = h.store.all();
  assert.deepEqual(login.location, { file: '/work/src/auth.ts', line: 18, column: 5 });
  assert.equal(error.raw, 'Error: nope\n    at query (/work/src/db.ts:7:9)');
  assert.deepEqual(error.location, { file: '/work/src/db.ts', line: 7 });
});

test('locations from adapter memory or malformed lines are ignored', () => {
  assert.equal(locationOf({ source: { path: 'node:internal/timers' }, line: 3 }), undefined);
  assert.equal(locationOf({ source: { path: '/a.ts' }, line: 0 }), undefined);
  assert.equal(locationOf({ source: { name: 'eval' }, line: 1 }), undefined);
  assert.deepEqual(locationOf({ source: { path: 'C:\\src\\a.cs' }, line: 2 }), { file: 'C:\\src\\a.cs', line: 2 });
});

test('debug capture respects the setting and avoids terminal duplicates', () => {
  const off = harness({ captureDebugSessions: false });
  off.capture.start(session());
  off.capture.output('s1', { category: 'stdout', output: 'x\n' });
  off.capture.end('s1');
  assert.equal(off.store.all().length, 0);
  const duplicate = harness({}, true);
  duplicate.capture.start(session({ console: 'integratedTerminal' }));
  duplicate.capture.output('s1', { category: 'stdout', output: 'x\n' });
  duplicate.capture.end('s1');
  assert.equal(duplicate.store.all().length, 0);
  const console = harness({}, true);
  console.capture.start(session({ console: 'internalConsole' }));
  console.capture.output('s1', { category: 'stdout', output: 'x\n' });
  console.capture.end('s1');
  assert.equal(console.store.all().length, 1);
});

test('stopping a debug run asks VS Code to stop the session once', () => {
  let stops = 0;
  const h = harness();
  h.capture.start(session({ stop: () => { stops++; } }));
  h.capture.output('s1', { category: 'stdout', output: 'x\n' });
  const [record] = h.registry.records.values();
  assert.equal(record.canStop, true);
  h.capture.stopSessionById(record.id);
  h.capture.stopServer('debug:Launch API');
  assert.equal(stops, 1);
  assert.equal(record.status, 'stopping');
  h.capture.end('s1');
  assert.equal(record.status, 'exited');
});

test('the tracker adapter forwards output and lifecycle events for every debug type', () => {
  let factoryType: string | undefined;
  let factory: { createDebugAdapterTracker(session: unknown): { onDidSendMessage(message: unknown): void; onExit(): void } } | undefined;
  let terminate: ((session: { id: string }) => void) | undefined;
  const stopped: unknown[] = [];
  const mock = { debug: {
    registerDebugAdapterTrackerFactory(type: string, value: typeof factory) { factoryType = type; factory = value; return { dispose() { } }; },
    onDidTerminateDebugSession(listener: typeof terminate) { terminate = listener; return { dispose() { } }; },
    stopDebugging(value: unknown) { stopped.push(value); return Promise.resolve(); }
  } };
  const loaded = withVscode(mock, () => require('./vscode/debug-capture') as typeof import('./vscode/debug-capture'));
  const h = harness();
  assert.equal(loaded.registerDebugCapture(h.capture).length, 2);
  assert.equal(factoryType, '*');
  const parent = { id: 'p', name: 'Launch API', type: 'pwa-node', configuration: { name: 'Launch API', program: '/w/app.js' } };
  const child = { id: 'c', name: 'app.js [123]', type: 'pwa-node', configuration: { name: 'app.js [123]', program: '/w/app.js', cwd: '/w' }, parentSession: parent };
  const tracker = factory!.createDebugAdapterTracker(child);
  tracker.onDidSendMessage({ type: 'event', event: 'output', body: { category: 'stdout', output: 'hello\n' } });
  tracker.onDidSendMessage({ type: 'response', command: 'threads' });
  tracker.onDidSendMessage({ type: 'event', event: 'exited', body: { exitCode: 0 } });
  const [record] = h.registry.records.values();
  assert.equal(record.serverId, 'debug:Launch API');
  assert.equal(record.command, 'pwa-node · /w/app.js');
  assert.equal(record.cwd, '/w');
  h.capture.stopSessionById(record.id);
  assert.deepEqual(stopped, [child]);
  terminate!({ id: 'c' });
  assert.equal(record.status, 'exited');
});

test('the tracker adapter is inert when the debug API is unavailable', () => {
  delete require.cache[require.resolve('./vscode/debug-capture')];
  const loaded = withVscode({}, () => require('./vscode/debug-capture') as typeof import('./vscode/debug-capture'));
  assert.deepEqual(loaded.registerDebugCapture(harness().capture), []);
});

test('completed debug runs are forgotten once none of their events are retained', () => {
  const h = harness({ joinStackTraces: false });
  h.capture.start(session());
  h.capture.output('s1', { category: 'stdout', output: 'x\n' });
  const [record] = h.registry.records.values();
  const retained = () => h.store.sessionEventCount(record.serverId, record.id);
  h.registry.pruneEmptyCompleted(['debug'], (serverId, id) => h.store.sessionEventCount(serverId, id));
  assert.equal(h.registry.records.size, 1, 'a running session is kept');
  h.capture.end('s1');
  h.registry.pruneEmptyCompleted(['debug'], (serverId, id) => h.store.sessionEventCount(serverId, id));
  assert.equal(h.registry.records.size, 1, 'a completed run with retained events is kept');
  h.store.clear();
  assert.equal(retained(), 0);
  h.registry.pruneEmptyCompleted(['debug'], (serverId, id) => h.store.sessionEventCount(serverId, id));
  assert.equal(h.registry.records.size, 0);
});
