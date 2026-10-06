import assert from 'node:assert/strict';
import test from 'node:test';
import { Ingestion } from './capture/ingestion';
import { ATTACH_WINDOW_MS, CrashLinker, EXIT_ATTACH_WINDOW_MS } from './core/crash-attach';
import { parseLogLine } from './core/log-event';
import { LogStore } from './core/log-store';
import type { LogEvent } from './core/types';

const crash = [
  '/srv/app/server.js:12',
  '    const total = order.items.reduce(sum);',
  '                              ^',
  'TypeError: Cannot read properties of undefined (reading \'reduce\')',
  '    at checkout (/srv/app/server.js:12:31)'
].join('\n');
const exiting = `${crash}\nNode.js v22.22.0`;

let nextId = 0;
function event(raw: string, serverId = 'api', sessionId = 'run-1'): LogEvent {
  return { ...parseLogLine(raw, 'terminal', ++nextId, new Date()), serverId, sessionId };
}

test('a crash right after a JSON error is attached to it', () => {
  const linker = new CrashLinker();
  const error = event('{"level":"error","msg":"checkout failed"}');
  linker.observe(error, 1000);
  const banner = event('  ▲ Next.js 15.0.0');
  linker.observe(banner, 1100);
  const trace = event(crash);
  linker.observe(trace, 1200);
  assert.equal(trace.attachedTo, error.id);
  assert.equal(banner.attachedTo, undefined);
  // One crash per error.
  const again = event(crash);
  linker.observe(again, 1300);
  assert.equal(again.attachedTo, undefined);
});

test('a crash is not attached across a healthy JSON line, a non-error, another run or another source', () => {
  const cases: [LogEvent[], LogEvent][] = [
    [[event('{"level":"error","msg":"a"}'), event('{"level":"info","msg":"ok"}')], event(crash)],
    [[event('{"level":"warn","msg":"slow"}')], event(crash)],
    [[event('{"level":"error","msg":"a"}', 'api', 'run-1')], event(crash, 'api', 'run-2')],
    [[event('{"level":"error","msg":"a"}', 'api::worker')], event(crash, 'api::web')]
  ];
  for (const [before, trace] of cases) {
    const linker = new CrashLinker();
    for (const item of before) linker.observe(item, 1000);
    linker.observe(trace, 1100);
    assert.equal(trace.attachedTo, undefined);
  }
});

test('the window is short, and longer for a crash that ends the process', () => {
  const at = (raw: string, elapsed: number) => {
    const linker = new CrashLinker();
    const error = event('{"level":50,"msg":"boom"}');
    linker.observe(error, 0);
    const trace = event(raw);
    linker.observe(trace, elapsed);
    return trace.attachedTo === error.id;
  };
  assert.equal(at(crash, ATTACH_WINDOW_MS), true);
  assert.equal(at(crash, ATTACH_WINDOW_MS + 1), false);
  assert.equal(at(exiting, EXIT_ATTACH_WINDOW_MS), true);
  assert.equal(at(exiting, EXIT_ATTACH_WINDOW_MS + 1), false);
  // A joined stack trace counts too; plain lines never do.
  assert.equal(at('TypeError: x\n    at f (/srv/a.js:1:1)', 10), true);
  assert.equal(at('listening on 3000', 10), false);
});

test('captured lines are linked by id without changing either event', () => {
  const store = new LogStore();
  const ingestion = new Ingestion(store, () => undefined);
  const metadata = { serverId: 'api', server: 'api', sessionId: 'run-1' };
  const errorLine = '{"level":"error","msg":"checkout failed","token":"secret"}';
  const error = ingestion.accept(errorLine, 'terminal', metadata)!;
  const trace = ingestion.accept(exiting, 'terminal', metadata)!;
  assert.equal(trace.attachedTo, error.id);
  assert.equal(store.find(error.id)!.raw, errorLine);
  assert.equal(store.find(trace.id)!.raw, exiting);
  assert.equal(store.attachedCrash(error.id)?.id, trace.id);
  assert.equal(store.page().events.find(item => item.id === trace.id)?.attachedTo, error.id);
  // Imports have no arrival timing, so nothing is attached.
  ingestion.accept(errorLine, 'import', metadata);
  assert.equal(ingestion.accept(crash, 'import', metadata)!.attachedTo, undefined);
});

test('the attachment index survives a resize and is dropped with the crash', () => {
  const store = new LogStore(10);
  const ingestion = new Ingestion(store, () => undefined);
  const metadata = { serverId: 'api', server: 'api', sessionId: 'run-1' };
  const error = ingestion.accept('{"level":"error","msg":"a"}', 'terminal', metadata)!;
  const trace = ingestion.accept(crash, 'terminal', metadata)!;
  store.resize(5, store.maxBytes);
  assert.equal(store.attachedCrash(error.id)?.id, trace.id);
  for (let i = 0; i < 5; i++) ingestion.accept(`line ${i}`, 'terminal', metadata);
  assert.equal(store.find(trace.id), undefined);
  assert.equal(store.attachedCrash(error.id), undefined);
  store.clear();
  assert.equal(store.attachedCrash(error.id), undefined);
});
