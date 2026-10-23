import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConnectionConfig, PostgresConnection } from '../../core/connections';
import { PostgresDriver } from './postgres-driver';
import { SqlConnector } from './sql';
import { openSqlite, SqliteCliDriver, SqliteProcessDriver } from './sqlite-driver';
import type { SqlDriver } from './types';

const hasSqlite = isBuiltin('node:sqlite');
const hasCli = spawnSync('sqlite3', ['-version']).status === 0;
const BASE = Date.parse('2026-10-23T09:00:00Z');

type Sqlite = { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };

/** A database with five log rows a minute apart, the errors at minutes 1, 3 and 4. */
function logDatabase(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'logline-sql-')), 'app.db');
  const { DatabaseSync } = require('node:sqlite') as Sqlite;
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE app_logs (id INTEGER PRIMARY KEY, created_at TEXT, severity TEXT, msg TEXT, user_id INTEGER);
    CREATE TABLE events (ts INTEGER, level TEXT, message TEXT);
    INSERT INTO app_logs (created_at, severity, msg, user_id) VALUES
      ('2026-10-23 09:00:00', 'INFO', 'started', 1),
      ('2026-10-23 09:01:00', 'ERROR', 'payment gateway timed out', 42),
      ('2026-10-23 09:02:00', 'INFO', 'retrying', 42),
      ('2026-10-23 09:03:00', 'ERROR', 'payment gateway timed out', 7),
      ('2026-10-23 09:04:00', 'ERROR', 'card declined', 42);
    INSERT INTO events VALUES (${BASE}, 'warn', 'slow'), (${BASE + 60000}, 'error', 'failed');
  `);
  db.close();
  return file;
}

const connection = (file: string): ConnectionConfig => ({
  id: 'app',
  label: 'app',
  type: 'sqlite',
  path: file,
  logs: { table: 'app_logs', timestamp: 'created_at', level: 'severity', message: 'msg' },
});

test(
  'a mapped SQLite table is searched over a range, newest first, with a count of every match',
  { skip: !hasSqlite },
  async () => {
    const file = logDatabase();
    const connector = new SqlConnector(connection(file), new SqliteProcessDriver(file), () => 5000);
    try {
      assert.match(await connector.test(), /^SQLite \d+\.\d+\.\d+ · 2 tables$/);
      assert.deepEqual(await connector.tables(), ['app_logs', 'events']);
      assert.deepEqual(
        (await connector.columns('app_logs')).map((column) => column.name),
        ['id', 'created_at', 'severity', 'msg', 'user_id'],
      );
      const result = await connector.fetchLogs({
        query: 'level:error user_id:42',
        fromMs: BASE,
        toMs: BASE + 10 * 60000,
        limit: 1,
        order: 'desc',
        countTotal: true,
      });
      assert.equal(result.records.length, 1);
      assert.equal(result.total, 2);
      assert.deepEqual(JSON.parse(result.records[0].line), {
        timestamp: '2026-10-23T09:04:00.000Z',
        level: 'ERROR',
        message: 'card declined',
        id: 5,
        user_id: 42,
      });
      assert.equal(result.records[0].timeMs, BASE + 4 * 60000);
      assert.deepEqual(result.pushed, ['level:error', 'user_id:42']);
      // The range applies: nothing after 09:02 is in this one.
      const early = await connector.fetchLogs({
        query: '',
        fromMs: BASE,
        toMs: BASE + 2 * 60000,
        limit: 10,
        order: 'asc',
      });
      assert.deepEqual(
        early.records.map((record) => JSON.parse(record.line).message),
        ['started', 'payment gateway timed out', 'retrying'],
      );
      const preview = await connector.preview('/time.?out/ level:error', BASE, BASE + 1);
      assert.deepEqual(preview.local, ['/time.?out/']);
      assert.match(preview.statement, /^SELECT \* FROM "app_logs" WHERE julianday/);
    } finally {
      await connector.dispose();
    }
  },
);

test('epoch time columns are detected and searched in their unit', { skip: !hasSqlite }, async () => {
  const file = logDatabase();
  const connector = new SqlConnector(
    { id: 'e', label: 'e', type: 'sqlite', path: file, logs: { table: 'events', timestamp: 'ts' } },
    openSqlite(file),
    () => 5000,
  );
  try {
    const result = await connector.fetchLogs({
      query: 'level:error',
      fromMs: BASE,
      toMs: BASE + 60000,
      limit: 10,
      order: 'asc',
    });
    assert.deepEqual(
      result.records.map((record) => record.timeMs),
      [BASE + 60000],
    );
    assert.equal(JSON.parse(result.records[0].line).timestamp, '2026-10-23T09:01:00.000Z');
  } finally {
    await connector.dispose();
  }
});

test('typed SQL runs read-only, one statement, with its rows mapped by name', { skip: !hasSqlite }, async () => {
  const file = logDatabase();
  const driver = new SqliteProcessDriver(file);
  const connector = new SqlConnector(connection(file), driver, () => 5000);
  try {
    const result = await connector.runSql(
      "SELECT created_at AS time, severity AS level, msg AS message FROM app_logs WHERE severity = 'ERROR' ORDER BY id;",
      2,
    );
    assert.deepEqual(
      result.records.map((record) => [record.timeMs, JSON.parse(record.line).message]),
      [
        [BASE + 60000, 'payment gateway timed out'],
        [BASE + 3 * 60000, 'payment gateway timed out'],
      ],
    );
    await assert.rejects(connector.runSql('DELETE FROM app_logs', 10), /Only SELECT queries/);
    await assert.rejects(connector.runSql('SELECT 1; DROP TABLE app_logs', 10), /one statement/);
    // The database itself is open read-only, whatever reaches it.
    await assert.rejects(driver.query('DELETE FROM app_logs', [], { timeoutMs: 5000 }), /readonly/);
    assert.equal((await driver.query('SELECT COUNT(*) AS n FROM app_logs', [], { timeoutMs: 5000 }))[0].n, 5);
  } finally {
    await connector.dispose();
  }
});

test('a query that runs too long is stopped, and the next query still works', { skip: !hasSqlite }, async () => {
  const file = logDatabase();
  const driver = new SqliteProcessDriver(file);
  try {
    await assert.rejects(
      driver.query('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT COUNT(*) FROM n', [], {
        timeoutMs: 200,
      }),
      /longer than 200 ms and was stopped/,
    );
    const abort = new AbortController();
    const cancelled = driver.query(
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT COUNT(*) FROM n',
      [],
      {
        timeoutMs: 60000,
        signal: abort.signal,
      },
    );
    abort.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.deepEqual(await driver.query('SELECT 1 AS one', [], { timeoutMs: 5000 }), [{ one: 1 }]);
  } finally {
    await driver.close();
  }
});

test('mapping problems are reported in words a person can act on', { skip: !hasSqlite }, async () => {
  const file = logDatabase();
  const make = (logs?: ConnectionConfig['logs']) =>
    new SqlConnector(
      { id: 'x', label: 'x', type: 'sqlite', path: file, logs },
      new SqliteProcessDriver(file),
      () => 5000,
    );
  const request = { query: '', limit: 1, order: 'desc' as const };
  for (const [logs, message] of [
    [undefined, /Map a log table/],
    [{ table: 'nope', timestamp: 'ts' }, /Table nope was not found/],
    [{ table: 'app_logs', timestamp: 'nope' }, /Column nope is not in app_logs/],
  ] as const) {
    const connector = make(logs);
    await assert.rejects(connector.fetchLogs(request), message);
    await connector.dispose();
  }
});

test(
  'the sqlite3 command stands in for runtimes without built-in SQLite',
  { skip: !hasSqlite || !hasCli },
  async () => {
    const file = logDatabase();
    const connector = new SqlConnector(connection(file), new SqliteCliDriver(file), () => 5000);
    try {
      const result = await connector.fetchLogs({
        query: 'msg:"timed out"',
        fromMs: BASE,
        toMs: BASE + 10 * 60000,
        limit: 10,
        order: 'asc',
        countTotal: true,
      });
      assert.deepEqual(
        result.records.map((record) => record.timeMs),
        [BASE + 60000, BASE + 3 * 60000],
      );
      // Quotes and line breaks in values reach the database intact, as parameters.
      const driver = new SqliteCliDriver(file);
      assert.deepEqual(
        await driver.query('SELECT ? AS a, ? AS b, ? AS c', ["it's", 'two\nlines', 3], { timeoutMs: 5000 }),
        [{ a: "it's", b: 'two\nlines', c: 3 }],
      );
      assert.deepEqual(await driver.query('SELECT 1 WHERE 0', [], { timeoutMs: 5000 }), []);
      await assert.rejects(driver.query('DELETE FROM app_logs', [], { timeoutMs: 5000 }), /readonly/);
    } finally {
      await connector.dispose();
    }
  },
);

test('without built-in SQLite or the sqlite3 command, the error says what to install', async () => {
  const driver = new SqliteCliDriver(join(tmpdir(), 'missing.db'), 'logline-no-such-sqlite3');
  await assert.rejects(
    driver.query('SELECT 1', [], { timeoutMs: 5000 }),
    /no built-in SQLite and the sqlite3 command was not found/,
  );
});

/** A stand-in for pg's Client that records what it was asked. */
function fakePg(behaviour: { fail?: (sql: string) => Error | undefined; connectError?: Error } = {}) {
  const log: string[] = [];
  let clients = 0;
  class Client {
    constructor(readonly config: Record<string, unknown>) {
      clients++;
      log.push(
        `connect ${String(config.user)}@${String(config.host)}:${String(config.port)}/${String(config.database)} ${String(config.password)}`,
      );
    }
    on() {}
    async connect() {
      if (behaviour.connectError) throw behaviour.connectError;
    }
    async query(sql: string, params?: unknown[]) {
      log.push(params?.length ? `${sql} ${JSON.stringify(params)}` : sql);
      const error = behaviour.fail?.(sql);
      if (error) throw error;
      return { rows: sql.startsWith('SELECT') ? [{ n: '3' }] : [] };
    }
    async end() {
      log.push('end');
    }
  }
  return { log, clients: () => clients, load: () => ({ Client }) as never };
}

const postgres: PostgresConnection = {
  id: 'orders',
  label: 'orders',
  type: 'postgres',
  host: 'db',
  port: 5432,
  database: 'orders',
  user: 'dev',
};

test('Postgres queries run in a read-only transaction with a statement timeout, on one connection', async () => {
  const pg = fakePg();
  const driver: SqlDriver = new PostgresDriver(postgres, 'secret', pg.load);
  assert.deepEqual(await driver.query('SELECT $1', ['x'], { timeoutMs: 2500 }), [{ n: '3' }]);
  await driver.query('SELECT 2', [], { timeoutMs: 2500 });
  assert.deepEqual(pg.log, [
    'connect dev@db:5432/orders secret',
    'BEGIN READ ONLY',
    'SET LOCAL statement_timeout = 2500',
    'SELECT $1 ["x"]',
    'ROLLBACK',
    'BEGIN READ ONLY',
    'SET LOCAL statement_timeout = 2500',
    'SELECT 2',
    'ROLLBACK',
  ]);
  await driver.close();
  assert.equal(pg.log.at(-1), 'end');
});

test('Postgres errors: timeouts are explained, and a broken connection is replaced', async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { severity: 'ERROR' });
  const syntax = Object.assign(new Error('syntax error at or near "SELEC"'), { severity: 'ERROR' });
  let mode: 'timeout' | 'syntax' | 'broken' | 'ok' = 'timeout';
  const pg = fakePg({
    fail: (sql) =>
      !sql.startsWith('SELECT')
        ? undefined
        : mode === 'timeout'
          ? timeout
          : mode === 'syntax'
            ? syntax
            : mode === 'broken'
              ? new Error('Connection terminated')
              : undefined,
  });
  const driver = new PostgresDriver(postgres, undefined, pg.load);
  await assert.rejects(driver.query('SELECT pg_sleep(9)', [], { timeoutMs: 1000 }), /longer than 1 s and was stopped/);
  mode = 'syntax';
  await assert.rejects(driver.query('SELECT bad', [], { timeoutMs: 1000 }), /syntax error/);
  assert.equal(pg.clients(), 1, 'a database error keeps the connection');
  mode = 'broken';
  await assert.rejects(driver.query('SELECT 1', [], { timeoutMs: 1000 }), /Connection terminated/);
  mode = 'ok';
  await driver.query('SELECT 1', [], { timeoutMs: 1000 });
  assert.equal(pg.clients(), 2, 'a broken connection is opened again');
  const refused = fakePg({ connectError: new Error('connect ECONNREFUSED') });
  const offline = new PostgresDriver(postgres, undefined, refused.load);
  await assert.rejects(offline.query('SELECT 1', [], { timeoutMs: 1000 }), /ECONNREFUSED/);
  await assert.rejects(offline.query('SELECT 1', [], { timeoutMs: 1000 }), /ECONNREFUSED/);
  assert.equal(refused.clients(), 2, 'a failed connect is retried on the next query');
  await assert.rejects(driver.query('SELECT 1', [], { timeoutMs: 1000, signal: AbortSignal.abort() }), /cancelled/);
});
