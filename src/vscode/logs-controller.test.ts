import assert from 'node:assert/strict';
import test from 'node:test';
import { spanLine } from '../core/otlp';
import { withVscode } from '../test/vscode-mock';

const notices: string[] = [];
let buttons: string[] = [];
const settings: { key: string; value: unknown; target?: unknown }[] = [];
const commands: string[] = [];
const commandArgs: unknown[][] = [];
const copied: string[] = [];
let pick: (items: { runId: string }[]) => unknown = () => undefined;
const terminals: { options: unknown; shown: boolean; sent: unknown[][] }[] = [];
const opened: unknown[] = [];
const mock = {
  Uri: { file: (path: string) => ({ fsPath: path }) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  commands: {
    executeCommand: async (id: string, ...args: unknown[]) => {
      commands.push(id);
      commandArgs.push(args);
    },
  },
  extensions: { getExtension: () => undefined },
  env: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
  workspace: {
    get workspaceFolders() {
      return host.folders;
    },
    onDidChangeConfiguration: (listener: typeof host.configChanged) => {
      host.configChanged = listener;
      return { dispose() {} };
    },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (host.values.has(key) ? host.values.get(key) : fallback),
      update: async (key: string, value: unknown, target?: unknown) => {
        if (host.readOnly) throw new Error('Unable to write to Workspace Settings');
        // A workspace's own value outlasts what is saved for every workspace.
        if (target !== 1 || !host.workspaceValues.has(key)) host.values.set(key, value);
        if (target !== 1) host.workspaceValues.add(key);
        settings.push(target === 1 ? { key, value, target: 'global' } : { key, value });
      },
    }),
  },
  window: {
    createTerminal: (options: unknown) => {
      const terminal = {
        options,
        shown: false,
        sent: [] as unknown[][],
        show() {
          terminal.shown = true;
        },
        sendText: (...args: unknown[]) => void terminal.sent.push(args),
      };
      terminals.push(terminal);
      return terminal;
    },
    showTextDocument: async (...args: unknown[]) => void opened.push(args),
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
const host = {
  folders: undefined as unknown[] | undefined,
  readOnly: false,
  values: new Map<string, unknown>(),
  workspaceValues: new Set<string>(),
  configChanged: undefined as ((event: { affectsConfiguration(key: string): boolean }) => void) | undefined,
};
const { LogsController, agentCallQuery } = withVscode(
  mock,
  () => require('./logs-controller') as typeof import('./logs-controller'),
);

function setup(t: { after(fn: () => Promise<void>): void }) {
  notices.length = 0;
  copied.length = 0;
  settings.length = 0;
  host.values.clear();
  host.workspaceValues.clear();
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

const spanOf = (spanId: string, extra: Record<string, unknown> = {}) => ({
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId,
  name: `op ${spanId}`,
  kind: 2,
  startMs: 1000,
  endMs: 1050,
  service: 'api',
  events: [],
  status: { code: 0 },
  attributes: {},
  ...extra,
});

test('the trace list is answered from the last answer until a span or a log arrives', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const first = controller.traceList();
  assert.equal(controller.traceList(), first, 'nothing new, the same list');
  controller.spans.add(spanOf('1111111111111111'));
  const withSpan = controller.traceList();
  assert.notEqual(withSpan, first);
  assert.deepEqual(
    withSpan.map((trace) => [trace.traceId, trace.spans]),
    [[traceId, 1]],
  );
  assert.equal(controller.traceList(), withSpan);
  controller.ingestion.accept(`{"msg":"handled","trace_id":"${traceId}"}`, 'stdout', {
    serverId: 'web',
    server: 'web',
    sessionId: 'r',
  });
  const withLog = controller.traceList();
  assert.notEqual(withLog, withSpan, 'a log is new too');
  assert.equal(withLog[0].logs, 1);
  controller.clear();
  assert.deepEqual(controller.traceList(), [], 'clearing makes a new list');
});

test('span rows shown in Logs do not use up the logs a trace or the trace list reads', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const logOnly = '00000000000000000000000000000abc';
  const accept = (line: string) =>
    controller.ingestion.accept(line, 'stdout', { serverId: 'web', server: 'web', sessionId: 'r' });
  for (let index = 0; index < 5; index++) accept(`{"msg":"log ${index}","trace_id":"${traceId}"}`);
  accept(`{"msg":"alone","trace_id":"${logOnly}"}`);
  // Newer than every log, and more of them than either read takes.
  for (let index = 0; index < 1100; index++) {
    const spanId = index.toString(16).padStart(16, '0');
    const span = spanOf(spanId);
    accept(spanLine(span));
    if (index < 3) controller.spans.add(span);
  }
  const view = controller.traceView(traceId);
  assert.deepEqual(
    view.logs.map((log) => log.message),
    ['log 0', 'log 1', 'log 2', 'log 3', 'log 4'],
    'every log is read, and no span row stands in for one',
  );
  assert.equal(view.logsLimited, undefined);
  assert.ok(
    controller.traceList().some((trace) => trace.traceId === logOnly),
    'a trace known from its logs is still listed',
  );
  assert.equal(controller.traceList().find((trace) => trace.traceId === traceId)?.logs, 5);
});

test('the trace list reads traces from more than a thousand logs, and counts those past the newest 200', async (t) => {
  const controller = setup(t);
  // Oldest first: the first trace is known only from a log 1,500 lines back.
  for (let index = 0; index < 1500; index++)
    controller.ingestion.accept(
      `{"msg":"log ${index}","trace_id":"${index.toString(16).padStart(32, '0')}"}`,
      'stdout',
      { serverId: 'web', server: 'web', sessionId: 'r' },
    );
  assert.equal(controller.traceList().length, 200, 'the list holds the newest');
  assert.equal(controller.traceTotal(), 1500, 'and every trace is counted, the oldest log included');
});

test('a trace with no retained spans still shows its span rows', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  controller.ingestion.accept(spanLine(spanOf('1111111111111111')), 'stdout', {
    serverId: 'web',
    server: 'web',
    sessionId: 'r',
  });
  assert.equal(controller.traceView(traceId).logs.length, 1);
});

test('a trace says when it has more logs than the 500 it reads', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const accept = (index: number) =>
    controller.ingestion.accept(`{"msg":"log ${index}","trace_id":"${traceId}"}`, 'stdout', {
      serverId: 'web',
      server: 'web',
      sessionId: 'r',
    });
  for (let index = 0; index < 500; index++) accept(index);
  assert.equal(controller.traceView(traceId).logsLimited, undefined, 'exactly 500 is not cut');
  accept(500);
  const view = controller.traceView(traceId);
  assert.equal(view.logs.length, 500);
  assert.equal(view.logsLimited, true);
  assert.equal(view.logs.at(-1)?.message, 'log 500', 'the newest are kept');
});

test('a span is read in full by either case of its ids, and copied as an id or as redacted JSON', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  // Built at runtime: secret-shaped literals are refused by push protection.
  const token = ['Bearer', 'x'.repeat(24)].join(' ');
  controller.spans.add(
    spanOf('aaaaaaaaaaaaaaaa', { attributes: { 'http.route': '/x', authorization: token }, scope: 'lib' }),
  );
  const detail = controller.spanDetail(traceId.toUpperCase(), 'AAAAAAAAAAAAAAAA')!;
  assert.deepEqual([detail.name, detail.scope, detail.attributes['http.route']], ['op aaaaaaaaaaaaaaaa', 'lib', '/x']);
  assert.equal(controller.spanDetail(traceId, 'bbbbbbbbbbbbbbbb'), undefined);

  await controller.copySpan(traceId.toUpperCase());
  await controller.copySpan(traceId, 'AAAAAAAAAAAAAAAA');
  assert.deepEqual(copied, [traceId, 'aaaaaaaaaaaaaaaa']);
  assert.deepEqual(notices, ['Copied the trace id.', 'Copied the span id.']);

  await controller.copySpan(traceId, 'aaaaaaaaaaaaaaaa', true);
  const json = JSON.parse(copied.at(-1)!);
  assert.equal(json.spanId, 'aaaaaaaaaaaaaaaa');
  assert.equal(json.attributes['http.route'], '/x');
  assert.doesNotMatch(copied.at(-1)!, /x{24}/, 'the secret is redacted like an export');
  assert.equal(notices.at(-1), 'Copied the span as JSON.');

  const before = copied.length;
  await controller.copySpan(traceId, 'bbbbbbbbbbbbbbbb', true);
  assert.equal(copied.length, before, 'a span that is gone copies nothing');
  assert.equal(notices.at(-1), 'That span is no longer retained.');
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

test('removing a browser that is closing takes its run at once, while a process shutting down keeps its own', async (t) => {
  const controller = setup(t);
  const closing = (id: string, serverId: string, sourceKind: 'browser' | 'process') => {
    controller.registry.records.set(id, {
      id,
      serverId,
      server: serverId,
      status: 'stopping',
      startedAt: 1,
      events: 1,
      sourceKind,
    });
    controller.ingestion.accept('{"message":"last words"}', 'stdout', { serverId, server: serverId, sessionId: id });
  };
  // Stop has been pressed on both; neither process has gone yet.
  closing('browser-1', 'browser:localhost:5173', 'browser');
  closing('api-1', 'api', 'process');
  assert.equal(await controller.removeSource('browser:localhost:5173'), 1);
  assert.equal(controller.registry.records.has('browser-1'), false, 'gone with one press');
  assert.equal(await controller.removeSource('api'), 1);
  assert.equal(controller.registry.records.has('api-1'), true, 'it may still log as it shuts down');
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

test('About Logline opens in the panel with the next snapshot, once', async (t) => {
  const controller = setup(t);
  const info = { version: '1.20.0', editor: 'Visual Studio Code 1.99.0', system: 'Darwin arm64 25.0.0' };
  await controller.openAbout(info);
  assert.deepEqual(controller.snapshot({ type: 'snapshot', limit: 50 } as any).openAbout, info);
  assert.equal(
    controller.snapshot({ type: 'snapshot', limit: 50 } as any).openAbout,
    undefined,
    'a later snapshot does not open it again',
  );
});

test('the newest local address a run printed is found for the browser, and each run start is heard', (t) => {
  const controller = setup(t);
  const started: string[] = [];
  controller.runStarted = (record) => started.push(record.id);
  const say = (line: string, serverId: string, sessionId: string) =>
    controller.ingestion.accept(line, 'stdout', { serverId, server: serverId, sessionId });
  assert.equal(controller.recentLocalUrl(), undefined);
  const run = (id: string, serverId: string, sourceKind: 'browser' | 'remote') =>
    controller.registry.records.set(id, {
      id,
      serverId,
      server: serverId,
      status: 'running',
      startedAt: 1,
      events: 0,
      sourceKind,
    });
  run('browser-1', 'browser:localhost:9999', 'browser');
  run('conn-1', 'conn:prod', 'remote');
  say('  ➜  Local:   http://localhost:5173/', 'web', 'web-1');
  say('listening on http://0.0.0.0:8000 and http://127.0.0.1:8001', 'api', 'api-1');
  say('{"message":"GET http://localhost:9999/ 200","kind":"request"}', 'browser:localhost:9999', 'browser-1');
  say('fetched http://localhost:7777', 'conn:prod', 'conn-1');
  assert.equal(
    controller.recentLocalUrl(),
    'http://127.0.0.1:8001',
    'the newest, and not a browser’s or a connection’s',
  );
  assert.equal(controller.recentLocalUrl('web-1'), 'http://localhost:5173/');
  assert.equal(controller.recentLocalUrl('none'), undefined);
  controller.registry.records.set('web-1', {
    id: 'web-1',
    serverId: 'web',
    server: 'web',
    status: 'running',
    startedAt: 1,
    events: 1,
  });
  assert.deepEqual(started, ['browser-1', 'conn-1', 'web-1']);
  // The look is bounded: an address further back than it reaches is not found, and nothing reads the whole store.
  for (let line = 0; line < 600; line++) say(`request ${line} handled`, 'api', 'api-1');
  assert.equal(controller.recentLocalUrl(), undefined);
  // Stopping reaches the browser too; with none open it does nothing.
  controller.stop('browser:localhost:9999');
  controller.stop();
  assert.equal(controller.browser.active, undefined);
});

test('the empty panel’s buttons capture terminals, open a log file, and start the agent setup', async (t) => {
  const controller = setup(t);
  const entries: unknown[] = [];
  controller.usage = {
    record: (event: string, properties: unknown) => entries.push([event, properties]),
    panelAction() {},
    shared() {},
    sharingStopped() {},
    touch() {},
  } as unknown as typeof controller.usage;
  commands.length = 0;
  await controller.handleMessage(() => {}, { type: 'emptyAction', action: 'capture' });
  assert.deepEqual(settings, [{ key: 'captureTerminals', value: true }]);
  assert.equal(controller.terminalCapture.isEnabled, true);
  await controller.handleMessage(() => {}, { type: 'emptyAction', action: 'openFile' });
  assert.ok(commands.includes('logline.followFile'));
  await controller.handleMessage(() => {}, { type: 'emptyAction', action: 'browser' });
  await controller.handleMessage(() => {}, { type: 'openBrowser' });
  assert.equal(commands.filter((command) => command === 'logline.openBrowser').length, 2);
  // No agent is found here and the share warning is refused, so the setup stops after capture.
  warningAnswer = undefined;
  await controller.handleMessage(() => {}, { type: 'emptyAction', action: 'agent' });
  assert.equal(controller.agentAccess.status().active, false);
  assert.equal(entries.filter(([event]: any) => event === 'entry').length, 4);
  assert.deepEqual(entries[0], ['entry', { from: 'empty_state' }]);
  // Capture Everywhere saves the setting for every workspace.
  settings.length = 0;
  await controller.toggleTerminalCapture(true, true);
  assert.deepEqual(settings, [{ key: 'captureTerminals', value: true, target: 'global' }]);
});

test('a window with no folder open captures for itself, shows it, and keeps it until the setting agrees', async (t) => {
  const controller = setup(t);
  host.readOnly = true;
  t.after(async () => void Object.assign(host, { readOnly: false, folders: undefined }));
  const changed = () => host.configChanged!({ affectsConfiguration: () => true });
  const captureShown = () => controller.snapshot({ type: 'snapshot' } as never).captureTerminals;
  assert.equal(await controller.toggleTerminalCapture(true), false, 'nothing was saved');
  assert.equal(controller.terminalCapture.isEnabled, true);
  assert.equal(captureShown(), true, 'the panel shows what the window does, not the setting');
  // Another setting changing, with this one still off, does not switch the window's capture off.
  changed();
  assert.equal(controller.terminalCapture.isEnabled, true);
  // Off is what the setting says, so there is nothing to save and the window follows the setting again.
  assert.equal(await controller.toggleTerminalCapture(false), true);
  assert.equal(captureShown(), false, 'and it can be turned off again');
  host.values.set('captureTerminals', true);
  changed();
  assert.equal(
    controller.terminalCapture.isEnabled,
    true,
    'capture turned on everywhere, in another window, reaches it',
  );
  // Turned off against the setting, it stays off until the setting agrees, and follows it from then on.
  assert.equal(await controller.toggleTerminalCapture(false), false);
  changed();
  assert.equal(controller.terminalCapture.isEnabled, false);
  host.values.set('captureTerminals', false);
  changed();
  host.values.set('captureTerminals', true);
  changed();
  assert.equal(controller.terminalCapture.isEnabled, true);
});

test('settings that cannot be written fail a toggle, but not the agent setup, which says so', async (t) => {
  const controller = setup(t);
  Object.assign(host, { readOnly: true, folders: [{}] });
  t.after(async () => void Object.assign(host, { readOnly: false, folders: undefined }));
  await assert.rejects(controller.toggleTerminalCapture(true), /Unable to write/);
  assert.equal(controller.terminalCapture.isEnabled, false);
  warningAnswer = undefined;
  await controller.setUpForAgent(undefined);
  assert.equal(controller.terminalCapture.isEnabled, true);
  assert.ok(
    notices.some((notice) => /on for this window only: the setting could not be saved \(Unable to write/.test(notice)),
    'the window-only capture is said',
  );
  assert.match(notices.at(-1)!, /Share logs with agent\?/, 'the setup went on to ask about sharing');
  // The setting already says off, so the toggle turns this window's capture off without a write.
  assert.equal(await controller.toggleTerminalCapture(false), true);
  assert.equal(controller.terminalCapture.isEnabled, false);
});

test('capture chosen for every workspace holds in a workspace whose own setting says off', async (t) => {
  const controller = setup(t);
  host.folders = [{}];
  t.after(async () => void Object.assign(host, { folders: undefined }));
  await controller.toggleTerminalCapture(false);
  host.values.set('captureTerminals', false);
  host.workspaceValues.add('captureTerminals');
  assert.equal(await controller.toggleTerminalCapture(true, true), true);
  assert.equal(controller.terminalCapture.isEnabled, true);
  host.configChanged!({ affectsConfiguration: () => true });
  assert.equal(controller.terminalCapture.isEnabled, true, 'the window keeps the yes it was given');
});

test('an agent call is searched around by every source but the agents, a second either side', () => {
  const start = Date.parse('2026-11-15T10:00:00.000Z');
  assert.equal(
    agentCallQuery({ level: 'info', id: 1, message: 'm', timestampMs: start, fields: { durationMs: 2000 } }),
    '-kind:agent @timestamp:[2026-11-15T09:59:59.000Z TO 2026-11-15T10:00:03.000Z]',
  );
  assert.equal(
    agentCallQuery({ level: 'info', id: 1, message: 'm', timestampMs: start }),
    '-kind:agent @timestamp:[2026-11-15T09:59:59.000Z TO 2026-11-15T10:00:01.000Z]',
  );
  assert.equal(agentCallQuery({ level: 'info', id: 1, message: 'm' }), undefined);
});

test('an agent call opens the logs around it, the transcript, or its command in a terminal', async (t) => {
  const controller = setup(t);
  terminals.length = 0;
  opened.length = 0;
  const shown: unknown[][] = [];
  controller.showSource = async (...args: unknown[]) => void shown.push(args);
  const start = Date.parse('2026-11-15T10:00:00.000Z');
  controller.registry.records.set('s1', { id: 's1', serverId: 'agent:claude-code', cwd: '/work/shop' } as never);
  controller.store.add({
    level: 'info',
    id: 1,
    serverId: 'agent:claude-code',
    sessionId: 's1',
    message: 'Bash',
    timestampMs: start,
    fields: { kind: 'agent', action: 'tool', command: 'npm test', durationMs: 1000 },
  });
  controller.store.add({ level: 'info', id: 2, serverId: 'api', message: 'not an agent' });
  controller.store.add({
    level: 'info',
    id: 3,
    serverId: 'agent:claude-code',
    sessionId: 's1',
    message: 'no time',
    fields: { kind: 'agent', action: 'tool' },
  });

  await controller.agentCall(1, 'logs');
  assert.deepEqual(shown, [
    ['', undefined, '-kind:agent @timestamp:[2026-11-15T09:59:59.000Z TO 2026-11-15T10:00:02.000Z]'],
  ]);

  await controller.agentCall(1, 'terminal');
  assert.equal(terminals.length, 1);
  assert.deepEqual(terminals[0].options, { name: 'Agent command', cwd: '/work/shop' });
  assert.equal(terminals[0].shown, true);
  assert.deepEqual(terminals[0].sent, [['npm test', false]]);

  await controller.agentCall(1, 'transcript');
  assert.equal(opened.length, 0, 'no followed transcript, nothing opened');
  assert.match(notices.at(-1)!, /transcript is no longer being read/);

  await controller.agentCall(3, 'logs');
  assert.match(notices.at(-1)!, /no time/);
  await controller.agentCall(3, 'terminal');
  assert.equal(terminals.length, 1, 'no command, no terminal');

  await controller.agentCall(2, 'logs');
  assert.match(notices.at(-1)!, /no longer available/);
  await controller.agentCall(99, 'terminal');
  assert.match(notices.at(-1)!, /no longer available/);

  (controller.agentSessions as { transcriptOf: (id: string) => string | undefined }).transcriptOf = () => '/x/s.jsonl';
  await controller.agentCall(1, 'transcript');
  assert.deepEqual(opened, [[{ fsPath: '/x/s.jsonl' }, { preview: true }]]);
});

test('an agent offered in the rail can be shown, or dismissed in this folder only', async (t) => {
  const saved = new Map<string, unknown>();
  const controller = new LogsController({
    globalState: {
      get: (key: string, fallback?: unknown) => (saved.has(key) ? saved.get(key) : fallback),
      update: async (key: string, value: unknown) => void saved.set(key, value),
    },
  } as unknown as import('vscode').ExtensionContext);
  t.after(() => {
    host.folders = undefined;
    return controller.dispose();
  });
  const hints = [
    { agent: 'claude-code' as const, label: 'Claude Code', sessions: 3 },
    { agent: 'codex' as const, label: 'Codex', sessions: 1 },
  ];
  Object.defineProperty(controller.agentSessions, 'hints', { get: () => hints });
  host.folders = [{ uri: { fsPath: '/work/shop' } }];
  assert.deepEqual(controller.snapshot({ type: 'snapshot' }).agentHints, hints);

  commands.length = 0;
  await controller.agentHint('show', 'claude-code');
  assert.deepEqual(commands, ['logline.showAgentSessions'], 'Show asks first, as the command does');
  assert.deepEqual(commandArgs.at(-1), [['Claude Code', 'Codex']], 'naming the agents on offer');

  await controller.agentHint('dismiss', 'claude-code');
  assert.deepEqual(
    controller.snapshot({ type: 'snapshot' }).agentHints?.map((hint) => hint.agent),
    ['codex'],
    'only the agent dismissed goes',
  );
  host.folders = [{ uri: { fsPath: '/work/other' } }];
  assert.equal(controller.snapshot({ type: 'snapshot' }).agentHints?.length, 2, 'another folder still offers it');
});

test('a removed agent is offered again, even where dismissed, and Show restores it without asking', async (t) => {
  const saved = new Map<string, unknown>([['logline.agentHints.dismissed', ['claude-code /work/shop']]]);
  const controller = new LogsController({
    globalState: {
      get: (key: string, fallback?: unknown) => (saved.has(key) ? saved.get(key) : fallback),
      update: async (key: string, value: unknown) => void saved.set(key, value),
    },
  } as unknown as import('vscode').ExtensionContext);
  t.after(() => {
    host.folders = undefined;
    return controller.dispose();
  });
  host.folders = [{ uri: { fsPath: '/work/shop' } }];
  const sessions = controller.agentSessions;
  const restored: unknown[] = [];
  Object.defineProperty(sessions, 'enabled', { get: () => true });
  Object.defineProperty(sessions, 'removedAgents', { get: () => ['claude-code'] });
  Object.defineProperty(sessions, 'hints', {
    get: () => [{ agent: 'claude-code' as const, label: 'Claude Code', sessions: 1 }],
  });
  sessions.restore = (agent?: 'claude-code' | 'codex') => (restored.push(agent), true);
  assert.equal(controller.snapshot({ type: 'snapshot' }).agentSessionsOffer, true, 'Add logs offers it');
  assert.equal(controller.snapshot({ type: 'snapshot' }).agentHints, undefined, 'dismissed before');

  controller.stop('agent:claude-code');
  assert.deepEqual(saved.get('logline.agentHints.dismissed'), [], 'removing it lifts the dismissal');
  assert.equal(controller.snapshot({ type: 'snapshot' }).agentHints?.length, 1);

  commands.length = 0;
  await controller.agentHint('show', 'claude-code');
  assert.deepEqual(restored, ['claude-code']);
  assert.ok(!commands.includes('logline.showAgentSessions'), 'no dialog: sessions are already on');
});
