import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';
import { USAGE_EVENTS, type UsageEnvironment } from '../core/usage-events';

const host = {
  usageEnabled: true,
  errorsEnabled: true,
  settings: new Map<string, unknown>(),
  messages: [] as string[],
  answer: undefined as string | undefined,
  opened: [] as string[],
  lines: [] as string[],
  configListener: undefined as ((event: { affectsConfiguration(key: string): boolean }) => void) | undefined,
  stateListener: undefined as (() => void) | undefined,
};
const mock = {
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ConfigurationTarget: { Global: 1 },
  UIKind: { Desktop: 1, Web: 2 },
  version: '1.105.1',
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  env: {
    appName: 'Visual Studio Code',
    uiKind: 1,
    openExternal: async (uri: { toString(): string }) => void host.opened.push(uri.toString()),
    createTelemetryLogger(
      sender: { sendEventData(name: string, data?: Record<string, unknown>): void },
      options: { ignoreBuiltInCommonProperties?: boolean },
    ) {
      assert.equal(options.ignoreBuiltInCommonProperties, true, 'no machine or session ids from VS Code');
      return {
        get isUsageEnabled() {
          return host.usageEnabled;
        },
        get isErrorsEnabled() {
          return host.errorsEnabled;
        },
        logUsage: (name: string, data: Record<string, unknown>) => {
          if (host.usageEnabled) sender.sendEventData(`surjeetbanga.logline/${name}`, data);
        },
        logError: (name: string, data: Record<string, unknown>) => {
          if (host.errorsEnabled) sender.sendEventData(`surjeetbanga.logline/${name}`, data);
        },
        onDidChangeEnableStates: (listener: () => void) => {
          host.stateListener = listener;
          return { dispose() {} };
        },
        dispose() {},
      };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (host.settings.has(key) ? host.settings.get(key) : fallback),
      update: async (key: string, value: unknown) => void host.settings.set(key, value),
    }),
    onDidChangeConfiguration: (listener: typeof host.configListener) => {
      host.configListener = listener;
      return { dispose() {} };
    },
  },
  window: {
    showInformationMessage: async (message: string) => {
      host.messages.push(message);
      return host.answer;
    },
    createOutputChannel: () => ({
      appendLine: (line: string) => void host.lines.push(line),
      clear: () => void (host.lines.length = 0),
      show() {},
      dispose() {},
    }),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
const { Usage, counted, usageVocabulary, usageEnvironment, HELPFUL_DELAY_MS } = withVscode(
  mock,
  () => require('./usage') as typeof import('./usage'),
);

const environment: UsageEnvironment = {
  version: '1.19.0',
  vscode: '1.105.1',
  appName: 'Visual Studio Code',
  uiKind: 'desktop',
  platform: 'linux',
  arch: 'x64',
  cpus: 8,
  totalMemory: 16 * 1024 ** 3,
};
const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as unknown;
const vocabulary = usageVocabulary(manifest, ['capture', 'search']);

function memento(initial: Record<string, unknown> = {}) {
  const stored = new Map<string, unknown>(Object.entries(initial));
  return {
    stored,
    get: <T>(key: string, fallback?: T) => (stored.has(key) ? (stored.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void stored.set(key, value),
    keys: () => [...stored.keys()],
  };
}

function setup(
  options: {
    mode?: number;
    env?: NodeJS.ProcessEnv;
    state?: ReturnType<typeof memento>;
    key?: string;
    /** Whether PostHog accepts what is sent. */
    accepted?: boolean;
    /** The extension's storage folder, shared by windows of one install. */
    storage?: string;
  } = {},
) {
  Object.assign(host, { usageEnabled: true, errorsEnabled: true, answer: undefined, messages: [], opened: [] });
  host.settings.clear();
  const sent: { event: string; distinct_id: string; properties: Record<string, unknown> }[] = [];
  const bodies: string[] = [];
  let now = Date.UTC(2026, 10, 2, 9, 0, 0);
  const globalState = options.state ?? memento();
  const globalStorageUri = options.storage ? { fsPath: options.storage } : undefined;
  const usage = new Usage({ globalState, extensionMode: options.mode ?? 1, globalStorageUri } as any, {
    vocabulary,
    environment,
    env: options.env ?? {},
    projectKey: options.key ?? 'test-project',
    now: () => now,
    transport: async (body) => {
      bodies.push(body);
      if (options.accepted === false) return false;
      const parsed = JSON.parse(body) as { batch: typeof sent };
      sent.push(...parsed.batch);
      return true;
    },
  });
  return {
    usage,
    sent,
    bodies,
    globalState,
    advance: (ms: number) => (now += ms),
    events: () => sent.map((item) => item.event),
  };
}

test('a batch PostHog does not accept is sent once more, ahead of newer events, then dropped', async () => {
  const options = { accepted: false };
  const { usage, bodies, events } = setup(options);
  usage.start();
  assert.equal(await usage.flush(), false);
  usage.command('logline.showLogs');
  options.accepted = true;
  assert.equal(await usage.flush(), true);
  assert.deepEqual(events(), ['installed', 'activated', 'active_day', 'command']);

  const failing = setup({ accepted: false });
  failing.usage.start();
  await failing.usage.flush();
  await failing.usage.flush();
  const tries = failing.bodies.length;
  await failing.usage.flush();
  assert.equal(tries, 2);
  assert.equal(failing.bodies.length, 2, 'nothing is left to try a third time');
  assert.equal(bodies.length, 2);
  usage.dispose();
  failing.usage.dispose();
});

test('Show Usage Data lists only what PostHog accepted', async () => {
  const options = { accepted: false };
  const { usage } = setup(options);
  usage.start();
  usage.showData();
  host.lines.length = 0;
  await usage.flush();
  await usage.flush();
  assert.doesNotMatch(host.lines.join('\n'), /activated/, 'events dropped after two tries were never sent');
  usage.command('logline.showLogs');
  options.accepted = true;
  await usage.flush();
  assert.match(host.lines.join('\n'), /command/);
  usage.dispose();
});

test('a batch that fails while the id is reset is dropped, never sent under the new id', async () => {
  let fail!: () => void;
  const bodies: string[] = [];
  const { usage } = setup();
  (usage as any).transport = (body: string) => {
    bodies.push(body);
    return bodies.length === 1
      ? new Promise<boolean>((resolve) => (fail = () => resolve(false)))
      : Promise.resolve(true);
  };
  usage.start();
  const before = usage.usageId;
  const flushing = usage.flush();
  await usage.resetId();
  fail();
  assert.equal(await flushing, false);
  usage.command('logline.showLogs');
  await usage.flush();
  const later = (JSON.parse(bodies[1]) as { batch: { event: string; distinct_id: string }[] }).batch;
  const events = later.map((item) => item.event);
  assert.ok(events.includes('command'));
  assert.ok(!events.includes('installed') && !events.includes('activated'), 'the old events were not put back');
  assert.ok(later.every((item) => item.distinct_id === usage.usageId && item.distinct_id !== before));
  usage.dispose();
});

test('a new install sends installed, then batches with only coarse common properties, without a pop-up', async () => {
  const { usage, sent, bodies, events, globalState } = setup();
  usage.start();
  assert.equal(host.messages.length, 0, 'it follows the telemetry setting without asking again');
  usage.command('logline.showLogs');
  await usage.flush();
  assert.deepEqual(events(), ['installed', 'activated', 'active_day', 'command']);
  const id = sent[0].distinct_id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(sent.every((item) => item.distinct_id === id));
  assert.deepEqual(sent[3].properties, {
    version: '1.19.0',
    vscode: '1.105.1',
    host: 'vscode',
    ui: 'desktop',
    remote: 'none',
    os: 'linux',
    arch: 'x64',
    cpus: '5-8',
    ram_gb: '16-31',
    id: 'logline.showLogs',
    $process_person_profile: false,
    $geoip_disable: true,
  });
  assert.equal(JSON.parse(bodies[0]).api_key, 'test-project');
  assert.doesNotMatch(bodies.join(''), /machineid|sessionid/i);
  usage.dispose();

  // The next window keeps the id.
  const next = setup({ state: globalState });
  next.usage.start();
  await next.usage.flush();
  assert.deepEqual(next.events(), ['activated']);
  assert.equal(next.sent[0].distinct_id, id);
  assert.equal(host.messages.length, 0);
  next.usage.dispose();
});

test('answers that PostHog does not accept are reported, so the person can send them another way', async () => {
  const { usage } = setup({ accepted: false });
  usage.start();
  assert.equal(await usage.survey('survey-1', { q1: 'Search' }), false);
  usage.dispose();
  const accepted = setup();
  accepted.usage.start();
  assert.equal(await accepted.usage.survey('survey-1', { q1: 'Search' }), true);
  accepted.usage.dispose();
});

test('nothing is recorded when VS Code telemetry, Logline’s setting, or DO_NOT_TRACK says no', async () => {
  for (const turnOff of [() => (host.usageEnabled = false), () => host.settings.set('telemetry.enabled', false)]) {
    const { usage, sent } = setup();
    turnOff();
    usage.start();
    usage.command('logline.showLogs');
    await usage.flush();
    assert.deepEqual(sent, []);
    usage.dispose();
  }
  const { usage, sent } = setup({ env: { DO_NOT_TRACK: '1' } });
  usage.start();
  await usage.flush();
  assert.deepEqual(sent, []);
  usage.dispose();
});

test('errors follow the error level; usage counts need all', async () => {
  const { usage, events } = setup();
  usage.start();
  host.usageEnabled = true;
  host.errorsEnabled = false;
  usage.record('error', { area: 'bridge', code: 'start_failed' });
  host.errorsEnabled = true;
  usage.record('error', { area: 'bridge', code: 'start_failed', message: 'EADDRINUSE 127.0.0.1:4318' });
  await usage.flush();
  assert.deepEqual(events(), ['installed', 'activated', 'error']);
  usage.dispose();
});

test('turning usage counts off drops what is queued', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.command('logline.showLogs');
  host.settings.set('telemetry.enabled', false);
  host.configListener?.({ affectsConfiguration: (key) => key === 'logline.telemetry.enabled' });
  host.settings.delete('telemetry.enabled');
  await usage.flush();
  assert.deepEqual(sent, []);
  usage.command('logline.showLogs');
  host.usageEnabled = false;
  host.stateListener?.();
  host.usageEnabled = true;
  await usage.flush();
  assert.deepEqual(sent, [], 'and so does VS Code turning telemetry off');
  usage.dispose();
});

test('development hosts and builds without a project key list events but never send them', async () => {
  for (const options of [{ mode: 2 }, { key: '' }, { env: { LOGLINE_USAGE_DEBUG: '1' } }]) {
    const { usage, sent } = setup(options);
    usage.start();
    await usage.flush();
    assert.deepEqual(sent, []);
    usage.showData();
    assert.match(host.lines.join('\n'), /activated/);
    assert.match(host.lines[0], /not sent from this build|usage counts on/);
    usage.dispose();
  }
});

test('someone who used Logline before is not a new install, and an upgrade says where from', async () => {
  const state = memento({ 'logline.rating': { sessions: 4 } });
  const first = setup({ state });
  first.usage.start();
  first.usage.capture('terminal');
  first.usage.search(['field'], ['level']);
  await first.usage.flush();
  assert.deepEqual(first.events(), ['activated', 'capture_started', 'active_day'], 'no install, and no firsts');
  first.usage.dispose();

  await state.update('logline.usage.state', { ...(state.get('logline.usage.state') as object), version: '1.18.0' });
  const second = setup({ state });
  second.usage.start();
  await second.usage.flush();
  assert.deepEqual(second.events(), ['updated', 'activated']);
  assert.equal(second.sent[0].properties.from, '1.18.0');
  second.usage.dispose();
});

test('firsts are sent once with how long after installing; active days once a day', async () => {
  const { usage, sent, events, advance, globalState } = setup();
  usage.start();
  advance(3 * 60_000);
  usage.capture('terminal');
  usage.capture('terminal');
  usage.capture('debug');
  usage.search(['field', 'negation'], ['level']);
  usage.search([], []);
  usage.view('traces');
  usage.view('traces');
  advance(60 * 60_000);
  usage.touch();
  await usage.flush();
  assert.deepEqual(events(), [
    'installed',
    'activated',
    'milestone',
    'capture_started',
    'capture_started',
    'active_day',
    'milestone',
    'milestone',
    'milestone',
    'view_opened',
  ]);
  assert.deepEqual(
    sent.filter((item) => item.event === 'milestone').map((item) => [item.properties.name, item.properties.after]),
    [
      ['first_capture', '1-5m'],
      ['first_search', '1-5m'],
      ['first_filtered_search', '1-5m'],
      ['first_view_switch', '1-5m'],
    ],
  );
  usage.dispose();
  const tomorrow = setup({ state: globalState });
  tomorrow.advance(24 * 60 * 60_000);
  tomorrow.usage.start();
  tomorrow.usage.touch();
  tomorrow.usage.touch();
  await tomorrow.usage.flush();
  assert.deepEqual(tomorrow.events(), ['activated', 'active_day']);
  tomorrow.usage.dispose();
});

test('searches are timed for the first few, then sampled; the summary counts what they used', async () => {
  const { usage, sent } = setup();
  usage.start();
  for (let i = 0; i < 60; i++) usage.search(i % 2 ? ['regex'] : ['field'], ['level', 'service'], 30);
  usage.shared('all', 2, 1200);
  usage.agentTool({
    tool: 'logline_search_logs',
    via: 'mcp',
    client: 'claude-code',
    ok: true,
    ms: 40,
    resultSize: 2048,
    truncated: false,
    redactions: 0,
  });
  await usage.close();
  assert.equal(sent.filter((item) => item.event === 'perf').length, 6);
  const summary = sent.find((item) => item.event === 'session_summary')!.properties;
  assert.equal(summary.searches, '10-99');
  assert.equal(summary.op_field, '10-99');
  assert.equal(summary.op_regex, '10-99');
  assert.deepEqual(summary.fields, ['level', 'service']);
  assert.equal(summary.shares, '1-9');
  assert.equal(summary.tool_calls, '1-9');
  assert.equal(summary.unused_shares, '0');
  assert.deepEqual(summary.clients_used, ['claude-code']);
  assert.deepEqual(summary.features_used, ['logline_search_logs']);
  assert.ok(sent.some((item) => item.event === 'sharing_stopped'));
  const after = sent.find((item) => item.event === 'first_tool_after_share')!;
  assert.equal(after.properties.after, '<1m');
});

test('a window that shares from its start is counted apart from someone sharing', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.autoShared(2, 300);
  usage.agentTool({
    tool: 'logline_search_logs',
    via: 'mcp',
    client: 'claude-code',
    ok: true,
    ms: 40,
    resultSize: 2048,
    truncated: false,
    redactions: 0,
  });
  await usage.close();
  const shared = sent.filter((item) => item.event === 'shared_with_agent');
  assert.deepEqual(
    shared.map(({ properties }) => [properties.how, properties.sources, properties.events]),
    [['auto', '1-9', '100-999']],
  );
  assert.ok(!sent.some((item) => item.event === 'milestone' && item.properties.name === 'first_share'));
  assert.ok(
    sent.some((item) => item.event === 'first_tool_after_share'),
    'its first tool call is still timed',
  );
  assert.equal(sent.find((item) => item.event === 'session_summary')!.properties.shares, '0');
});

test('a share no agent used is counted as unused', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.shared('runs', 1, 40);
  usage.sharingStopped();
  usage.shared('event', 1, 1);
  await usage.close();
  assert.equal(sent.find((item) => item.event === 'session_summary')!.properties.unused_shares, '1-9');
  assert.deepEqual(
    sent.filter((item) => item.event === 'shared_with_agent').map((item) => item.properties.how),
    ['runs', 'event'],
  );
});

test('the summary reads sizes and connection counts from the rest of Logline', async () => {
  const { usage, sent, advance } = setup();
  let captured = 0;
  usage.start({
    eventsCaptured: () => captured,
    sources: () => 3,
    memoryMb: () => 42,
    trimmed: () => true,
    connections: () => ({ datadog: 1, postgres: 2 }),
  });
  usage.sampleRate();
  captured = 7200;
  advance(60_000);
  usage.sampleRate();
  captured = 12_000;
  advance(60_000);
  usage.sampleRate();
  await usage.close();
  const summary = sent.find((item) => item.event === 'session_summary')!.properties;
  assert.equal(summary.events_captured, '10k-100k');
  assert.equal(summary.sources, '1-9');
  assert.equal(summary.memory_mb, '10-99');
  assert.equal(summary.trimmed, true);
  assert.equal(summary.peak_events_per_sec, '100-999');
  assert.equal(summary.conn_datadog, '1-9');
  assert.equal(summary.conn_postgres, '1-9');
});

test('the queue holds at most 500 events', async () => {
  const { usage, sent } = setup();
  usage.start();
  for (let i = 0; i < 700; i++) usage.record('log_lens_clicked');
  await usage.flush();
  assert.equal(sent.length, 500);
  usage.dispose();
});

test('a changed setting is sent by name, with its value only when it is a choice', async () => {
  const { usage, sent } = setup();
  usage.start();
  host.settings.set('captureTerminals', true);
  host.settings.set('redactionFields', ['customer_email']);
  host.configListener?.({ affectsConfiguration: (key) => key === 'logline.captureTerminals' });
  host.configListener?.({ affectsConfiguration: (key) => key === 'logline.redactionFields' });
  await usage.flush();
  assert.deepEqual(
    sent.filter((item) => item.event === 'setting_changed').map((item) => [item.properties.key, item.properties.value]),
    [
      ['captureTerminals', true],
      ['redactionFields', 'custom'],
    ],
  );
  usage.dispose();
});

test('nothing a person typed or captured reaches a batch, however a caller passes it', async () => {
  const leaks = ['/Users/someone/secret-project', 'db-prod-3.acme.internal', 'level:error user_id:42', 'Payments EU'];
  const { usage, bodies } = setup();
  usage.start();
  for (const event of Object.keys(USAGE_EVENTS)) {
    const properties: Record<string, unknown> = {};
    for (const key of Object.keys(USAGE_EVENTS[event])) properties[key] = leaks[key.length % leaks.length];
    usage.record(event, { ...properties, message: leaks[0], label: leaks[3], query: leaks[2], host: leaks[1] });
  }
  usage.view(leaks[1]);
  usage.capture(leaks[0]);
  usage.search([], [leaks[2]]);
  usage.command(leaks[0]);
  await usage.close();
  const text = bodies.join('\n');
  for (const leak of leaks) assert.ok(!text.includes(leak), `${leak} was sent`);
});

test('survey answers are the only text sent, and only while usage counts are on', async () => {
  const { usage, sent } = setup();
  usage.start();
  assert.equal(await usage.survey('survey-1', { q1: 'Search', q2: 'x'.repeat(900) }), true);
  const answer = sent.find((item) => item.event === 'survey sent')!;
  assert.equal(answer.properties.$survey_id, 'survey-1');
  assert.equal(answer.properties.$survey_response_q1, 'Search');
  assert.equal((answer.properties.$survey_response_q2 as string).length, 500);
  assert.equal(answer.properties.$survey_completed, true);
  host.settings.set('telemetry.enabled', false);
  assert.equal(await usage.survey('survey-1', { q1: 'Search' }), false);
  assert.equal(await usage.survey('', { q1: 'Search' }), false);
  usage.dispose();
});

test('a reset id stops later events being tied to earlier ones', async () => {
  const { usage, sent } = setup();
  usage.start();
  await usage.flush();
  const before = usage.usageId;
  await usage.resetId();
  usage.command('logline.showLogs');
  await usage.flush();
  assert.notEqual(usage.usageId, before);
  assert.equal(sent.at(-1)!.distinct_id, usage.usageId);
  usage.dispose();
});

test('a counted command records its id, never its arguments, and returns what the handler does', () => {
  const recorded: string[] = [];
  const usage = { command: (id: string) => recorded.push(id) } as any;
  const handler = counted(usage, 'logline.showTrace', (traceId: string, extra: number) => `${traceId}:${extra}`);
  assert.equal(handler('abc123', 2), 'abc123:2');
  assert.deepEqual(recorded, ['logline.showTrace']);
  assert.equal(counted(undefined, 'logline.showTrace', () => 5)(), 5);
});

test('the vocabulary reads commands and setting kinds from the manifest', () => {
  assert.ok(vocabulary.commands.has('logline.showLogs'));
  assert.ok(!vocabulary.commands.has('workbench.action.reloadWindow'));
  assert.equal(vocabulary.settings.get('captureTerminals'), 'boolean');
  assert.deepEqual(vocabulary.settings.get('source'), ['both', 'stdout', 'stderr']);
  assert.equal(vocabulary.settings.get('maxEvents'), 'number');
  assert.equal(vocabulary.settings.get('redactionFields'), 'custom');
  assert.equal(usageEnvironment('1.19.0').vscode, '1.105.1');
});

test('what Log Doctor finds counts once per kind, and a vote on a kind says whether it helps', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.findings(['secret', 'noisy', 'secret']);
  usage.findings(['noisy', 'made-up', 'unit-in-name']);
  usage.findingHelpful('noisy', false);
  await usage.flush();
  assert.deepEqual(
    sent.filter((item) => item.event === 'doctor_finding').map((item) => item.properties.code),
    ['secret', 'noisy', 'unit-in-name'],
  );
  const vote = sent.find((item) => item.event === 'feedback')!.properties;
  assert.equal(vote.surface, 'doctor');
  assert.equal(vote.code, 'noisy');
  assert.equal(vote.helpful, false);
  usage.dispose();
});

test('after Ask Copilot, whether it helped is asked at most once a week and three times in all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = memento();
  let asked = 0;
  const answers: unknown[] = [];
  for (let week = 0; week < 5; week++) {
    const window = setup({ state });
    window.advance(week * 7 * 24 * 60 * 60 * 1000);
    window.usage.start();
    host.messages.length = 0;
    host.answer = week % 2 ? 'No' : 'Yes';
    window.usage.askWhetherCopilotHelped();
    window.usage.askWhetherCopilotHelped();
    t.mock.timers.tick(HELPFUL_DELAY_MS);
    await new Promise((resolve) => setImmediate(resolve));
    asked += host.messages.length;
    await window.usage.flush();
    answers.push(...window.sent.filter((item) => item.event === 'feedback').map((item) => item.properties.helpful));
    // Asked again in the same week: no.
    window.usage.askWhetherCopilotHelped();
    t.mock.timers.tick(HELPFUL_DELAY_MS);
    window.usage.dispose();
  }
  assert.equal(asked, 3);
  assert.deepEqual(answers, [true, false, true]);
});

test('closing twice sends one summary, and Show Usage Data keeps it until the last batch is out', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.showData();
  host.lines.length = 0;
  const first = usage.close();
  const second = usage.close();
  assert.equal(first, second);
  await first;
  assert.equal(sent.filter((item) => item.event === 'session_summary').length, 1);
  assert.ok(
    host.lines.some((line) => /session_summary/.test(line)),
    'the summary reached the output channel',
  );
  await usage.close();
  assert.equal(sent.filter((item) => item.event === 'session_summary').length, 1);
});

test('a window left open sends a summary every day, and sends batches every minute', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { usage, sent } = setup();
  usage.start();
  usage.search(['field'], ['level']);
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    sent.some((item) => item.event === 'activated'),
    'the minute’s batch went out',
  );
  assert.equal(sent.filter((item) => item.event === 'session_summary').length, 0);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  const summaries = sent.filter((item) => item.event === 'session_summary');
  assert.equal(summaries.length, 1, 'one summary a day');
  assert.equal(summaries[0].properties.searches, '1-9');
  usage.dispose();
});

test('events are timed to the minute, no finer', async () => {
  const { usage, sent, advance } = setup();
  advance(37_123);
  usage.start();
  await usage.flush();
  assert.ok(sent.length > 0);
  for (const item of sent as unknown as { timestamp: string }[]) assert.match(item.timestamp, /:00\.000Z$/);
  usage.dispose();
});

test('what goes over the wire is the api key and anonymous events, nothing else', async () => {
  const { usage, bodies } = setup();
  const pii = 'jane.doe@acme.com /Users/jane db-prod-3.acme.internal';
  usage.start({
    eventsCaptured: () => 5,
    sources: () => 1,
    memoryMb: () => 3,
    trimmed: () => false,
    connections: () => ({ datadog: 1, [pii]: 2 }),
  });
  usage.command(pii);
  usage.view(pii);
  usage.capture(pii);
  usage.search(['field'], [pii, 'level'], 12);
  usage.shared('all', 1, 10);
  usage.agentConnected(pii);
  usage.agentTool({
    tool: pii,
    via: 'mcp',
    client: pii,
    ok: false,
    code: pii,
    ms: 3,
    resultSize: 10,
    truncated: false,
    redactions: 0,
  });
  usage.findings([pii, 'secret']);
  usage.findingHelpful(pii, true);
  usage.record('error', { area: 'bridge', code: pii, message: pii });
  await usage.survey('survey-1', { q1: 'Search' });
  await usage.close();

  const common = ['version', 'vscode', 'host', 'ui', 'remote', 'os', 'arch', 'cpus', 'ram_gb'];
  const flags = ['$process_person_profile', '$geoip_disable'];
  for (const body of bodies) {
    const parsed = JSON.parse(body) as { api_key: string; batch: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(parsed).sort(), ['api_key', 'batch'], 'only the key and the events');
    for (const item of parsed.batch) {
      assert.deepEqual(Object.keys(item).sort(), ['distinct_id', 'event', 'properties', 'timestamp']);
      assert.match(
        String(item.distinct_id),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        'a random id',
      );
      const properties = item.properties as Record<string, unknown>;
      assert.equal(properties.$process_person_profile, false, 'no person profile');
      assert.equal(properties.$geoip_disable, true, 'no location');
      const own = item.event === 'survey sent' ? [] : Object.keys(USAGE_EVENTS[String(item.event)] ?? {});
      for (const key of Object.keys(properties))
        assert.ok(
          common.includes(key) || flags.includes(key) || own.includes(key) || key.startsWith('$survey_'),
          `${String(item.event)} carried ${key}`,
        );
    }
  }
  const text = bodies.join('\n');
  for (const part of pii.split(' ')) assert.ok(!text.includes(part), `${part} was sent`);
  const events = bodies.flatMap(
    (body) => (JSON.parse(body) as { batch: { event: string; distinct_id: string }[] }).batch,
  );
  const survey = events.find((item) => item.event === 'survey sent')!;
  assert.notEqual(survey.distinct_id, usage.usageId, 'an answer cannot be tied to the install’s usage counts');
  assert.ok(events.filter((item) => item.event !== 'survey sent').every((item) => item.distinct_id === usage.usageId));
});

test('only the person’s own settings can turn usage counts on: a workspace cannot override the switch', () => {
  const sections = (
    manifest as { contributes: { configuration: { properties: Record<string, { scope?: string }> }[] } }
  ).contributes.configuration;
  const setting = sections.find((section) => section.properties['logline.telemetry.enabled'])!.properties[
    'logline.telemetry.enabled'
  ];
  assert.equal(setting.scope, 'application');
});

test('windows starting together on a new install share one id and count one install', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'logline-usage-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const first = setup({ storage });
  const second = setup({ storage });
  first.usage.start();
  second.usage.start();
  await first.usage.flush();
  await second.usage.flush();
  assert.equal(second.usage.usageId, first.usage.usageId);
  assert.equal(first.usage.newInstall, true);
  assert.equal(second.usage.newInstall, false, 'only one window acts on the install');
  assert.ok(first.events().includes('installed'));
  assert.ok(!second.events().includes('installed'));
  assert.ok(second.events().includes('activated'), 'the other window still counts as started');
  assert.equal(second.globalState.get('logline.usage.state'), undefined, 'state is left to the window that won');
  assert.deepEqual(readdirSync(storage), ['usage-id'], 'the id appears whole, with nothing left beside it');
  first.usage.dispose();
  second.usage.dispose();
});

test('an id file that cannot be used leaves the window with its own id', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'logline-usage-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  writeFileSync(join(storage, 'usage-id'), 'not an id');
  const { usage, events } = setup({ storage });
  usage.start();
  await usage.flush();
  assert.notEqual(usage.usageId, 'not an id');
  assert.ok(events().includes('installed'));
  usage.dispose();
});

test('a reset id replaces the id windows would otherwise share', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'logline-usage-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const { usage } = setup({ storage });
  usage.start();
  await usage.resetId();
  assert.equal(readFileSync(join(storage, 'usage-id'), 'utf8'), usage.usageId);
  usage.dispose();
});

test('someone who used Logline before is not a new install', () => {
  const { usage } = setup({ state: memento({ 'logline.guide.lastSeenVersion': '1.15.0' }) });
  usage.start();
  assert.equal(usage.newInstall, false);
  usage.dispose();
});

test('the panel coming into view is activity each time and one event a session', async () => {
  const { usage, events, advance } = setup();
  usage.start();
  usage.panelOpened();
  usage.panelOpened();
  advance(24 * 60 * 60 * 1000);
  usage.panelOpened();
  await usage.flush();
  assert.equal(events().filter((event) => event === 'panel_opened').length, 1);
  assert.equal(events().filter((event) => event === 'active_day').length, 2);
  usage.dispose();
});

test('panel actions are activity, sent once a session for each kind, and opened events are counted', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.panelAction('inspect_event');
  usage.panelAction('inspect_event');
  usage.panelAction('export');
  await usage.close();
  const actions = sent.filter((item) => item.event === 'panel_action').map((item) => item.properties.action);
  assert.deepEqual(actions, ['inspect_event', 'export']);
  assert.equal(sent.filter((item) => item.event === 'active_day').length, 1);
  const milestones = sent.filter((item) => item.event === 'milestone').map((item) => item.properties.name);
  assert.deepEqual(milestones, ['first_event_inspected']);
  const summary = sent.find((item) => item.event === 'session_summary')!.properties;
  assert.equal(summary.events_inspected, '1-9');
  assert.deepEqual(summary.actions_used, ['inspect_event', 'export']);
});

test('a search says how much it found, in a range, and the summary counts those that found nothing', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.search([], [], 12, 0);
  usage.search([], [], 12, 4321);
  await usage.close();
  const found = sent.filter((item) => item.properties.op === 'search').map((item) => item.properties.events);
  assert.deepEqual(found, ['0', '1k-10k']);
  assert.equal(sent.find((item) => item.event === 'session_summary')!.properties.empty_searches, '1-9');
});

test('a capture says whether it started by itself, and sharing says how it ended', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.capture('debug');
  usage.capture('command');
  usage.shared('all', 1, 1);
  usage.sharingStopped();
  usage.shared('all', 1, 1);
  await usage.close();
  const captures = sent.filter((item) => item.event === 'capture_started').map((item) => item.properties.auto);
  assert.deepEqual(captures, [true, false]);
  const stops = sent.filter((item) => item.event === 'sharing_stopped').map((item) => item.properties.by);
  assert.deepEqual(stops, ['user', 'closed']);
  assert.equal(sent.find((item) => item.event === 'shared_with_agent')!.properties.redacted, undefined);
});

test('terminals report shell integration once for each shell and outcome, and the panel its width once', async () => {
  const { usage, sent } = setup();
  usage.start();
  usage.terminalChecked('powershell', false);
  usage.terminalChecked('powershell', false);
  usage.terminalChecked('powershell', true);
  usage.terminalChecked('secret-shell', true);
  usage.panelSize(320);
  usage.panelSize(1400);
  await usage.flush();
  const checks = sent.filter((item) => item.event === 'terminal_checked').map((item) => item.properties);
  assert.deepEqual(checks.slice(0, 2), [
    { ...checks[0], shell: 'powershell', integrated: false },
    { ...checks[1], shell: 'powershell', integrated: true },
  ]);
  assert.equal(checks[2].shell, undefined, 'a shell outside the schema is not sent');
  const sizes = sent.filter((item) => item.event === 'panel_size').map((item) => item.properties.width);
  assert.deepEqual(sizes, ['narrow']);
});

test('the summary says how long the session ran, what was lost, and how logs parsed, in ranges', async () => {
  const { usage, sent, advance } = setup();
  usage.start({
    eventsCaptured: () => 200,
    sources: () => 1,
    memoryMb: () => 1,
    trimmed: () => true,
    connections: () => ({}),
    discarded: () => 150,
    truncated: () => 3,
    quality: () => ({ json: 100, unclassified: 30, multiline: 0 }),
  });
  advance(10 * 60_000);
  await usage.close();
  const summary = sent.find((item) => item.event === 'session_summary')!.properties;
  assert.equal(summary.session_length, '5-15m');
  assert.equal(summary.events_discarded, '100-999');
  assert.equal(summary.events_truncated, '1-9');
  assert.deepEqual([summary.pct_json, summary.pct_unclassified, summary.pct_multiline], ['100', '25-49', '0']);
});
