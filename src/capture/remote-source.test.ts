import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { LogStore } from '../core/log-store';
import type { FetchRequest, FetchResult, RemoteConnector, RemoteRecord } from './connectors/types';
import { Ingestion } from './ingestion';
import { RemoteSource, type RemoteTarget } from './remote-source';
import { RuntimeState } from './runtime-state';
import { SessionRegistry } from './session-registry';

const BASE = Date.parse('2026-10-23T09:00:00Z');
const row = (minute: number, level: string, message: string): RemoteRecord => ({
  line: JSON.stringify({ timestamp: new Date(BASE + minute * 60000).toISOString(), level, message }),
  timeMs: BASE + minute * 60000,
});
const result = (records: RemoteRecord[], extra: Partial<FetchResult> = {}): FetchResult => ({
  records,
  pushed: [],
  local: [],
  statement: 'SELECT …',
  elapsedMs: 12,
  ...extra,
});

function setup(settings: Record<string, unknown> = {}) {
  const store = new LogStore(1000);
  const registry = new SessionRegistry();
  const ingestion = new Ingestion(store, () => {
    throw new Error('fetched rows are never written to disk');
  });
  const state = new RuntimeState(() => undefined);
  const config = {
    get: <T>(key: string, fallback: T): T => (Object.hasOwn(settings, key) ? (settings[key] as T) : fallback),
  };
  const remote = new RemoteSource(config, registry, ingestion, state);
  const target = (connector: RemoteConnector): RemoteTarget => ({
    id: 'app',
    sourceId: 'conn:app',
    label: 'SQLite · app',
    connector,
  });
  const messages = () => store.all().map((event) => event.message);
  return { store, registry, state, remote, target, messages };
}

afterEach(() => mock.timers.reset());

test('a fetch keeps the rows that match the whole search, oldest first, in a run of its own', async () => {
  const { remote, target, registry, state, store, messages } = setup({ connectionMaxRows: 300 });
  const requests: FetchRequest[] = [];
  const connector: RemoteConnector = {
    async fetchLogs(request) {
      requests.push(request);
      // Newest first, as a search returns them; the database could not apply the regex.
      return result([row(3, 'error', 'timeout'), row(2, 'info', 'ok'), row(1, 'error', 'time out')], {
        total: 10,
        pushed: ['level:error'],
        local: ['/time.?out/'],
      });
    },
  };
  const started: string[] = [];
  const info = await remote.fetch(target(connector), {
    query: 'level:error /time.?out/',
    fromMs: BASE,
    toMs: BASE + 3600000,
    title: 'level:error /time.?out/ · last 1h',
    started: (sessionId) => {
      // Called before the query runs, so the panel can show the run as its rows arrive.
      assert.equal(requests.length, 0);
      started.push(sessionId);
    },
  });
  assert.deepEqual(started, [info.sessionId]);
  assert.equal(typeof requests[0].firstPage, 'function');
  assert.deepEqual(
    requests.map(({ firstPage: _, ...request }) => request),
    [
      {
        query: 'level:error /time.?out/',
        fromMs: BASE,
        toMs: BASE + 3600000,
        limit: 300,
        order: 'desc',
        countTotal: true,
      },
    ],
  );
  assert.deepEqual(messages(), ['time out', 'timeout']);
  assert.deepEqual(
    store.all().map((event) => [event.serverId, event.server, event.stream, event.timestampMs]),
    [
      ['conn:app', 'SQLite · app', 'remote', BASE + 60000],
      ['conn:app', 'SQLite · app', 'remote', BASE + 180000],
    ],
  );
  assert.equal(info.running, false);
  assert.equal(info.fetched, 3);
  assert.equal(info.kept, 2);
  assert.equal(info.total, 10);
  assert.deepEqual(info.local, ['/time.?out/']);
  assert.equal(remote.last('app'), info);
  const record = registry.records.get(info.sessionId)!;
  assert.equal(record.sourceKind, 'remote');
  assert.equal(record.status, 'exited');
  assert.equal(record.exitReason, '2 rows');
  assert.equal(record.events, 2);
  assert.equal(record.command, 'level:error /time.?out/ · last 1h');
  assert.equal(state.status, 'Fetched 2 rows from SQLite · app');
  assert.equal(remote.active, 0);
});

test('typed SQL keeps its own row order and filter; a store without SQL says so', async () => {
  const { remote, target, messages } = setup();
  const rows = [row(5, 'info', 'b'), row(1, 'info', 'a')];
  const info = await remote.fetch(
    target({
      fetchLogs: async () => assert.fail('a typed query does not search'),
      runSql: async (sql, limit) => {
        assert.equal(sql, 'SELECT * FROM logs ORDER BY id DESC');
        assert.equal(limit, 5000);
        return result(rows);
      },
    }),
    { query: 'ignored', sql: 'SELECT * FROM logs ORDER BY id DESC', title: 'SQL' },
  );
  assert.equal(info.kind, 'sql');
  assert.deepEqual(messages(), ['b', 'a']);
  const failed = await remote.fetch(target({ fetchLogs: async () => result([]) }), {
    query: '',
    sql: 'SELECT 1',
    title: 'SQL',
  });
  assert.equal(failed.error, 'SQLite · app does not run SQL.');
});

test('a failed fetch is a failed run that says why', async () => {
  const { remote, target, registry, state } = setup();
  const info = await remote.fetch(
    target({
      fetchLogs: async () => {
        throw new Error('no such table: app_logs');
      },
    }),
    { query: '', title: 'All rows · last 1h' },
  );
  assert.equal(info.error, 'no such table: app_logs');
  const record = registry.records.get(info.sessionId)!;
  assert.equal(record.status, 'failed');
  assert.equal(record.captureReason, 'no such table: app_logs');
  assert.equal(state.status, 'SQLite · app: no such table: app_logs');
});

test('stopping a fetch cancels the query and keeps none of its rows', async () => {
  const { remote, target, registry, messages } = setup();
  let release!: (value: FetchResult) => void;
  let signal: AbortSignal | undefined;
  const pending = remote.fetch(
    target({
      fetchLogs: (_request, abort) => {
        signal = abort;
        return new Promise((resolve) => (release = resolve));
      },
    }),
    { query: '', title: 'All rows' },
  );
  const [sessionId] = [...registry.records.keys()];
  assert.equal(remote.active, 1);
  remote.stopSessionById(sessionId);
  assert.equal(signal?.aborted, true);
  release(result([row(1, 'info', 'late')]));
  const info = await pending;
  assert.deepEqual(messages(), []);
  assert.equal(info.running, false);
  assert.equal(registry.records.get(sessionId)!.exitReason, 'stopped');
});

test('a tail shows the newest rows, then only rows it has not shown, and survives a failed read', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target, registry, messages } = setup({ connectionPollSeconds: 1 });
  const requests: FetchRequest[] = [];
  const reads: (() => FetchResult)[] = [
    // The newest rows, newest first.
    () => result([row(2, 'info', 'two'), row(1, 'info', 'one')]),
    // Forward from the last time seen: that row again, a new row at the same time, and a later one.
    () => result([row(2, 'info', 'two'), row(2, 'info', 'two again'), row(3, 'error', 'three')]),
    () => {
      throw new Error('database is locked');
    },
    () => result([row(3, 'error', 'three'), row(4, 'error', 'four')]),
  ];
  const connector: RemoteConnector = {
    async fetchLogs(request) {
      requests.push(request);
      return reads.shift()!();
    },
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const sessionId = remote.tail(target(connector), 'level:error OR level:info', 'Tail: all rows');
  await settle();
  assert.equal(remote.tailing('app'), true);
  assert.deepEqual(messages(), ['one', 'two']);
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(messages(), ['one', 'two', 'two again', 'three']);
  mock.timers.tick(1000);
  await settle();
  const record = registry.records.get(sessionId)!;
  assert.equal(record.captureStatus, 'interrupted');
  assert.equal(record.captureReason, 'database is locked');
  assert.equal(remote.last('app')?.error, 'database is locked');
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(messages(), ['one', 'two', 'two again', 'three', 'four']);
  assert.equal(record.captureStatus, 'streaming');
  assert.equal(remote.last('app')?.error, undefined);
  assert.deepEqual(
    requests.map((request) => [request.fromMs, request.order, request.limit]),
    [
      [undefined, 'desc', 200],
      [BASE + 120000, 'asc', 5000],
      [BASE + 180000, 'asc', 5000],
      [BASE + 180000, 'asc', 5000],
    ],
  );
  remote.stopTails('app');
  assert.equal(remote.tailing('app'), false);
  assert.equal(record.status, 'exited');
  assert.equal(record.exitReason, 'stopped tailing');
  mock.timers.tick(5000);
  await settle();
  assert.equal(requests.length, 4, 'a stopped tail reads no more');
});

test('a tail of an empty table starts now, and removing a connection stops its runs', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target, registry } = setup();
  const requests: FetchRequest[] = [];
  const connector: RemoteConnector = {
    async fetchLogs(request) {
      requests.push(request);
      return result([]);
    },
  };
  const before = Date.now();
  const sessionId = remote.tail(target(connector), '', 'Tail');
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(2000);
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok((requests[1].fromMs ?? 0) >= before);
  remote.stopConnection('app');
  assert.equal(registry.records.get(sessionId)!.status, 'exited');
  assert.equal(remote.last('app'), undefined);
  remote.tail(target(connector), '', 'Tail');
  await remote.dispose();
  assert.equal(remote.active, 0);
});

test('clearing logs forgets finished results but not a running tail', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target } = setup();
  await remote.fetch(target({ fetchLogs: async () => result([row(1, 'info', 'a')]) }), {
    query: '',
    title: 'All rows',
  });
  remote.clearResults();
  assert.equal(remote.last('app'), undefined);
  remote.tail(target({ fetchLogs: async () => result([]) }), '', 'Tail');
  remote.clearResults();
  assert.equal(remote.last('app')?.kind, 'tail');
  await remote.dispose();
});

test('a tail of a store that indexes late reads back over the lag and shows each log once', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target, messages } = setup({ connectionPollSeconds: 1 });
  const requests: FetchRequest[] = [];
  const reads: RemoteRecord[][] = [
    [row(10, 'info', 'ten')],
    // A log from minute 9.5 became searchable only now, after one from minute 11.
    [row(10, 'info', 'ten'), { ...row(9, 'info', 'late'), timeMs: BASE + 570000 }, row(11, 'info', 'eleven')],
    [row(11, 'info', 'eleven')],
  ];
  const connector: RemoteConnector = {
    tailLagMs: 120000,
    async fetchLogs(request) {
      requests.push(request);
      return result(reads.shift() ?? []);
    },
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  remote.tail(target(connector), '', 'Tail');
  await settle();
  mock.timers.tick(1000);
  await settle();
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(messages(), ['ten', 'late', 'eleven']);
  assert.deepEqual(
    requests.map((request) => request.fromMs),
    [undefined, BASE + 600000 - 120000, BASE + 660000 - 120000],
  );
  await remote.dispose();
});

test('a tail that reads a full page continues from its last row instead of reading the same rows again', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target, messages } = setup({ connectionPollSeconds: 1, connectionMaxRows: 2 });
  const requests: FetchRequest[] = [];
  // More rows within the lag than one read returns.
  const rows = [row(10, 'info', 'a'), row(11, 'info', 'b'), row(12, 'info', 'c'), row(13, 'info', 'd')];
  const connector: RemoteConnector = {
    tailLagMs: 600000,
    async fetchLogs(request) {
      requests.push(request);
      if (request.order === 'desc') return result([rows[1], rows[0]]);
      return result(rows.filter((one) => one.timeMs! >= request.fromMs!).slice(0, request.limit));
    },
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  remote.tail(target(connector), '', 'Tail');
  await settle();
  for (let poll = 0; poll < 3; poll++) {
    mock.timers.tick(1000);
    await settle();
  }
  assert.deepEqual(messages(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    requests.map((request) => request.fromMs),
    [undefined, BASE + 660000 - 600000, BASE + 660000, BASE + 720000],
  );
  await remote.dispose();
});

test('a tail of a store that limits searches reads less often, and waits when told to', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: BASE });
  const { remote, target, registry } = setup({ connectionPollSeconds: 1 });
  let reads = 0;
  let limited = true;
  const connector: RemoteConnector = {
    tailPollMs: 15000,
    async fetchLogs() {
      reads++;
      if (reads === 2 && limited) {
        limited = false;
        throw Object.assign(new Error('rate limit'), { retryAfterMs: 40000 });
      }
      return result([]);
    },
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const id = remote.tail(target(connector), '', 'Tail');
  await settle();
  mock.timers.tick(14000);
  await settle();
  assert.equal(reads, 1, 'not read again before 15 s');
  mock.timers.tick(1000);
  await settle();
  assert.equal(reads, 2);
  assert.equal(registry.records.get(id)?.captureStatus, 'interrupted');
  // The next two polls fall within the 40 s the store asked for.
  mock.timers.tick(30000);
  await settle();
  assert.equal(reads, 2);
  mock.timers.tick(15000);
  await settle();
  assert.equal(reads, 3);
  assert.equal(registry.records.get(id)?.captureStatus, 'streaming');
  await remote.dispose();
});

test('a tail reads at the pace its store sets before each read, and says what it follows', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: BASE });
  const { remote, target } = setup({ connectionPollSeconds: 1 });
  let reads = 0;
  const connector = {
    tailPollMs: 10000,
    async fetchLogs() {
      reads++;
      // The store's answer allows reading faster from now on.
      connector.tailPollMs = 3000;
      return result([]);
    },
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  const id = remote.tail(target(connector), 'service:api', 'Tail: service:api');
  await settle();
  assert.deepEqual(remote.tailOf('app'), { query: 'service:api', native: false });
  assert.equal(remote.last('app')?.query, 'service:api');
  mock.timers.tick(9000);
  await settle();
  assert.equal(reads, 1, 'the first read set the next one 10 s out');
  mock.timers.tick(1000);
  await settle();
  assert.equal(reads, 2);
  mock.timers.tick(3000);
  await settle();
  assert.equal(reads, 3, 'then every 3 s');
  remote.stopTails('app');
  assert.equal(remote.tailOf('app'), undefined);
  remote.forgetRun(id);
  assert.equal(remote.last('app'), undefined, 'a removed run is no longer the latest');
  await remote.dispose();
});

test('a tail reads back only as far as its store has been late, and further once it is late again', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target, messages } = setup({ connectionPollSeconds: 1 });
  const requests: FetchRequest[] = [];
  let minute = 10;
  const connector: RemoteConnector = {
    tailLagMs: 60000,
    async fetchLogs(request) {
      requests.push(request);
      // One new row a minute, on time, until one arrives 20 s behind the newest.
      minute++;
      if (minute === 18) return result([{ ...row(16, 'info', 'late'), timeMs: BASE + 16 * 60000 + 40000 }]);
      return result([row(minute, 'info', `row ${minute}`)]);
    },
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  remote.tail(target(connector), '', 'Tail');
  await settle();
  for (let poll = 0; poll < 8; poll++) {
    mock.timers.tick(1000);
    await settle();
  }
  const back = requests.slice(1).map((request, i) => BASE + (11 + i) * 60000 - request.fromMs!);
  // The whole minute until five reads have shown rows on time, then 15 s, then twice the 20 s one row was late.
  assert.deepEqual(back.slice(0, 6), [60000, 60000, 60000, 60000, 60000, 15000]);
  // The late row left the newest at minute 17.
  assert.equal(requests.at(-1)!.fromMs, BASE + 17 * 60000 - 40000);
  assert.ok(messages().includes('late'));
  await remote.dispose();
});

test('a tail of a query in the store’s syntax sends it as typed and keeps every row it returns', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { remote, target, messages } = setup({ connectionPollSeconds: 1 });
  const requests: FetchRequest[] = [];
  const connector: RemoteConnector = {
    async fetchLogs(request) {
      requests.push(request);
      return result([row(1, 'info', 'kept')]);
    },
  };
  remote.tail(target(connector), 'level:error', 'Tail', 'service:(a OR b)');
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].native, 'service:(a OR b)');
  assert.deepEqual(messages(), ['kept'], 'the filter does not apply to a query typed for the store');
  assert.deepEqual(remote.tailOf('app'), { query: 'service:(a OR b)', native: true });
  assert.equal(remote.last('app')?.native, true);
  await remote.dispose();
});

test('a search shows its first page early, then its rows in order, and says where the time went', async () => {
  const { remote, target, store, messages, state } = setup({ datadogMaxRows: 4, connectionMaxRows: 300 });
  const generation = state.generation;
  let shownEarly: unknown[] = [];
  const connector: RemoteConnector = {
    async fetchLogs(request) {
      assert.equal(request.limit, 4, 'the connection’s own row limit');
      // Newest first: the first page, then the rest, which are older.
      request.firstPage!([row(4, 'info', 'four'), row(3, 'info', 'three')]);
      await new Promise((resolve) => setImmediate(resolve));
      shownEarly = messages();
      return result([row(4, 'info', 'four'), row(3, 'info', 'three'), row(2, 'info', 'two'), row(1, 'info', 'one')]);
    },
  };
  const info = await remote.fetch(
    { ...target(connector), maxRowsSetting: 'datadogMaxRows' },
    { query: '', title: 'All' },
  );
  assert.deepEqual(shownEarly, ['three', 'four']);
  assert.deepEqual(messages(), ['one', 'two', 'three', 'four'], 'oldest first, each once');
  assert.equal(store.all().length, 4);
  assert.equal(info.kept, 4);
  assert.equal(typeof info.firstMs, 'number');
  assert.equal(typeof info.processMs, 'number');
  assert.ok(state.generation > generation, 'the view starts over with the run in order');
});

test('a newer search replaces one still running, and drops what it showed', async () => {
  const { remote, target, registry, messages } = setup();
  let release!: () => void;
  const slow: RemoteConnector = {
    async fetchLogs(request) {
      request.firstPage?.([row(9, 'info', 'old')]);
      await new Promise<void>((resolve) => (release = resolve));
      return result([row(9, 'info', 'old')]);
    },
  };
  const first = remote.fetch(target(slow), { query: '', title: 'Old' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages(), ['old']);
  const oldId = remote.last('app')!.sessionId;
  remote.cancelFetches('app');
  release();
  await first;
  assert.deepEqual(messages(), []);
  assert.equal(registry.records.has(oldId), false);
  await remote.fetch(target({ fetchLogs: async () => result([row(1, 'info', 'new')]) }), { query: '', title: 'New' });
  assert.deepEqual(messages(), ['new']);
});
