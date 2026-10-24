import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ingestion } from '../capture/ingestion';
import { RemoteSource } from '../capture/remote-source';
import { RuntimeState } from '../capture/runtime-state';
import { SessionRegistry } from '../capture/session-registry';
import { normalizeConnections, secretKey, type PostgresConnection } from '../core/connections';
import { LogStore } from '../core/log-store';
import { startFakeDatadog } from '../test/fake-datadog';
import { withVscode } from '../test/vscode-mock';

const hasSqlite = isBuiltin('node:sqlite');
type Item = { label: string; [key: string]: unknown };

// The person at the keyboard: each picker and input box takes the next scripted answer.
const ui = {
  picks: [] as ((items: Item[]) => Item | undefined)[],
  inputs: [] as (string | undefined)[],
  file: undefined as string | undefined,
  modal: undefined as string | undefined,
  errorChoice: undefined as string | undefined,
  messages: [] as string[],
};
let trusted = true;
let folder = tmpdir();
const raw: { workspace?: unknown[]; global?: unknown[] } = {};
const updates: { value: unknown[]; target: number }[] = [];
const mock = {
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ProgressLocation: { Notification: 15 },
  workspace: {
    get isTrusted() {
      return trusted;
    },
    get workspaceFolders() {
      return [{ uri: { fsPath: folder } }];
    },
    getConfiguration: () => ({
      inspect: () => ({ workspaceValue: raw.workspace, globalValue: raw.global }),
      update: async (_key: string, value: unknown[], target: number) => {
        updates.push({ value, target });
        if (target === 2) raw.workspace = value;
        else raw.global = value;
      },
    }),
  },
  window: {
    showQuickPick: async (items: Item[]) => ui.picks.shift()?.(items),
    showInputBox: async () => ui.inputs.shift(),
    showOpenDialog: async () => (ui.file ? [{ scheme: 'file', fsPath: ui.file }] : undefined),
    showWarningMessage: async (message: string, ...rest: unknown[]) => {
      ui.messages.push(`warning: ${message}`);
      return typeof rest[0] === 'object' ? ui.modal : undefined;
    },
    showInformationMessage: async (message: string) => ui.messages.push(`info: ${message}`),
    showErrorMessage: async (message: string) => {
      ui.messages.push(`error: ${message}`);
      return ui.errorChoice;
    },
    withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
  },
};
const { ConnectionManager, parseMongoUrl, parsePostgresUrl, parseServerUrl } = withVscode(
  mock,
  () => require('./connections') as typeof import('./connections'),
);

const pick = (label: string | RegExp) => (items: Item[]) =>
  items.find((item) => (typeof label === 'string' ? item.label === label : label.test(item.label)));

function setup() {
  const store = new LogStore(1000);
  const registry = new SessionRegistry();
  const state = new RuntimeState(() => undefined);
  const settings: Record<string, unknown> = { connectionTimeoutSeconds: 5 };
  const config = {
    get: <T>(key: string, fallback: T): T =>
      key === 'connections'
        ? (normalizeConnections([...(raw.workspace ?? []), ...(raw.global ?? [])]) as T)
        : Object.hasOwn(settings, key)
          ? (settings[key] as T)
          : fallback,
  };
  const remote = new RemoteSource(config, registry, new Ingestion(store, () => undefined), state);
  const secrets = new Map<string, string>();
  const shown: string[] = [];
  const memento = new Map<string, unknown>();
  const manager = new ConnectionManager(
    config,
    remote,
    {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    async (sourceId, runId, query) =>
      void shown.push(`${runId ? `${sourceId}#${runId}` : sourceId}${query !== undefined ? `?${query}` : ''}`),
    undefined,
    {
      get: <T>(key: string, fallback?: T) => (memento.has(key) ? memento.get(key) : fallback) as T,
      update: async (key: string, value: unknown) => void memento.set(key, value),
    },
  );
  return { store, registry, remote, manager, secrets, shown, memento, settings };
}

function reset() {
  ui.picks.length = ui.inputs.length = ui.messages.length = updates.length = 0;
  ui.file = ui.modal = ui.errorChoice = undefined;
  raw.workspace = raw.global = undefined;
  trusted = true;
}

/** A workspace with an app.db whose rows were logged in the last few minutes. */
function workspaceDatabase(): string {
  folder = mkdtempSync(join(tmpdir(), 'logline-workspace-'));
  const file = join(folder, 'app.db');
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const db = new DatabaseSync(file);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  db.exec(`
    CREATE TABLE app_logs (id INTEGER PRIMARY KEY, created_at TEXT, severity TEXT, msg TEXT, user_id INTEGER);
    INSERT INTO app_logs (created_at, severity, msg, user_id) VALUES
      ('${at(50)}', 'ERROR', 'payment gateway timed out', 42),
      ('${at(3)}', 'INFO', 'retrying', 42),
      ('${at(2)}', 'ERROR', 'payment gateway timed out', 7),
      ('${at(1)}', 'ERROR', 'card declined', 42);
  `);
  db.close();
  return file;
}

test('Postgres connection URLs are read without keeping the password in settings', () => {
  assert.deepEqual(parsePostgresUrl(['postgres://dev', 's%40cret@db.local:6543/orders?sslmode=require'].join(':')), {
    connection: {
      id: 'draft',
      label: 'orders',
      type: 'postgres',
      host: 'db.local',
      port: 6543,
      database: 'orders',
      user: 'dev',
      ssl: true,
    },
    password: 's@cret',
  });
  assert.deepEqual(parsePostgresUrl('postgresql://dev@localhost/orders')?.connection.port, 5432);
  assert.equal(parsePostgresUrl('postgresql://dev@localhost/orders')?.password, undefined);
  for (const value of [
    '',
    'mysql://dev@localhost/orders',
    'postgres://localhost/orders',
    'postgres://dev@localhost/',
    'not a url',
  ])
    assert.equal(parsePostgresUrl(value), undefined, value);
});

test(
  'adding a SQLite connection tests it, maps its log table, and saves it relative to the workspace',
  { skip: !hasSqlite },
  async () => {
    reset();
    ui.file = workspaceDatabase();
    const { manager, shown } = setup();
    ui.picks.push(
      pick('SQLite'),
      pick('app_logs'),
      // Change the suggested service column, then confirm.
      pick('Service'),
      pick('user_id'),
      pick('Service'),
      pick('None'),
      pick(/Use these columns/),
    );
    ui.inputs.push('App DB');
    await manager.add();
    assert.deepEqual(updates, [
      {
        value: [
          {
            id: 'app-db',
            label: 'App DB',
            type: 'sqlite',
            path: 'app.db',
            logs: { table: 'app_logs', timestamp: 'created_at', level: 'severity', message: 'msg' },
          },
        ],
        target: 2,
      },
    ]);
    assert.deepEqual(shown, ['conn:app-db']);
    assert.match(ui.messages.at(-1)!, /Added SQLite · App DB\. Pick a time range and press Run/);
    // A second connection with the same name gets its own id, and without a table it only runs SQL.
    ui.picks.push(pick('SQLite'), pick('No log table'));
    ui.inputs.push('App DB');
    await manager.add();
    assert.deepEqual(raw.workspace?.[1], { id: 'app-db-2', label: 'App DB', type: 'sqlite', path: 'app.db' });
    manager.dispose();
  },
);

test('a connection that cannot be reached is reported and not saved', async () => {
  reset();
  const { manager, secrets } = setup();
  ui.picks.push(pick('Postgres'));
  // Built at runtime: a URL with a password in it looks like a leaked credential to secret scanners.
  ui.inputs.push(['postgres://dev', 'pw@127.0.0.1:1/orders'].join(':'));
  await manager.add();
  assert.equal(updates.length, 0);
  assert.equal(secrets.size, 0);
  assert.match(ui.messages.at(-1)!, /^error: Could not connect: .*ECONNREFUSED/);
  manager.dispose();
});

test(
  'a saved connection is searched over a range into a run, previewed, and closed when its settings change',
  { skip: !hasSqlite },
  async () => {
    reset();
    workspaceDatabase();
    raw.workspace = [
      {
        id: 'app',
        label: 'app',
        type: 'sqlite',
        path: 'app.db',
        logs: { table: 'app_logs', timestamp: 'created_at', level: 'severity', message: 'msg' },
      },
    ];
    const { manager, store, remote } = setup();
    assert.deepEqual(manager.views(), [
      {
        id: 'app',
        sourceId: 'conn:app',
        label: 'SQLite · app',
        type: 'sqlite',
        mapped: true,
        sql: true,
        watching: [],
        agents: false,
        tailing: false,
      },
    ]);
    const preview = await manager.preview('app', 'level:error /declined/', '15m');
    assert.deepEqual(preview.local, ['/declined/']);
    assert.match(preview.statement!, /^SELECT \* FROM "app_logs" WHERE julianday/);
    await manager.fetch('app', 'level:error user_id:42', '15m');
    // The error from 50 minutes ago is outside the range.
    assert.deepEqual(
      store.all().map((event) => event.message),
      ['card declined'],
    );
    const view = manager.views()[0];
    assert.equal(view.last?.kept, 1);
    assert.equal(view.last?.running, false);
    // A search the mapping no longer fits reports why.
    raw.workspace = [{ ...(raw.workspace[0] as object), logs: { table: 'missing', timestamp: 'ts' } }];
    manager.refresh();
    await manager.fetch('app', '', '1h');
    assert.match(ui.messages.at(-1)!, /^error: SQLite · app: Table missing was not found\./);
    // Removing the connection stops its runs and forgets its last result.
    raw.workspace = [];
    manager.refresh();
    assert.equal(remote.last('app'), undefined);
    assert.deepEqual(manager.views(), []);
    manager.dispose();
  },
);

test('connections stay closed in untrusted workspaces', async () => {
  reset();
  trusted = false;
  raw.workspace = [{ id: 'app', type: 'sqlite', path: 'app.db', logs: { table: 't', timestamp: 'ts' } }];
  const { manager, registry } = setup();
  await manager.fetch('app', '', '1h');
  await manager.add();
  await manager.runSql('app');
  assert.equal(registry.records.size, 0);
  assert.deepEqual((await manager.preview('app', '', '1h')).local, []);
  assert.ok(ui.messages.every((message) => message.startsWith('warning: Trust this workspace')));
  assert.equal(ui.messages.length, 3);
});

test('removing a connection takes it out of settings, and forgets its password when asked', async () => {
  reset();
  const orders: PostgresConnection = {
    id: 'orders',
    label: 'orders',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'orders',
    user: 'dev',
  };
  raw.workspace = [orders, { id: 'other', type: 'sqlite', path: 'x.db' }, 'kept as it was'];
  raw.global = [orders];
  const { manager, secrets } = setup();
  secrets.set(secretKey(orders), 'pw');
  ui.modal = undefined;
  await manager.remove('orders');
  assert.equal(updates.length, 0, 'cancelled');
  ui.modal = 'Remove';
  await manager.remove('orders');
  assert.deepEqual(raw.workspace, [{ id: 'other', type: 'sqlite', path: 'x.db' }, 'kept as it was']);
  assert.deepEqual(raw.global, []);
  assert.equal(secrets.size, 1, 'other workspaces that open the same database keep the password');
  raw.workspace = [orders];
  ui.modal = 'Remove and Forget Password';
  await manager.remove('orders');
  assert.deepEqual(raw.workspace, []);
  assert.equal(secrets.size, 0);
});

const appConnection = {
  id: 'app',
  label: 'app',
  type: 'sqlite',
  path: 'app.db',
  logs: { table: 'app_logs', timestamp: 'created_at', level: 'severity', message: 'msg' },
};

test(
  'typed SQL, palette searches, tails and tests run against the chosen connection',
  { skip: !hasSqlite },
  async () => {
    reset();
    workspaceDatabase();
    raw.workspace = [appConnection, { id: 'raw', label: 'raw', type: 'sqlite', path: 'app.db' }];
    const { manager, store, remote, shown } = setup();
    // Only mapped connections can be searched, so the palette goes straight to the range.
    ui.picks.push(pick('15m'));
    ui.inputs.push('level:error');
    await manager.query();
    // The panel switches to the run the search made, not every run of the source, with its search.
    assert.equal(shown.length, 1);
    assert.match(shown[0], /^conn:app#[0-9a-f]{16}\?level:error$/);
    assert.deepEqual(
      store.all().map((event) => event.message),
      ['payment gateway timed out', 'card declined'],
    );
    ui.inputs.push('SELECT msg AS message FROM app_logs WHERE user_id = 7');
    await manager.runSql('raw');
    assert.equal(store.all().at(-1)?.message, 'payment gateway timed out');
    assert.equal(remote.last('raw')?.kind, 'sql');
    assert.match(shown.at(-1)!, /^conn:raw#[0-9a-f]{16}\?$/, 'the SQL chose the rows, so the search is cleared');
    ui.inputs.push('DELETE FROM app_logs');
    await manager.runSql('raw');
    assert.match(ui.messages.at(-1)!, /^error: SQLite · raw: Only SELECT queries can run here\./);
    ui.inputs.push(undefined);
    await manager.runSql('raw');
    await manager.tail('app', 'level:error');
    assert.equal(remote.tailing('app'), true);
    assert.match(shown.at(-1)!, /^conn:app#/);
    await manager.tail('app', 'level:error', true);
    assert.equal(remote.active, 1, 'one tail per connection');
    await manager.tail('app', '');
    assert.equal(remote.tailing('app'), false);
    await manager.test('app');
    assert.match(ui.messages.at(-1)!, /^info: SQLite · app: connected · SQLite \d+\.\d+\.\d+ · 1 table$/);
    await manager.fetch('missing', '', '1h');
    assert.match(ui.messages.at(-1)!, /no longer in logline\.connections/);
    manager.dispose();
  },
);

test('with no connections, commands offer to add one', async () => {
  reset();
  const { manager } = setup();
  await manager.test();
  assert.deepEqual(ui.messages, ['info: No connections yet.']);
  await manager.query();
  assert.equal(ui.messages.at(-1), 'info: No connection has logs to search.');
});

test('a refused Postgres login offers to save a password, which the next query uses', async () => {
  reset();
  const orders = {
    id: 'orders',
    label: 'orders',
    type: 'postgres',
    host: 'db',
    port: 5432,
    database: 'orders',
    user: 'dev',
  };
  raw.workspace = [orders];
  const { manager, secrets } = setup();
  const refused = Object.assign(new Error('password authentication failed for user "dev"'), { code: '28P01' });
  // Stand in for the database, which refuses the login.
  (manager as unknown as { connector: () => Promise<unknown> }).connector = async () => ({
    fetchLogs: async () => {
      throw refused;
    },
    runSql: async () => {
      throw refused;
    },
    test: async () => {
      throw refused;
    },
  });
  ui.errorChoice = 'Enter Password…';
  ui.inputs.push('s3cret');
  await manager.fetch('orders', '', '1h');
  assert.equal(
    ui.messages.at(-1),
    'error: Postgres · orders: the server needs a password for dev (password authentication failed for user "dev").',
  );
  assert.equal(secrets.get(secretKey(normalizeConnections([orders])[0] as PostgresConnection)), 's3cret');
  // Cancelling the password prompt keeps what was stored.
  ui.inputs.push(undefined);
  await manager.test('orders');
  assert.equal(secrets.size, 1);
  ui.errorChoice = undefined;
  await manager.runSql('orders').catch(() => undefined);
});

test('a Datadog connection is added with its keys, searched, and opened from a link with its trace', async () => {
  reset();
  const apiKey = ['dd', 'api'].join('-');
  const appKey = ['dd', 'app'].join('-');
  const now = Date.now();
  const log = (i: number, status: string, message: string, trace: string) => ({
    id: `log-${i}`,
    timestamp: new Date(now - (60 - i) * 60000).toISOString(),
    status,
    message,
    service: 'checkout',
    attributes: { dd: { trace_id: trace } },
  });
  const fake = await startFakeDatadog({
    apiKey,
    appKey,
    logs: [
      log(1, 'info', 'cart opened', 'trace-a'),
      log(2, 'error', 'payment gateway timed out', 'trace-a'),
      log(3, 'info', 'retrying payment', 'trace-a'),
      log(4, 'error', 'card declined', 'trace-bbbb'),
    ],
  });
  try {
    const { manager, store, secrets, shown, registry } = setup();
    ui.picks.push(pick('Datadog'), pick('Other…'), pick('API and application keys'));
    ui.inputs.push(fake.url, apiKey, appKey, 'prod');
    await manager.add();
    assert.deepEqual(raw.workspace, [{ id: 'prod', label: 'prod', type: 'datadog', site: fake.url }]);
    assert.deepEqual(JSON.parse(secrets.get(`logline.connection.datadog:${fake.url}`)!), { apiKey, appKey });
    assert.deepEqual(shown, ['conn:prod']);
    assert.deepEqual(manager.views()[0], {
      id: 'prod',
      sourceId: 'conn:prod',
      label: 'Datadog · prod',
      type: 'datadog',
      mapped: true,
      sql: false,
      watching: [],
      agents: false,
      tailing: false,
    });
    assert.deepEqual(await manager.preview('prod', 'level:error /x/', '1h'), {
      statement: 'status:(error)',
      local: ['/x/'],
    });
    await manager.fetch('prod', 'level:error', '24h');
    assert.deepEqual(
      store.all().map((event) => event.message),
      ['payment gateway timed out', 'card declined'],
    );
    // Run SQL is for databases only.
    await manager.runSql('prod');
    assert.equal(ui.messages.length, 1, 'no SQL prompt for Datadog');
    // A Log Explorer link: its search and range, then the trace of the log it points at.
    const link = `https://app.datadoghq.com/logs?query=${encodeURIComponent('status:error')}&event=log-2&from_ts=${now - 7200000}&to_ts=${now}`;
    await manager.openLink('prod', link);
    const runs = [...registry.records.values()].map((record) => record.command);
    assert.deepEqual(runs.slice(-2), ['Link: status:error', 'Trace trace-a']);
    const traceRun = [...registry.records.values()].at(-1)!;
    assert.deepEqual(
      store
        .all()
        .filter((event) => event.sessionId === traceRun.id)
        .map((event) => event.message),
      ['cart opened', 'payment gateway timed out', 'retrying payment'],
    );
    assert.equal(shown.at(-1), `conn:prod#${traceRun.id}?`, 'the link chose the logs, so the search is cleared');
    // A trace id on its own fetches the trace.
    await manager.openLink('prod', 'trace-bbbb');
    assert.equal([...registry.records.values()].at(-1)!.command, 'Trace trace-bbbb');
    // Keys Datadog refuses can be entered again, and the next search uses them.
    secrets.set(`logline.connection.datadog:${fake.url}`, JSON.stringify({ apiKey: 'old', appKey: 'old' }));
    raw.workspace = [{ id: 'prod', label: 'prod', type: 'datadog', site: fake.url, indexes: ['main'] }];
    manager.refresh();
    ui.errorChoice = 'Enter Keys…';
    ui.picks.push(pick('Access token'));
    ui.inputs.push('a-token');
    await manager.fetch('prod', '', '1h');
    assert.match(ui.messages.at(-1)!, /^error: Datadog · prod: Datadog refused the API or application key \(403/);
    assert.deepEqual(JSON.parse(secrets.get(`logline.connection.datadog:${fake.url}`)!), { token: 'a-token' });
    manager.dispose();
  } finally {
    await fake.close();
  }
});

test('a Datadog site that cannot be reached is reported and not saved', async () => {
  reset();
  const { manager } = setup();
  ui.picks.push(pick('Datadog'), pick('Other…'), pick('Access token'));
  ui.inputs.push('http://127.0.0.1:1', 'a-token');
  await manager.add();
  assert.equal(updates.length, 0);
  assert.match(ui.messages.at(-1)!, /^error: Could not connect: Could not reach Datadog/);
});

test('metric queries, name suggestions, watches, and windowed fetches go through the connection', async () => {
  reset();
  const now = Date.now();
  const fake = await startFakeDatadog({
    token: 'tok-metrics',
    series: [{ metric: 'latency', scope: 'env:prod', points: [[now - 60000, 120]] }],
    logs: [{ id: 'l1', timestamp: new Date(now - 90000).toISOString(), status: 'error', message: 'slow' }],
  });
  try {
    raw.workspace = [{ id: 'prod', label: 'prod', type: 'datadog', site: fake.url }];
    const { manager, secrets, registry, store, settings } = setup();
    secrets.set(`logline.connection.datadog:${fake.url}`, JSON.stringify({ token: 'tok-metrics' }));
    const answer = await manager.metricQuery('prod', 'avg:latency{*} by {env}', '1h');
    assert.deepEqual(answer.result?.series, [{ name: 'latency', scope: 'env:prod', points: [[now - 60000, 120]] }]);
    assert.ok(answer.result!.toMs - answer.result!.fromMs === 3600000);
    assert.deepEqual(await manager.metricNames('prod', 'lat'), ['latency']);
    assert.deepEqual(await manager.metricQuery('missing', 'x', '1h'), {
      error: 'That connection is no longer in logline.connections.',
    });
    // A window selected on the chart fetches the logs from exactly that time, named in the panel's time zone.
    await manager.fetch('prod', '', '1h', { fromMs: now - 120000, toMs: now - 60000 });
    const local = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
    const run = [...registry.records.values()].at(-1)!;
    assert.equal(run.command, `All rows · ${local(now - 120000)}–${local(now - 60000)}`);
    settings.timezone = 'utc';
    await manager.fetch('prod', '', '1h', { fromMs: now - 120000, toMs: now - 60000 });
    assert.match(
      [...registry.records.values()].at(-1)!.command ?? '',
      /^All rows · \d\d:\d\d:\d\d–\d\d:\d\d:\d\d UTC$/,
    );
    delete settings.timezone;
    assert.deepEqual(
      store.all().map((event) => event.message),
      ['slow', 'slow'],
      'each window fetch is its own run',
    );
    // Without a place to put watched metrics, Watch does nothing.
    await manager.watchMetric('prod', 'avg:latency{*}', true);
    assert.deepEqual(manager.views()[0].watching, []);
    manager.dispose();
  } finally {
    await fake.close();
  }
});

test('agents query only connections the person allowed, and their fetches are runs of their own', async () => {
  reset();
  const now = Date.now();
  const fake = await startFakeDatadog({
    token: 'tok-agents',
    logs: [
      {
        id: 'a',
        timestamp: new Date(now - 60000).toISOString(),
        status: 'error',
        message: 'declined',
        attributes: { dd: { trace_id: 'trace-xyz-1' } },
      },
      {
        id: 'b',
        timestamp: new Date(now - 50000).toISOString(),
        status: 'info',
        message: 'retry',
        attributes: { dd: { trace_id: 'trace-xyz-1' } },
      },
    ],
  });
  try {
    raw.workspace = [
      { id: 'prod', label: 'prod', type: 'datadog', site: fake.url },
      { id: 'raw', label: 'raw', type: 'sqlite', path: 'x.db' },
    ];
    const { manager, secrets, memento, registry } = setup();
    secrets.set(`logline.connection.datadog:${fake.url}`, JSON.stringify({ token: 'tok-agents' }));
    assert.deepEqual(manager.agentConnections(), [
      { id: 'prod', label: 'Datadog · prod', type: 'datadog', agents: false },
    ]);
    const refused = await manager.agentFetch({ connectionId: 'prod', query: '', range: '1h', limit: 10 });
    assert.equal(refused.error, 'Agents may not query this connection.');
    // Allowing asks first; cancelling allows nothing.
    ui.modal = undefined;
    await manager.allowAgents('prod');
    assert.equal(manager.agentConnections()[0].agents, false);
    ui.modal = 'Allow';
    await manager.allowAgents('prod');
    assert.equal(manager.views()[0].agents, true);
    // Kept by what the connection opens, not its id: another workspace's name for it is allowed too.
    assert.deepEqual(memento.get('logline.agentConnections.v1'), [`logline.connection.datadog:${fake.url}`]);
    const fetched = await manager.agentFetch({ connectionId: 'prod', query: 'level:error', range: '1h', limit: 10 });
    assert.deepEqual(
      [fetched.fetched, fetched.kept, fetched.label, fetched.sourceId],
      [1, 1, 'Datadog · prod', 'conn:prod'],
    );
    assert.equal(registry.records.get(fetched.sessionId!)?.command, 'Agent: level:error · last 1h');
    const trace = await manager.agentFetch({
      connectionId: 'prod',
      query: '',
      traceId: 'trace-xyz-1',
      range: '1h',
      limit: 10,
    });
    assert.equal(trace.kept, 2);
    assert.equal(trace.statement, 'trace_id:trace-xyz-1');
    assert.equal(registry.records.get(trace.sessionId!)?.command, 'Agent: trace trace-xyz-1 · last 1h');
    await manager.revokeAgents();
    assert.equal(manager.agentConnections()[0].agents, false);
    assert.deepEqual(memento.get('logline.agentConnections.v1'), []);
    manager.dispose();
  } finally {
    await fake.close();
  }
});

test('MySQL and MongoDB URLs are read the same way, and a MongoDB password never stays in the saved URL', () => {
  assert.deepEqual(parseServerUrl(['mysql://reader', 'pw@db.local/billing?ssl-mode=REQUIRED'].join(':'), 'mysql'), {
    connection: {
      id: 'draft',
      label: 'billing',
      type: 'mysql',
      host: 'db.local',
      port: 3306,
      database: 'billing',
      user: 'reader',
      ssl: true,
    },
    password: 'pw',
  });
  assert.equal(parseServerUrl('postgres://dev@db/orders', 'mysql'), undefined);
  const mongo = parseMongoUrl(['mongodb+srv://reader', 'p%40ss@cluster0.example.net/app?retryWrites=true'].join(':'));
  assert.deepEqual(mongo, {
    connection: {
      id: 'draft',
      label: 'app',
      type: 'mongodb',
      url: 'mongodb+srv://reader@cluster0.example.net/app?retryWrites=true',
      database: 'app',
    },
    password: 'p@ss',
  });
  assert.equal(parseMongoUrl('mongodb://reader@a:27017,b:27017/logs')?.connection.database, 'logs');
  assert.equal(parseMongoUrl('mongodb://reader@db'), undefined, 'a database is needed');
  assert.equal(parseMongoUrl('https://db/app'), undefined);
});

test('adding Aurora MySQL with an IAM token stores no password, and searches run as MySQL', async () => {
  reset();
  const { manager, secrets, store } = setup();
  const queries: string[] = [];
  const passwords: unknown[] = [];
  const at = new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19);
  // Stand in for the server: a MySQL that has one log table.
  (manager as unknown as { driver: (connection: unknown, password?: string) => Promise<unknown> }).driver = async (
    _connection,
    password,
  ) => {
    passwords.push(password);
    return {
      dialect: 'mysql',
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('VERSION()')) return [{ v: '8.0.36' }];
        if (sql.includes('information_schema.tables')) return [{ t: 'app_logs' }];
        if (sql.includes('information_schema.columns'))
          return [
            { name: 'created_at', type: 'datetime' },
            { name: 'severity', type: 'varchar' },
            { name: 'msg', type: 'text' },
          ];
        if (sql.startsWith('SELECT * FROM `app_logs`'))
          return [{ created_at: at, severity: 'ERROR', msg: 'payment gateway timed out' }];
        return [];
      },
      close: async () => undefined,
    };
  };
  ui.picks.push(pick('MySQL'), pick('AWS IAM token'), pick('Default credentials'), pick('app_logs'), pick(/Use these/));
  ui.inputs.push('mysql://app@billing.cluster-c9.us-east-1.rds.amazonaws.com/billing', 'Billing');
  await manager.add();
  assert.deepEqual(raw.workspace, [
    {
      id: 'billing',
      label: 'Billing',
      type: 'mysql',
      host: 'billing.cluster-c9.us-east-1.rds.amazonaws.com',
      port: 3306,
      database: 'billing',
      user: 'app',
      ssl: true,
      auth: { kind: 'iam' },
      logs: { table: 'app_logs', timestamp: 'created_at', level: 'severity', message: 'msg' },
    },
  ]);
  assert.equal(secrets.size, 0, 'an IAM connection keeps no secret');
  assert.deepEqual(passwords, [undefined]);
  assert.match(ui.messages.at(-1)!, /Added MySQL · Billing/);

  await manager.fetch('billing', 'level:error', '1h');
  const search = queries.find((sql) => sql.startsWith('SELECT * FROM `app_logs`'))!;
  assert.match(
    search,
    /WHERE `created_at` BETWEEN \? AND \? AND LOWER\(CAST\(`severity` AS CHAR\)\) LIKE \? ESCAPE '!'/,
  );
  assert.ok(
    store.all().some((event) => event.message === 'payment gateway timed out'),
    'the fetched row is a log event',
  );
  // A host outside AWS signs in with a password, which is kept in secret storage.
  ui.picks.push(pick('MySQL'), pick('No log table'));
  ui.inputs.push('mysql://reader@db.local/billing', 'pw', 'Local billing');
  await manager.add();
  assert.equal(secrets.get('logline.connection.mysql://reader@db.local:3306/billing'), 'pw');
  assert.match(ui.messages.at(-1)!, /Use Run SQL in the Logs panel/);
  manager.dispose();
});

test('adding MongoDB moves the password out of the URL and can use _id as the time', async () => {
  reset();
  const { manager, secrets } = setup();
  let password: string | undefined;
  (manager as unknown as { probe: (connection: unknown, password?: string) => Promise<unknown> }).probe = async (
    _connection,
    given,
  ) => {
    password = given;
    return {
      test: async () => 'MongoDB 7.0.4 · 1 collection',
      tables: async () => ['events'],
      columns: async () => [
        { name: '_id', type: 'objectId' },
        { name: 'level', type: 'string' },
        { name: 'msg', type: 'string' },
      ],
      dispose: async () => undefined,
    };
  };
  ui.picks.push(pick('MongoDB'), pick('events'), pick(/Use these/));
  ui.inputs.push(['mongodb+srv://reader', 'p%40ss@cluster0.example.net/app'].join(':'), 'Events');
  await manager.add();
  assert.equal(password, 'p@ss');
  assert.deepEqual(raw.workspace, [
    {
      id: 'events',
      label: 'Events',
      type: 'mongodb',
      url: 'mongodb+srv://reader@cluster0.example.net/app',
      database: 'app',
      logs: { table: 'events', timestamp: '_id', level: 'level', message: 'msg' },
    },
  ]);
  assert.equal(secrets.get('logline.connection.mongodb://reader@cluster0.example.net/app'), 'p@ss');
  // A URL without the database is refused at the prompt, so nothing is added.
  ui.picks.push(pick('MongoDB'));
  ui.inputs.push('mongodb://reader@db');
  await manager.add();
  assert.equal(raw.workspace?.length, 1);
  manager.dispose();
});
