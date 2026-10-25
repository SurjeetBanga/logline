import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MysqlConnection } from '../../core/connections';
import { MysqlDriver } from './mysql-driver';

type Failure = Error & { code?: string; errno?: number; fatal?: boolean };

function fakeMysql(behaviour: { fail?: (sql: string) => Failure | undefined; connectError?: Failure } = {}) {
  const log: string[] = [];
  const configs: Record<string, unknown>[] = [];
  let connections = 0;
  const createConnection = (config: Record<string, unknown>) => {
    connections++;
    configs.push(config);
    log.push(
      `connect ${String(config.user)}@${String(config.host)}:${String(config.port)}/${String(config.database)} ${String(config.password)}`,
    );
    return {
      on() {},
      query(options: { sql: string; values?: unknown[] }, callback: (error: Failure | null, rows: unknown) => void) {
        log.push(options.values?.length ? `${options.sql} ${JSON.stringify(options.values)}` : options.sql);
        const error =
          (options.sql.startsWith('SET time_zone') && behaviour.connectError) || behaviour.fail?.(options.sql);
        setImmediate(() =>
          error ? callback(error, undefined) : callback(null, options.sql.startsWith('SELECT') ? [{ n: '3' }] : []),
        );
      },
      end(callback?: () => void) {
        log.push('end');
        callback?.();
      },
      destroy() {},
    };
  };
  return { log, configs, connections: () => connections, load: () => ({ createConnection }) as never };
}

const mysql: MysqlConnection = {
  id: 'billing',
  label: 'billing',
  type: 'mysql',
  host: 'db',
  port: 3306,
  database: 'billing',
  user: 'reader',
};

test('MySQL queries run read-only, in UTC, with a time limit, on one connection', async () => {
  const fake = fakeMysql();
  const driver = new MysqlDriver(mysql, 'secret', fake.load);
  assert.deepEqual(await driver.query('SELECT ?', ['x'], { timeoutMs: 2500 }), [{ n: '3' }]);
  await driver.query('SELECT 2', [], { timeoutMs: 2500 });
  await driver.query('SELECT 3', [], { timeoutMs: 4000 });
  assert.deepEqual(fake.log, [
    'connect reader@db:3306/billing secret',
    "SET time_zone = '+00:00'",
    'SET SESSION max_execution_time = 2500',
    'START TRANSACTION READ ONLY',
    "SELECT 'x'",
    'ROLLBACK',
    // The session keeps its limit until the setting changes.
    'START TRANSACTION READ ONLY',
    'SELECT 2',
    'ROLLBACK',
    'SET SESSION max_execution_time = 4000',
    'START TRANSACTION READ ONLY',
    'SELECT 3',
    'ROLLBACK',
  ]);
  const config = fake.configs[0];
  assert.equal(config.dateStrings, true, 'times stay text, read as UTC');
  assert.equal(config.multipleStatements, false);
  assert.equal(config.ssl, undefined);
  await driver.close();
  assert.equal(fake.log.at(-1), 'end');
});

test('IAM sign-in asks for a new token per connection and only sends it over TLS with the RDS certificates', async () => {
  const fake = fakeMysql();
  let tokens = 0;
  const driver = new MysqlDriver(
    { ...mysql, host: 'billing.cluster-c9.us-east-1.rds.amazonaws.com', ssl: true, auth: { kind: 'iam' } },
    async () => `token-${++tokens}`,
    fake.load,
  );
  await driver.query('SELECT 1', [], { timeoutMs: 1000 });
  const config = fake.configs[0] as {
    password: string;
    ssl: { ca: string[]; rejectUnauthorized: boolean };
    authPlugins: Record<string, () => () => Buffer>;
  };
  assert.equal(config.password, 'token-1');
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.ok(config.ssl.ca.length > 10, 'Amazon RDS certificates are trusted');
  assert.equal(config.authPlugins.mysql_clear_password()().toString(), 'token-1\0');
  await driver.close();
  await driver.query('SELECT 1', [], { timeoutMs: 1000 });
  assert.equal(fake.configs.at(-1)!.password, 'token-2', 'a new connection signs a new token');
});

test('MariaDB’s time limit is used when MySQL’s is missing, and timeouts and broken connections are handled', async () => {
  let mode: 'ok' | 'timeout' | 'syntax' | 'broken' = 'ok';
  const fake = fakeMysql({
    fail: (sql) =>
      sql.startsWith('SET SESSION max_execution_time')
        ? Object.assign(new Error('Unknown system variable'), { errno: 1193, fatal: false })
        : !sql.startsWith('SELECT')
          ? undefined
          : mode === 'timeout'
            ? Object.assign(new Error('Query execution was interrupted'), { errno: 1969, fatal: false })
            : mode === 'syntax'
              ? Object.assign(new Error('You have an error in your SQL syntax'), {
                  code: 'ER_PARSE_ERROR',
                  fatal: false,
                })
              : mode === 'broken'
                ? Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })
                : undefined,
  });
  const driver = new MysqlDriver(mysql, undefined, fake.load);
  await driver.query('SELECT 1', [], { timeoutMs: 2000 });
  assert.ok(fake.log.includes('SET SESSION max_statement_time = 2'), 'MariaDB counts in seconds');
  mode = 'syntax';
  await assert.rejects(driver.query('SELECT bad', [], { timeoutMs: 2000 }), /SQL syntax/);
  assert.equal(fake.connections(), 1, 'a query error keeps the connection');
  mode = 'broken';
  await assert.rejects(driver.query('SELECT 1', [], { timeoutMs: 2000 }), /Connection lost/);
  mode = 'timeout';
  await assert.rejects(driver.query('SELECT SLEEP(9)', [], { timeoutMs: 2000 }), /longer than 2 s and was stopped/);
  mode = 'ok';
  await driver.query('SELECT 1', [], { timeoutMs: 2000 });
  assert.ok(fake.connections() >= 2, 'a broken connection is opened again');
  await assert.rejects(driver.query('SELECT 1', [], { timeoutMs: 1000, signal: AbortSignal.abort() }), /cancelled/);
});

test('typed MySQL runs as written, capped by the server row limit, which is reset afterwards', async () => {
  const fake = fakeMysql();
  const driver = new MysqlDriver(mysql, 'secret', fake.load);
  await driver.query('SELECT a.id, b.id FROM a JOIN b ON a.id = b.id', [], { timeoutMs: 1000, maxRows: 5 });
  assert.deepEqual(fake.log.slice(-5), [
    'SET SESSION sql_select_limit = 5',
    'START TRANSACTION READ ONLY',
    'SELECT a.id, b.id FROM a JOIN b ON a.id = b.id',
    'ROLLBACK',
    'SET SESSION sql_select_limit = DEFAULT',
  ]);
  await driver.close();
});
