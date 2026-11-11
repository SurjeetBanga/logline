import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogStore } from '../core/log-store';
import { withVscode } from '../test/vscode-mock';

const item = { text: '', tooltip: '', name: '', command: '', shown: false, disposed: false };
const ui = { asked: [] as string[], answer: undefined as string | undefined, focused: 0, withItem: true };
const registered = new Map<string, () => unknown>();
const mock = {
  StatusBarAlignment: { Left: 1 },
  window: {
    get createStatusBarItem() {
      return ui.withItem
        ? () =>
            Object.assign(item, {
              show: () => (item.shown = true),
              hide: () => (item.shown = false),
              dispose: () => (item.disposed = true),
            })
        : undefined;
    },
    showInformationMessage: async (message: string) => {
      ui.asked.push(message);
      return ui.answer;
    },
  },
  commands: {
    registerCommand: (id: string, handler: () => unknown) => {
      registered.set(id, handler);
      return { dispose: () => registered.delete(id) };
    },
    executeCommand: async (id: string) => {
      if (id === 'logline.logs.focus') ui.focused++;
    },
  },
};
const { CaptureStatus, ERROR_NUDGE_GAP_MS, ERROR_NUDGE_OFF_KEY, isError, statusText } = withVscode(
  mock,
  () => require('./capture-status') as typeof import('./capture-status'),
);

function setup(options: { visible?: boolean; enabled?: boolean } = {}) {
  Object.assign(item, { text: '', shown: false, disposed: false });
  Object.assign(ui, { asked: [], answer: undefined, focused: 0, withItem: true });
  const store = new LogStore();
  const stored = new Map<string, unknown>();
  const state = { generation: 0, now: 1_000_000, visible: options.visible ?? false, enabled: options.enabled ?? true };
  const queries: string[] = [];
  const steps: string[] = [];
  let entered = 0;
  const status = new CaptureStatus({
    store,
    generation: () => state.generation,
    panelVisible: () => state.visible,
    enabled: () => state.enabled,
    showQuery: async (query) => void queries.push(query),
    memento: {
      get: <T>(key: string) => stored.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void stored.set(key, value),
    },
    entered: () => entered++,
    nudged: (step) => steps.push(step),
    now: () => state.now,
  });
  let id = 0;
  const log = (level: string, sessionId = 'run-1', server = 'api') =>
    store.add({ id: ++id, level, serverId: server, server, sessionId, message: level });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { status, store, state, stored, queries, steps, log, settle, entered: () => entered };
}

test('the status text counts logs and errors, shortening large counts', () => {
  assert.equal(statusText(1, 0), '$(pulse) 1 log');
  assert.equal(statusText(128, 3), '$(pulse) 128 logs · 3 errors');
  assert.equal(statusText(1500, 1), '$(pulse) 1.5k logs · 1 error');
  assert.equal(statusText(25_300, 1200), '$(pulse) 25k logs · 1.2k errors');
  assert.equal(statusText(2_400_000, 0), '$(pulse) 2.4M logs');
  assert.equal(isError({ level: 'ERROR' }), true);
  assert.equal(isError({ level: 'fatal' }), true);
  assert.equal(isError({ level: 'warn' }), false);
});

test('the status bar item appears with the first log, counts errors, and opens the panel on them', async () => {
  const h = setup({ visible: true });
  h.status.refresh();
  assert.equal(item.shown, false, 'nothing to say before anything is captured');
  h.log('info');
  h.log('info');
  h.status.refresh();
  assert.equal(item.shown, true);
  assert.equal(item.text, '$(pulse) 2 logs');
  await registered.get('logline.showCaptured')!();
  assert.equal(ui.focused, 1, 'without errors it only opens the panel, keeping its search');
  assert.deepEqual(h.queries, []);
  h.log('error');
  h.status.refresh();
  assert.equal(item.text, '$(pulse) 3 logs · 1 error');
  assert.match(item.tooltip, /errors/);
  await h.status.show();
  assert.deepEqual(h.queries, ['level:error']);
  assert.equal(h.entered(), 2);
  // Clearing the logs starts the counts again.
  h.store.clear();
  h.state.generation++;
  h.status.refresh();
  assert.equal(item.shown, false);
  h.state.enabled = false;
  h.log('info');
  h.status.refresh();
  assert.equal(item.shown, false, 'and the setting hides it');
  h.status.dispose();
  assert.equal(item.disposed, true);
  assert.equal(registered.has('logline.showCaptured'), false);
});

test('errors caught while the panel is hidden are announced once per run, and not often', async () => {
  const h = setup();
  ui.answer = 'Show Errors';
  h.log('info');
  h.status.refresh();
  assert.equal(ui.asked.length, 0);
  h.log('error');
  h.log('error');
  h.status.refresh();
  await h.settle();
  assert.deepEqual(ui.asked, ['Logline caught 2 errors from api.']);
  assert.deepEqual(h.steps, ['shown', 'accepted']);
  assert.deepEqual(h.queries, ['level:error']);
  // More errors from the same run say nothing more.
  h.log('error');
  h.status.refresh();
  await h.settle();
  assert.equal(ui.asked.length, 1);
  // Another run soon after is passed over, for good.
  h.log('error', 'run-2');
  h.status.refresh();
  h.state.now += ERROR_NUDGE_GAP_MS;
  h.log('error', 'run-2');
  h.status.refresh();
  await h.settle();
  assert.equal(ui.asked.length, 1);
  // Two runs failing together are announced together, without a name.
  ui.answer = undefined;
  h.log('fatal', 'run-3', 'web');
  h.log('error', 'run-4', 'worker');
  h.status.refresh();
  await h.settle();
  assert.equal(ui.asked[1], 'Logline caught 2 errors.');
  assert.equal(h.steps.at(-1), 'dismissed');
  h.status.dispose();
});

test('nothing is announced to someone looking at the panel, or who asked not to be told', async () => {
  const looking = setup({ visible: true });
  looking.log('error');
  looking.status.refresh();
  await looking.settle();
  assert.equal(ui.asked.length, 0);
  looking.status.dispose();

  const h = setup();
  ui.answer = "Don't Show Again";
  h.log('error');
  h.status.refresh();
  await h.settle();
  assert.deepEqual(ui.asked, ['Logline caught 1 error from api.']);
  assert.equal(h.stored.get(ERROR_NUDGE_OFF_KEY), true);
  assert.deepEqual(h.steps, ['shown', 'never']);
  h.state.now += ERROR_NUDGE_GAP_MS;
  h.log('error', 'run-2');
  h.status.refresh();
  await h.settle();
  assert.equal(ui.asked.length, 1);
  h.status.dispose();
});

test('a host without status bar items still announces errors', async () => {
  const h = setup();
  h.status.dispose();
  ui.withItem = false;
  const store = new LogStore();
  const status = new CaptureStatus({
    store,
    generation: () => 0,
    panelVisible: () => false,
    enabled: () => true,
    showQuery: async () => undefined,
    memento: { get: () => undefined, update: async () => undefined },
  });
  store.add({ id: 1, level: 'error', message: 'no run to name' });
  store.add({ id: 2, level: 'error', serverId: 'api', sessionId: 'a' });
  status.refresh();
  await h.settle();
  assert.deepEqual(ui.asked, ['Logline caught 1 error.']);
  status.dispose();
});
