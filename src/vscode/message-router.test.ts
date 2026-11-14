import assert from 'node:assert/strict';
import test from 'node:test';
import { LogStore } from '../core/log-store';
import { withVscode } from '../test/vscode-mock';

const calls: { name: string; value?: unknown }[] = [];
let trusted = true;
let commandConfig: unknown[] = [{ id: 'api', label: 'API', command: 'npm start' }];
const mockVscode = {
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => undefined }),
  },
  window: {
    showWarningMessage: (message: string) => {
      calls.push({ name: 'warning', value: message });
    },
    showInformationMessage: (message: string) => {
      calls.push({ name: 'info', value: message });
    },
    showErrorMessage: (message: string) => {
      calls.push({ name: 'error', value: message });
    },
    showQuickPick: async () => undefined,
  },
  env: {
    clipboard: {
      writeText: async (text: string) => {
        calls.push({ name: 'clipboard', value: text });
      },
    },
  },
  commands: {
    executeCommand: async (name: string, ...args: unknown[]) => {
      calls.push({ name: 'command', value: name });
      if (args.length) calls.push({ name: 'commandArgs', value: args });
    },
  },
};

const { handleMessage } = withVscode(
  mockVscode,
  () => require('./message-router') as typeof import('./message-router'),
);

function services() {
  const store = new LogStore();
  store.add({
    id: 1,
    serverId: 'api',
    sessionId: 'run',
    level: 'error',
    message: 'failed',
    raw: '{"message":"failed"}',
    isJson: true,
  });
  const saved = { savedSearches: () => [] } as any;
  const config = { get: (key: string, fallback: unknown) => (key === 'servers' ? commandConfig : fallback) } as any;
  const runner = { run: (...args: unknown[]) => calls.push({ name: 'run', value: args }) } as any;
  const transfer = {
    exportLogs: async (value: unknown) => {
      calls.push({ name: 'export', value });
    },
    exportForAI: async (value: unknown) => {
      calls.push({ name: 'exportForAI', value });
    },
    copyFiltered: async (value: unknown) => {
      calls.push({ name: 'copyFiltered', value });
    },
    exportContext: async (value: unknown) => {
      calls.push({ name: 'exportContext', value });
    },
    importLogs: async () => {
      calls.push({ name: 'import' });
    },
  } as any;
  const searches = {
    saveSearch: (...args: unknown[]) => {
      calls.push({ name: 'saveSearch', value: args });
      return { id: 'saved' };
    },
    deleteSavedSearch: (id: string) => calls.push({ name: 'deleteSavedSearch', value: id }),
    savedSearches: () => saved.savedSearches(),
  } as any;
  return {
    store,
    config,
    runner,
    transfer,
    searches,
    snapshot: (request: unknown) => ({ type: 'snapshot', request }),
    clear: () => calls.push({ name: 'clear' }),
    stop: (...args: unknown[]) => calls.push({ name: 'stop', value: args }),
    showGuide: (section: string) => calls.push({ name: 'guide', value: section }),
    agentAccess: {} as any,
    shareWithAgent: async (...args: unknown[]) => {
      calls.push({ name: 'share', value: args });
    },
    stopSharing: () => calls.push({ name: 'stopSharing' }),
    askCopilot: async (anchor?: number) => {
      calls.push({ name: 'copilot', value: anchor });
      return true;
    },
    toggleTerminalCapture: async (enabled: boolean) => {
      calls.push({ name: 'terminalCapture', value: enabled });
    },
    detailLinks: () => ({ site: 'src/app.ts:4', traceId: 'abc' }),
    openLogSite: async (id: number) => {
      calls.push({ name: 'openLogSite', value: id });
    },
    traceView: (traceId: string) => ({
      traceId,
      durationMs: 0,
      services: [],
      spans: [],
      errors: 0,
      omitted: 0,
      hotspots: [],
      logs: [],
    }),
    toggleOtlp: async (enabled: boolean) => {
      calls.push({ name: 'otlp', value: enabled });
    },
  };
}

test('message router dispatches every public action and preserves normalized inputs', async () => {
  calls.length = 0;
  const service = services();
  const sent: unknown[] = [];
  const requests: unknown[] = [
    { type: 'snapshot', page: 1 },
    { type: 'context', id: 1 },
    { type: 'openSource', id: 99, block: 0, line: 0 },
    { type: 'saveSearch', name: 'Errors', query: 'level:error', levels: ['error'], serverId: 'api' },
    { type: 'deleteSavedSearch', id: 'saved' },
    { type: 'autocomplete', input: 'sta', serverId: 'api' },
    { type: 'analysis', query: 'failed' },
    { type: 'export', query: 'failed' },
    { type: 'exportForAI' },
    { type: 'copyFiltered', serverId: 'api' },
    { type: 'exportContext', ids: [1, 99] },
    { type: 'shareWithAgent', sourceIds: ['api'], anchor: 1, sessionIds: ['run'], chooseRuns: true },
    { type: 'stopSharing' },
    { type: 'askCopilot', anchor: 1 },
    { type: 'shareEvent', id: 1 },
    { type: 'toggleTerminalCapture', enabled: true },
    { type: 'showGuide', section: 'whatsNew' },
    { type: 'import' },
    { type: 'details', id: 1, target: 'context' },
    { type: 'copy', id: 1 },
    { type: 'clear' },
    { type: 'stop', serverId: 'api', sessionId: 'run' },
    { type: 'config' },
    { type: 'manageServers' },
    { type: 'openBrowser' },
    { type: 'openLogSite', id: 1 },
    { type: 'openLogSite', id: -1 },
    { type: 'trace', traceId: 'ABC123' },
    { type: 'trace', traceId: '../etc' },
    { type: 'toggleOtlp', enabled: true },
  ];
  for (const request of requests) await handleMessage(service as any, (message) => sent.push(message), request);
  assert.ok(sent.some((message) => (message as any).type === 'snapshot'));
  assert.ok(sent.some((message) => (message as any).type === 'context' && (message as any).id === 1));
  assert.ok(
    sent.some(
      (message) =>
        (message as any).type === 'details' &&
        (message as any).target === 'context' &&
        (message as any).site === 'src/app.ts:4',
    ),
  );
  assert.deepEqual(
    calls.filter((call) => call.name === 'openLogSite').map((call) => call.value),
    [1],
  );
  assert.deepEqual(
    sent.filter((message) => (message as any).type === 'trace').map((message) => (message as any).trace.traceId),
    ['ABC123'],
  );
  assert.deepEqual(
    calls.filter((call) => call.name === 'otlp').map((call) => call.value),
    [true],
  );
  for (const name of [
    'saveSearch',
    'deleteSavedSearch',
    'export',
    'exportForAI',
    'copyFiltered',
    'exportContext',
    'share',
    'stopSharing',
    'copilot',
    'terminalCapture',
    'guide',
    'import',
    'clipboard',
    'clear',
    'stop',
    'command',
  ])
    assert.ok(
      calls.some((call) => call.name === name),
      `missing routed action ${name}`,
    );
  assert.equal((mockVscode.workspace as any).isTrusted, true);
});

test('message router enforces workspace trust for run and ignores malformed requests', async () => {
  calls.length = 0;
  const service = services();
  (mockVscode.workspace as any).isTrusted = false;
  await handleMessage(service as any, () => undefined, { type: 'run', serverId: 'api' });
  assert.ok(calls.some((call) => call.name === 'warning'));
  assert.equal(
    calls.some((call) => call.name === 'run'),
    false,
  );
  await handleMessage(service as any, () => undefined, { type: 'run', serverId: 'api', command: 'rm -rf /' });
  await handleMessage(service as any, () => undefined, { type: 'unknown' });
  assert.equal(calls.filter((call) => call.name === 'warning').length, 2);
  (mockVscode.workspace as any).isTrusted = trusted;
});

test('message router correlates snapshot failures to the requesting view', async () => {
  const service = services();
  service.snapshot = () => {
    throw new Error('snapshot unavailable');
  };
  const sent: unknown[] = [];
  await handleMessage(service as any, (message) => sent.push(message), { type: 'snapshot', requestId: 7 });
  assert.deepEqual(sent, [{ type: 'snapshotError', requestId: 7, message: 'snapshot unavailable' }]);
});

test('message router removes a source, asks before removing a connection, and opens a named setting', async () => {
  calls.length = 0;
  const service = {
    ...services(),
    removeSource: (serverId: string) => {
      calls.push({ name: 'removeSource', value: serverId });
      return Promise.resolve(3);
    },
    removeRun: (sessionId: string) => {
      calls.push({ name: 'removeRun', value: sessionId });
      return 1;
    },
    removeFinishedRuns: (serverId: string) => {
      calls.push({ name: 'removeFinishedRuns', value: serverId });
      return 2;
    },
    connectAgent: async (agent?: string) => {
      calls.push({ name: 'connectAgent', value: agent });
    },
    connections: {
      remove: async (id: string) => {
        calls.push({ name: 'removeConnection', value: id });
      },
    },
  };
  for (const request of [
    { type: 'removeSource', serverId: 'api' },
    { type: 'removeSource' },
    { type: 'removeRun', sessionId: 'run-1' },
    { type: 'removeRun' },
    { type: 'removeFinishedRuns', serverId: 'conn:dd' },
    { type: 'removeConnection', connectionId: 'prod' },
    { type: 'connectAgent', agent: 'claude' },
    { type: 'config', setting: 'logline.maxMemoryMb' },
  ])
    await handleMessage(service as any, () => undefined, request);
  assert.deepEqual(
    calls.filter((call) => call.name !== 'command').map((call) => [call.name, call.value]),
    [
      ['removeSource', 'api'],
      ['removeRun', 'run-1'],
      ['removeFinishedRuns', 'conn:dd'],
      ['removeConnection', 'prod'],
      ['connectAgent', 'claude'],
      ['commandArgs', ['logline.maxMemoryMb']],
    ],
  );
});

test('message router passes a Datadog query typed as is, and answers with the services of a connection', async () => {
  const seen: unknown[][] = [];
  const service = {
    ...services(),
    connections: {
      fetch: async (...args: unknown[]) => void seen.push(['fetch', ...args]),
      tail: async (...args: unknown[]) => void seen.push(['tail', ...args]),
      services: async (id: string, range: string) => ({ services: [{ name: `${id}-api`, count: 3 }], range }),
    },
  };
  const sent: unknown[] = [];
  for (const request of [
    { type: 'connectionFetch', connectionId: 'prod', query: 'x', range: '1h', native: 'service:a' },
    { type: 'connectionTail', connectionId: 'prod', query: 'x', enabled: true, native: 'service:a' },
    { type: 'connectionServices', connectionId: 'prod', range: '4h' },
  ])
    await handleMessage(service as any, (message) => sent.push(message), request);
  assert.deepEqual(seen, [
    ['fetch', 'prod', 'x', '1h', undefined, 'service:a'],
    ['tail', 'prod', 'x', true, 'service:a'],
  ]);
  assert.deepEqual(sent, [
    { type: 'connectionServices', connectionId: 'prod', range: '4h', services: [{ name: 'prod-api', count: 3 }] },
  ]);
});

test('message router counts views, exports for AI, finding votes, and how a tour ended', async () => {
  const service = services() as any;
  const counted: unknown[] = [];
  service.usage = {
    view: (view: string) => counted.push(['view', view]),
    record: (event: string, properties?: unknown) => counted.push([event, properties]),
    findingHelpful: (code: string, helpful: boolean) => counted.push(['vote', code, helpful]),
  };
  service.traceList = () => [];
  service.metricList = () => [];
  const send = () => undefined;
  for (const message of [
    { type: 'traces' },
    { type: 'metrics' },
    { type: 'exportForAI', query: 'level:error' },
    { type: 'doctorFeedback', code: 'noisy', helpful: true },
    { type: 'doctorFeedback', code: 'noisy' },
    { type: 'tourEnded', finished: false },
  ])
    await handleMessage(service, send, message);
  assert.deepEqual(counted, [
    ['view', 'traces'],
    ['view', 'metrics'],
    ['exported_for_ai', undefined],
    ['vote', 'noisy', true],
    ['tour', { step: 'skipped' }],
  ]);
});

test('the More actions menu suggests a feature and votes through the same commands as the Command Palette', async () => {
  calls.length = 0;
  for (const type of ['suggestFeature', 'voteOnNext'])
    await handleMessage(services() as any, () => undefined, { type });
  assert.deepEqual(
    calls.filter((call) => call.name === 'command').map((call) => call.value),
    ['logline.suggestFeature', 'logline.voteOnNext'],
  );
});

test('the feedback form’s request is sent, and its result goes back to the panel', async () => {
  const service = services() as any;
  const asked: unknown[] = [];
  service.feedback = async (request: unknown) => {
    asked.push(request);
    return { ok: true, via: 'posthog' };
  };
  const sent: unknown[] = [];
  const send = (message: unknown) => void sent.push(message);
  await handleMessage(service, send, {
    type: 'feedbackSend',
    mode: 'vote',
    picks: ['Deeper agent investigations', 42],
  });
  assert.deepEqual(asked, [{ mode: 'vote', picks: ['Deeper agent investigations'], github: false }]);
  assert.deepEqual(sent, [{ type: 'feedbackResult', ok: true, via: 'posthog' }]);
  await handleMessage(service, send, { type: 'feedbackSend', mode: 'suggest', text: '' });
  await handleMessage(service, send, { type: 'feedbackSend', mode: 'other' });
  assert.equal(asked.length, 1, 'malformed requests are ignored');
});

test('what someone does in the panel is counted by name, and a welcome choice and panel width reach usage counts', async () => {
  const actions: string[] = [];
  const recorded: unknown[][] = [];
  const widths: number[] = [];
  const usage = {
    view() {},
    findingHelpful() {},
    record: (...args: unknown[]) => recorded.push(args),
    panelAction: (action: string) => actions.push(action),
    panelSize: (width: number) => widths.push(width),
  };
  const base = services() as any;
  const target = { ...(base.services ?? base), usage };
  await handleMessage(target, () => {}, { type: 'details', id: 1 });
  await handleMessage(target, () => {}, { type: 'copy', id: 1 });
  await handleMessage(target, () => {}, { type: 'autocomplete', input: 'le' });
  await handleMessage(target, () => {}, { type: 'onboardingSeen', choice: 'capture' });
  await handleMessage(target, () => {}, { type: 'panelSize', width: 640 });
  assert.deepEqual(actions, ['inspect_event', 'copy_event'], 'typing in the search box is not an action');
  assert.deepEqual(recorded, [['welcome', { choice: 'capture' }]]);
  assert.deepEqual(widths, [640]);
});

test('the Update button reaches the update check', async () => {
  let pressed = 0;
  const base = services() as any;
  const target = { ...(base.services ?? base), installUpdate: async () => void pressed++ };
  await handleMessage(target, () => {}, { type: 'installUpdate' });
  assert.equal(pressed, 1);
});
