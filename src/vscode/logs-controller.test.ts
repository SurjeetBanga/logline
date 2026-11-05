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

test('removing a finished run drops its logs and record, and keeps a running one', async (t) => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'db', sessionId: 'f1', message: 'one' });
  controller.store.add({ level: 'info', id: 2, serverId: 'db', sessionId: 'f2', message: 'two' });
  controller.registry.records.set('f1', {
    id: 'f1',
    serverId: 'db',
    server: 'DB',
    command: 'level:error · last 1h',
    status: 'exited',
    startedAt: 0,
    events: 1,
  } as never);
  controller.registry.records.set('f2', {
    id: 'f2',
    serverId: 'db',
    server: 'DB',
    status: 'running',
    startedAt: 0,
    events: 1,
  } as never);
  assert.equal(controller.removeRun('f2'), 0, 'a run still capturing stays');
  assert.equal(controller.removeRun('missing'), 0);
  const generation = controller.state.generation;
  assert.equal(controller.removeRun('f1'), 1);
  assert.deepEqual(
    controller.store.all().map((event) => event.id),
    [2],
  );
  assert.equal(controller.registry.records.has('f1'), false);
  assert.equal(controller.state.status, 'Removed level:error · last 1h and its 1 log');
  assert.ok(controller.state.generation > generation);
  // Every finished run of a source at once, its containers' too; the running one stays.
  for (const [id, serverId] of [
    ['g1', 'db'],
    ['g2', 'db::worker'],
    ['g3', 'dbx'],
  ]) {
    controller.store.add({
      level: 'info',
      id: controller.store.all().length + 10,
      serverId,
      sessionId: id,
      message: id,
    });
    controller.registry.records.set(id, {
      id,
      serverId,
      server: 'DB',
      status: 'exited',
      startedAt: 0,
      events: 1,
    } as never);
  }
  assert.equal(controller.removeFinishedRuns('db'), 2);
  assert.deepEqual(
    controller.store.all().map((event) => event.message),
    ['two', 'g3'],
  );
  assert.equal(controller.state.status, 'Removed 2 finished runs of DB and their 2 logs');
  assert.equal(controller.removeFinishedRuns('db'), 0, 'only a running run is left');
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
  assert.equal(
    make(
      new Map<string, unknown>([
        ['logline.usage.id', 'id'],
        ['logline.usage.state', {}],
        ['logline.rating', {}],
        ['logline.feedbackPrompt', {}],
        ['logline.update', {}],
      ]),
    ).firstRun(),
    true,
    'what Logline stores by itself on a start does not hide the welcome',
  );

  await first.startTour();
  assert.equal(first.snapshot({ type: 'snapshot' }).startTour, true);
  assert.equal(first.snapshot({ type: 'snapshot' }).startTour, undefined, 'applied once');
});

test('connecting an agent where the bridge is not running is counted as unavailable', async (t) => {
  const controller = setup(t);
  const recorded: unknown[][] = [];
  controller.usage = { record: (...args: unknown[]) => recorded.push(args) } as any;
  await controller.connectAgent('claude');
  assert.deepEqual(recorded, [['agent_setup', { agent: 'claude', outcome: 'unavailable' }]]);
});

test('sharing logs with an agent is counted with how it was shared', async (t) => {
  const controller = setup(t);
  const shares: { how: string; sources: number; events: number }[] = [];
  controller.usage = {
    enabled: true,
    shared: (how: string, sources: number, events: number) => shares.push({ how, sources, events }),
    record() {},
    capture() {},
    milestone() {},
  } as any;
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'ready' });
  await controller.shareWithAgent(['api'], undefined, ['a']);
  assert.deepEqual(shares, [{ how: 'runs', sources: 1, events: 1 }]);
});

test('a search counts once it stops changing, not once a keystroke, and the summary reads the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = setup(t);
  const searches: { operators: string[]; fields: string[] }[] = [];
  const recorded: string[] = [];
  controller.usage = {
    enabled: true,
    search: (operators: Iterable<string>, fields: Iterable<string>) =>
      searches.push({ operators: [...operators], fields: [...fields] }),
    record: (event: string) => recorded.push(event),
    capture() {},
    milestone() {},
  } as any;
  // A search the panel restores when it opens was not typed now.
  controller.snapshot({ type: 'snapshot', query: 'service:api', limit: 50 } as any);
  t.mock.timers.tick(1500);
  assert.deepEqual(searches, [], 'the restored search is not counted');
  for (const query of ['l', 'le', 'level:', 'level:er', 'level:error'])
    controller.snapshot({ type: 'snapshot', query, limit: 50 } as any);
  t.mock.timers.tick(1500);
  controller.snapshot({ type: 'snapshot', query: 'level:error', limit: 50 } as any);
  t.mock.timers.tick(1500);
  assert.deepEqual(searches, [{ operators: ['field'], fields: ['level'] }]);
  controller.snapshot({ type: 'snapshot', query: '', limit: 50 } as any);
  t.mock.timers.tick(1500);
  assert.equal(searches.length, 1, 'clearing the search is not one');
  await controller.startTour();
  assert.deepEqual(recorded, ['tour']);
  const summary = controller.usageSummary();
  assert.equal(summary.eventsCaptured(), 0);
  assert.equal(summary.sources(), 0);
  assert.equal(summary.trimmed(), false);
  assert.deepEqual(summary.connections(), {});
  assert.equal(typeof summary.memoryMb(), 'number');
});

test('each new run reports its kind of capture once, by kind only', (t) => {
  const controller = setup(t);
  const kinds: string[] = [];
  controller.usage = { capture: (kind: string) => kinds.push(kind) } as any;
  const run = (id: string, serverId: string, sourceKind?: string) =>
    controller.registry.records.set(id, { id, serverId, sourceKind, status: 'running', startedAt: 0 } as any);
  run('1', 'terminal:zsh', 'terminal');
  run('1', 'terminal:zsh', 'terminal');
  run('2', 'compose:/repo/compose.yaml', 'process');
  run('3', 'custom');
  run('4', 'otel:api', 'otel');
  run('5', 'conn:prod', 'remote');
  run('6', 'debug:1', 'debug');
  assert.deepEqual(kinds, ['terminal', 'compose', 'command', 'otlp', 'connection', 'debug']);
});

test('Ask Copilot asks later whether it helped, only once the chat opened', async (t) => {
  const controller = setup(t);
  let followUps = 0;
  controller.usage = { record() {}, askWhetherCopilotHelped: () => followUps++ } as any;
  (controller.agentAccess as any).status = () => ({ active: true, shareId: 's1', sources: [] });
  (controller as any).openChat = async () => false;
  await controller.askCopilot();
  assert.equal(followUps, 0, 'no chat, nothing to ask about');
  (controller as any).openChat = async () => true;
  await controller.askCopilot();
  assert.equal(followUps, 1);
});

test('Suggest a feature and Vote on what’s next open in the panel with the next snapshot, saying whether they can be sent', async (t) => {
  const controller = setup(t);
  controller.usage = { enabled: false, record() {} } as any;
  await controller.openFeedback('vote');
  assert.deepEqual(controller.snapshot({ type: 'snapshot', limit: 50 } as any).openFeedback, {
    mode: 'vote',
    sendable: false,
  });
  assert.equal(controller.snapshot({ type: 'snapshot', limit: 50 } as any).openFeedback, undefined, 'once');
  controller.usage = { enabled: true, record() {} } as any;
  await controller.openFeedback('suggest');
  assert.deepEqual(controller.snapshot({ type: 'snapshot', limit: 50 } as any).openFeedback, {
    mode: 'suggest',
    sendable: true,
  });
});
