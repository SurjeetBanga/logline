import assert from 'node:assert/strict';
import test from 'node:test';
import { missingOtelVariables, otelDefaults } from '../core/otel-environment';
import { LogStore } from '../core/log-store';
import { SessionRegistry } from '../capture/session-registry';
import { SpanStore } from '../core/traces';
import { parseLogLine } from '../core/log-event';
import { withVscode } from '../test/vscode-mock';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { OtlpReceiver } from '../capture/otlp-receiver';
import { Ingestion } from '../capture/ingestion';
import { RuntimeState } from '../capture/runtime-state';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

test('OpenTelemetry defaults never replace a configured destination or set values', () => {
  const defaults = otelDefaults('http://127.0.0.1:4318', 'API');
  assert.equal(defaults.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
  assert.deepEqual(Object.keys(missingOtelVariables({}, defaults)).sort(), Object.keys(defaults).sort());
  assert.deepEqual(missingOtelVariables({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector:4318' }, defaults), {});
  assert.deepEqual(
    missingOtelVariables({ OTEL_METRICS_EXPORTER: 'prometheus' }, defaults),
    {},
    'a metrics destination is a destination too',
  );
  assert.deepEqual(
    missingOtelVariables({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://collector:4318/v1/metrics' }, defaults),
    {},
  );
  assert.deepEqual(missingOtelVariables({ OTEL_TRACES_EXPORTER: 'none' }, defaults), {});
  assert.deepEqual(missingOtelVariables({ OTEL_SDK_DISABLED: 'true' }, defaults), {});
  const kept = missingOtelVariables({ OTEL_SERVICE_NAME: 'mine', OTEL_EXPORTER_OTLP_PROTOCOL: '' }, defaults);
  assert.equal(kept.OTEL_SERVICE_NAME, undefined);
  assert.equal(kept.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/protobuf', 'an empty value counts as unset');
  assert.equal(
    missingOtelVariables({ OTEL_RESOURCE_ATTRIBUTES: 'team=a, service.name=checkout' }, defaults).OTEL_SERVICE_NAME,
    undefined,
  );
});

test('agent traces include only spans and logs from shared sources, redacted', async () => {
  const { AgentLogAccess } = withVscode({}, () => require('./agent-access') as typeof import('./agent-access'));
  const store = new LogStore();
  const registry = new SessionRegistry();
  const spans = new SpanStore();
  const add = (id: number, line: string, serverId: string) =>
    store.add({
      ...parseLogLine(line, 'otlp', id, new Date()),
      serverId,
      server: serverId,
      sessionId: `${serverId}-run`,
    });
  add(
    1,
    `{"msg":"charging card token=sk_live_abcdefghijklmnop","traceId":"${TRACE}","spanId":"1111111111111111"}`,
    'otel:api',
  );
  store.add({
    ...parseLogLine(`{"msg":"labelled","traceId":"${TRACE}"}`, 'otlp', 3, new Date()),
    serverId: 'otel:api',
    server: 'api password=hunter2',
    sessionId: 'otel:api-run',
  });
  add(2, `{"msg":"private","traceId":"${TRACE}"}`, 'otel:secret');
  for (const [service, id] of [
    ['api', '1111111111111111'],
    ['secret', '2222222222222222'],
  ])
    spans.add({
      traceId: TRACE,
      spanId: id,
      name: `${service} op`,
      kind: 2,
      startMs: 0,
      endMs: 5,
      service,
      events: [],
      status: { code: 0 },
      attributes: { 'http.request.header.authorization': 'Bearer abc.def.ghi', password: 'hunter2' },
    });
  const access = new AgentLogAccess(store, registry, () => 4, {}, spans);
  const share = access.share(['otel:api']);
  const trace = access.trace(share.shareId!, TRACE.toUpperCase());
  assert.deepEqual(
    trace.spans.map((span) => span.service),
    ['api'],
  );
  assert.deepEqual(
    trace.logs.map((log) => log.id),
    [1, 3],
  );
  assert.doesNotMatch(JSON.stringify(trace), /hunter2|sk_live_abcdefghijklmnop/);
  assert.throws(() => access.trace(share.shareId!, '../x'), /INVALID_INPUT|trace id/);
  // Spans accepted by a run that was not selected stay private.
  spans.add({
    traceId: TRACE,
    spanId: '3333333333333333',
    name: 'old run op',
    kind: 2,
    startMs: 1,
    endMs: 2,
    service: 'api',
    events: [],
    status: { code: 0 },
    attributes: {},
    sessionId: 'old-run',
  });
  spans.add({
    traceId: TRACE,
    spanId: '4444444444444444',
    name: 'own run op',
    kind: 2,
    startMs: 1,
    endMs: 2,
    service: 'api',
    events: [],
    status: { code: 0 },
    attributes: {},
    sessionId: 'otel:api-run',
  });
  const scoped = access.trace(share.shareId!, TRACE);
  assert.deepEqual(scoped.spans.map((span) => span.name).sort(), ['api op', 'own run op']);
  access.revoke();
  assert.throws(() => access.trace(share.shareId!, TRACE), /No Logline logs are shared/);
});

test('the controller runs the receiver from settings and points new processes at it', async (t) => {
  const settings: Record<string, unknown> = { 'otlp.enabled': true, 'otlp.port': 0 };
  let changeListener: ((event: { affectsConfiguration(name: string): boolean }) => void) | undefined;
  const environment = new Map<string, string>();
  const collection = {
    replace: (name: string, value: string) => environment.set(name, value),
    clear: () => environment.clear(),
    description: '',
    persistent: true,
  };
  const mock = {
    ConfigurationTarget: { Workspace: 2, Global: 1 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/w' } }],
      onDidChangeConfiguration: (listener: typeof changeListener) => {
        changeListener = listener;
        return { dispose() {} };
      },
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
        update: async (key: string, value: unknown) => {
          settings[key] = value;
        },
      }),
    },
    window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
    commands: { executeCommand: async () => undefined },
  };
  const { LogsController } = withVscode(mock, () => require('./logs-controller') as typeof import('./logs-controller'));
  const controller = new LogsController({
    globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
    environmentVariableCollection: collection,
  } as never);
  t.after(() => controller.dispose());
  for (let i = 0; i < 50 && !environment.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.otlp.running, true);
  assert.equal(collection.persistent, false, 'a stale endpoint is never restored into revived terminals');
  const endpoint = controller.otlp.endpoint!;
  // Port 0 means any free port: re-syncing keeps the one in use instead of restarting.
  await controller.otel.sync();
  assert.equal(controller.otlp.endpoint, endpoint);
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) assert.equal(environment.get('OTEL_EXPORTER_OTLP_ENDPOINT'), endpoint);
  assert.equal(environment.has('OTEL_SERVICE_NAME'), false, "terminals keep the app's own service name");
  assert.deepEqual(controller.snapshot({ type: 'snapshot', statsOnly: true }).otlp, {
    running: true,
    endpoint,
    error: undefined,
  });

  // Saved servers get a service name; ad-hoc commands do not.
  const saved = controller.runner.environment!({ id: 'api', label: 'API' }, {});
  const adHoc = controller.runner.environment!({ id: 'custom', label: 'npm run dev' }, {});
  assert.deepEqual(
    [saved.OTEL_SERVICE_NAME, saved.OTEL_EXPORTER_OTLP_ENDPOINT, adHoc.OTEL_SERVICE_NAME],
    ['API', endpoint, undefined],
  );
  assert.deepEqual(
    controller.runner.environment!({ id: 'api', label: 'API' }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://elsewhere' }),
    {},
  );

  // Telemetry flows into the trace view, alongside plain logs that carry the same trace id.
  controller.otlp.acceptSpans({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: '1111111111111111',
                name: 'GET /',
                kind: 2,
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '3000000000',
              },
            ],
          },
        ],
      },
    ],
  });
  controller.ingestion.accept(`{"msg":"handled","trace_id":"${TRACE}","span_id":"1111111111111111"}`, 'stdout', {
    serverId: 'web',
    server: 'web',
    sessionId: 'r',
  });
  const view = controller.traceView(TRACE);
  assert.deepEqual(
    view.spans.map((span) => span.name),
    ['GET /'],
  );
  assert.deepEqual(
    view.logs.map((log) => [log.message, log.spanId]),
    [['handled', '1111111111111111']],
    'the span row itself is not repeated as a log',
  );
  controller.clear();
  assert.equal(controller.traceView(TRACE).spans.length, 0);

  await controller.toggleOtlp(false);
  assert.equal(controller.otlp.running, false);
  assert.equal(settings['otlp.enabled'], true, 'Stop affects this window only and leaves shared settings alone');
  await controller.otel.sync();
  assert.equal(controller.otlp.running, false, 'the window keeps the stopped state across re-syncs');
  controller.otel.settingChanged();
  await controller.otel.sync();
  assert.equal(controller.otlp.running, true, 'changing the setting takes over again');
  await controller.toggleOtlp(false);
  assert.equal(environment.size, 0, 'the terminal environment is restored');
  assert.equal(controller.otel.variables(), undefined);
  assert.ok(changeListener);
});

test('debug launch configurations receive OpenTelemetry variables while the receiver runs', () => {
  let provider:
    | {
        resolveDebugConfigurationWithSubstitutedVariables(
          folder: unknown,
          configuration: Record<string, unknown>,
        ): Record<string, unknown>;
      }
    | undefined;
  delete require.cache[require.resolve('./otel-integration')];
  const { OtelIntegration, envFileVariables } = withVscode(
    {
      debug: {
        registerDebugConfigurationProvider: (_type: string, value: typeof provider) => {
          provider = value;
          return { dispose() {} };
        },
      },
    },
    () => require('./otel-integration') as typeof import('./otel-integration'),
  );
  const receiver = { running: true, endpoint: 'http://127.0.0.1:4318' };
  const integration = new OtelIntegration(
    { get: <T>(_key: string, fallback: T) => fallback, refresh() {} },
    receiver as never,
    () => {},
  );
  assert.equal(integration.registerDebugEnvironment().length, 1);
  const launch = provider!.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
    type: 'node',
    request: 'launch',
    env: { FOO: 'bar' },
  });
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
    assert.equal((launch.env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:4318');
  assert.equal((launch.env as Record<string, string>).FOO, 'bar');
  const own = provider!.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
    type: 'python',
    request: 'launch',
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://mine' },
  });
  assert.deepEqual(own.env, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://mine' });
  assert.equal(
    provider!.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: 'node', request: 'attach' }).env,
    undefined,
  );
  // An exporter configured in the env file is kept: env would override it.
  const folder = mkdtempSync(path.join(tmpdir(), 'logline-envfile-'));
  try {
    writeFileSync(path.join(folder, 'app.env'), 'export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector:4318"\n');
    const fromFile = provider!.resolveDebugConfigurationWithSubstitutedVariables(
      { uri: { fsPath: folder } },
      { type: 'node', request: 'launch', envFile: 'app.env' },
    );
    assert.equal(fromFile.env, undefined);
    writeFileSync(path.join(folder, '.env'), 'OTEL_TRACES_EXPORTER=console # local\n');
    assert.deepEqual(envFileVariables({ type: 'debugpy' }, folder), { OTEL_TRACES_EXPORTER: 'console' });
    assert.equal(
      provider!.resolveDebugConfigurationWithSubstitutedVariables(
        { uri: { fsPath: folder } },
        { type: 'debugpy', request: 'launch' },
      ).env,
      undefined,
    );
    assert.deepEqual(envFileVariables({ type: 'node' }, folder), {}, 'only Python reads .env without envFile');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  receiver.running = false;
  assert.equal(
    provider!.resolveDebugConfigurationWithSubstitutedVariables(undefined, { type: 'node', request: 'launch' }).env,
    undefined,
  );
});

test('changing the port restarts a receiver that fell back to another port', async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const taken = (blocker.address() as { port: number }).port;
  const settings: Record<string, unknown> = { 'otlp.enabled': true, 'otlp.port': taken };
  const { OtelIntegration } = withVscode(
    {},
    () => require('./otel-integration') as typeof import('./otel-integration'),
  );
  const config = {
    get: <T>(key: string, fallback: T) => (key in settings ? settings[key] : fallback) as T,
    refresh() {},
  };
  const receiver = new OtlpReceiver(
    config,
    new SessionRegistry(),
    new Ingestion(new LogStore(), () => {}),
    new RuntimeState(() => {}),
    new SpanStore(),
  );
  const integration = new OtelIntegration(config, receiver, () => {});
  t.after(() => integration.dispose());
  await integration.sync();
  const fallback = receiver.endpoint;
  assert.ok(receiver.error);
  await integration.sync();
  assert.equal(receiver.endpoint, fallback, 'an unchanged setting keeps the fallback port');
  settings['otlp.port'] = 0;
  await integration.sync();
  assert.notEqual(receiver.endpoint, fallback);
  assert.equal(receiver.error, undefined);
});
