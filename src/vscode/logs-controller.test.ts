import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

const notices: string[] = [];
let buttons: string[] = [];
const settings: { key: string; value: unknown }[] = [];
let pick: (items: { runId: string }[]) => unknown = () => undefined;
const mock = {
  ConfigurationTarget: { Workspace: 2 },
  commands: { executeCommand: async () => undefined },
  extensions: { getExtension: () => undefined },
  workspace: {
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      update: async (key: string, value: unknown) => {
        settings.push({ key, value });
      },
    }),
  },
  window: {
    showInformationMessage: async (message: string, ...actions: unknown[]) => {
      notices.push(message);
      buttons = actions.filter((action): action is string => typeof action === 'string');
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      notices.push(message);
      return warningAnswer;
    },
    showQuickPick: async (items: { runId: string }[]) => pick(items),
  },
};
let warningAnswer: string | undefined;
const { LogsController } = withVscode(mock, () => require('./logs-controller') as typeof import('./logs-controller'));

function setup(t: { after(fn: () => Promise<void>): void }) {
  notices.length = 0;
  settings.length = 0;
  pick = () => undefined;
  const controller = new LogsController({
    globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
  } as unknown as import('vscode').ExtensionContext);
  t.after(() => controller.dispose());
  return controller;
}

test('editor features that this host or window lacks are explained instead of failing', async (t) => {
  const controller = setup(t);
  await controller.openLogSite(404);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', message: 'no statement for this' });
  await controller.openLogSite(1);
  await controller.connectAgent();
  await controller.doctorAction('report');
  await controller.breakOnEvent(1);
  await controller.breakOnQuery('level:error', []);
  assert.deepEqual(notices, [
    'This event has been discarded from retained history.',
    'Logline could not find the log statement for this event in the workspace.',
    'Logline is not accepting MCP clients in this window. Turn on logline.externalAgents to connect Claude Code or Codex.',
    'Log doctor needs a VS Code host with diagnostics support.',
    'Log breakpoints need a VS Code host with debugging support.',
    'Log breakpoints need a VS Code host with debugging support.',
  ]);
});

test('sharing from an event that is gone, or choosing no runs, shares nothing', async (t) => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  await controller.shareWithAgent(undefined, 404);
  assert.match(notices.at(-1)!, /That log event is no longer available/);

  // Choosing runs, then clearing every choice, stops sharing.
  controller.agentAccess.share(['api'], undefined, ['a']);
  pick = () => [];
  await controller.shareWithAgent(undefined, undefined, undefined, true);
  assert.equal(controller.agentAccess.status().active, false);
});

test('without Copilot, the sharing notice offers no Ask Copilot button', async (t) => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  pick = (items) => items;
  await controller.shareWithAgent(undefined, undefined, undefined, true);
  assert.equal(controller.agentAccess.status().active, true);
  assert.match(notices.at(-1)!, /^Logline: The selected command runs are now shared with agents/);
  assert.deepEqual(buttons, []);
});

test('secrets in output that no statement accounts for are found once, and found again after a clear', async (t) => {
  const controller = setup(t);
  // Built at runtime: secret-shaped literals are refused by push protection.
  const token = ['Bearer', 'x'.repeat(24)].join(' ');
  controller.store.add({ level: 'info', id: 1, serverId: 'api', message: `calling upstream with ${token}` });
  const first = controller.unclaimedSensitive();
  assert.equal(first.more, false);
  assert.equal(first.findings.length, 1);
  assert.doesNotMatch(JSON.stringify(first.findings), /x{24}/, 'only a masked preview is kept');
  assert.equal(controller.unclaimedSensitive().version, first.version, 'nothing new, nothing rescanned');

  controller.clear();
  assert.equal(controller.unclaimedSensitive().findings.length, 0);
  controller.store.add({ level: 'info', id: 2, serverId: 'api', message: `retry with ${token}` });
  assert.equal(controller.unclaimedSensitive().findings.length, 1);
});

test('traces, metrics, and telemetry findings read the window stores, and findings are cached', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  controller.store.add({ level: 'info', id: 1, serverId: 'api', message: 'GET /orders', fields: { traceId } });
  assert.deepEqual(
    controller.traceList().map((trace) => trace.traceId),
    [traceId],
  );
  assert.equal(controller.traceView(traceId.toUpperCase()).traceId, traceId);
  assert.deepEqual(controller.metricList(), []);
  const findings = controller.telemetryFindings();
  assert.equal(controller.telemetryFindings(), findings, 'unchanged stores reuse the last result');
});

test('terminal capture is switched in the workspace settings and takes effect at once', async (t) => {
  const controller = setup(t);
  await controller.toggleTerminalCapture(true);
  await controller.toggleTerminalCapture(false);
  assert.deepEqual(settings, [
    { key: 'captureTerminals', value: true },
    { key: 'captureTerminals', value: false },
  ]);
});

test('removing a source drops its logs, runs, and share, and says so', async (t) => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', server: 'API', sessionId: 'a', message: 'one' });
  controller.store.add({ level: 'info', id: 2, serverId: 'web', server: 'Web', sessionId: 'w', message: 'two' });
  controller.store.add({ level: 'info', id: 3, serverId: 'api', server: 'API', sessionId: 'a', message: 'three' });
  controller.registry.records.set('a', {
    id: 'a',
    serverId: 'api',
    server: 'API',
    status: 'exited',
    startedAt: 0,
    events: 2,
  } as never);
  controller.registry.records.set('o', {
    id: 'o',
    serverId: 'api',
    server: 'API',
    status: 'running',
    startedAt: 0,
    events: 0,
  } as never);
  controller.agentAccess.share(['api', 'web']);
  // A running source that Logline can stop is stopped only after asking.
  controller.registry.records.set('p', {
    id: 'p',
    serverId: 'web',
    server: 'Web',
    status: 'running',
    canStop: true,
    startedAt: 0,
    events: 1,
  } as never);
  assert.equal(await controller.removeSource('web'), 0);
  assert.equal(notices.at(-1), 'Stop Web and remove its logs?');
  assert.equal(controller.store.all().length, 3, 'declining keeps everything');
  controller.registry.records.delete('p');
  const generation = controller.state.generation;
  assert.equal(await controller.removeSource('api'), 2);
  assert.deepEqual(
    controller.store.all().map((event) => event.id),
    [2],
  );
  assert.equal(controller.registry.records.has('a'), false);
  assert.equal(controller.registry.records.has('o'), true, 'a run that keeps capturing keeps its record');
  assert.deepEqual(
    controller.agentAccess.status().sources.map((source) => source.id),
    ['web'],
  );
  assert.equal(controller.state.status, 'Removed API and its 2 logs');
  assert.ok(controller.state.generation > generation, 'the view starts over from what is retained');
  assert.equal(await controller.removeSource(''), 0);
});

test('the guide’s steps stay done once done, and Show me reaches the panel with the next snapshot', async (t) => {
  const saved = new Map<string, unknown>();
  const controller = new LogsController({
    globalState: {
      get: (key: string, fallback?: unknown) => (saved.has(key) ? saved.get(key) : fallback),
      update: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
    },
  } as unknown as import('vscode').ExtensionContext);
  t.after(() => controller.dispose());
  assert.deepEqual(controller.guideProgress(), { captured: false, searched: false, shared: false });
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'one' });
  controller.snapshot({ type: 'snapshot', query: 'level:error' });
  controller.agentAccess.shareAll();
  assert.deepEqual(controller.guideProgress(), { captured: true, searched: true, shared: true });
  controller.clear();
  assert.deepEqual(
    controller.guideProgress(),
    { captured: true, searched: true, shared: true },
    'clearing logs or stopping sharing does not undo a step',
  );

  await controller.reveal('connectionRun', 'sourceRail');
  assert.deepEqual(controller.snapshot({ type: 'snapshot' }).reveal, {
    target: 'connectionRun',
    fallback: 'sourceRail',
  });
  assert.equal(controller.snapshot({ type: 'snapshot' }).reveal, undefined, 'applied once');
});

test('only a fresh install is welcomed, once, and a tour request reaches the panel with the next snapshot', async (t) => {
  const make = (saved: Map<string, unknown>) => {
    const controller = new LogsController({
      globalState: {
        keys: () => [...saved.keys()],
        get: (key: string, fallback?: unknown) => (saved.has(key) ? saved.get(key) : fallback),
        update: async (key: string, value: unknown) => {
          saved.set(key, value);
        },
      },
    } as unknown as import('vscode').ExtensionContext);
    t.after(() => controller.dispose());
    return controller;
  };
  const fresh = new Map<string, unknown>();
  const first = make(fresh);
  assert.equal(first.firstRun(), true);
  first.welcomed();
  assert.equal(first.firstRun(), false, 'answered once, never again');
  assert.equal(
    make(new Map<string, unknown>([['logline.guide.lastSeenVersion', '1.15.0']])).firstRun(),
    false,
    'an upgrade is not welcomed',
  );

  await first.startTour();
  assert.equal(first.snapshot({ type: 'snapshot' }).startTour, true);
  assert.equal(first.snapshot({ type: 'snapshot' }).startTour, undefined, 'applied once');
});
