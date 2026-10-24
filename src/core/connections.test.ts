import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  connectionIdOf,
  connectionLabel,
  connectionSourceId,
  normalizeConnections,
  rangeMs,
  secretKey,
  suggestMapping,
} from './connections';
import { normalizeSetting } from './settings';

test('connections keep well-formed entries and drop malformed ones and repeated ids', () => {
  const connections = normalizeConnections([
    { id: 'app', type: 'sqlite', path: 'data/app.db', logs: { table: 'logs', timestamp: 'ts', level: 'severity' } },
    { id: 'orders', label: 'Orders', type: 'postgres', database: 'orders', user: 'dev', port: 6543, ssl: true },
    { id: 'app', type: 'sqlite', path: 'other.db' },
    { id: 'no-path', type: 'sqlite' },
    { id: 'no-user', type: 'postgres', database: 'x' },
    { id: 'mysql', type: 'mysql', path: 'x' },
    { type: 'sqlite', path: 'x.db' },
    'not an object',
    ['nor', 'an', 'array'],
    { id: 'bad-mapping', type: 'sqlite', path: 'x.db', logs: { table: 'logs' } },
    { id: 'bad-port', type: 'postgres', database: 'x', user: 'y', port: 70000, timestampFormat: 'x' },
  ]);
  assert.deepEqual(connections, [
    {
      id: 'app',
      label: 'app',
      type: 'sqlite',
      path: 'data/app.db',
      logs: { table: 'logs', timestamp: 'ts', level: 'severity' },
    },
    {
      id: 'orders',
      label: 'Orders',
      type: 'postgres',
      host: 'localhost',
      port: 6543,
      database: 'orders',
      user: 'dev',
      ssl: true,
    },
    // A mapping without a time column is ignored; the connection stays for typed SQL.
    { id: 'bad-mapping', label: 'bad-mapping', type: 'sqlite', path: 'x.db' },
    { id: 'bad-port', label: 'bad-port', type: 'postgres', host: 'localhost', port: 5432, database: 'x', user: 'y' },
  ]);
  assert.deepEqual(normalizeConnections('nope'), []);
  assert.deepEqual(normalizeSetting('connections', [{ id: 'a', type: 'sqlite', path: 'a.db' }], []), [
    { id: 'a', label: 'a', type: 'sqlite', path: 'a.db' },
  ]);
  assert.equal(normalizeSetting('connectionMaxRows', 10, 5000), 100);
  assert.equal(normalizeSetting('connectionTimeoutSeconds', 2.7, 10), 2);
});

test('connection sources, labels, ranges and secret keys', () => {
  assert.equal(connectionSourceId('app'), 'conn:app');
  assert.equal(connectionIdOf('conn:app'), 'app');
  assert.equal(connectionIdOf('file:/x'), undefined);
  assert.equal(connectionIdOf(undefined), undefined);
  assert.equal(connectionLabel({ type: 'sqlite', label: 'app' }), 'SQLite · app');
  assert.equal(connectionLabel({ type: 'postgres', label: 'orders' }), 'Postgres · orders');
  assert.equal(rangeMs('15m'), 900000);
  assert.equal(rangeMs('7d'), 604800000);
  assert.equal(rangeMs('constructor'), undefined);
  assert.equal(rangeMs('2h'), undefined);
  // The same database shares a password across workspaces, whatever each calls it.
  const base = { type: 'postgres' as const, host: 'db', port: 5432, database: 'orders', user: 'dev' };
  assert.equal(secretKey({ ...base, id: 'a', label: 'A' }), secretKey({ ...base, id: 'b', label: 'B' }));
  assert.notEqual(
    secretKey({ ...base, id: 'a', label: 'A' }),
    secretKey({ ...base, id: 'a', label: 'A', user: 'admin' }),
  );
});

test('a mapping is suggested from column names, each column used once', () => {
  assert.deepEqual(
    suggestMapping([
      { name: 'id', type: 'INTEGER' },
      { name: 'created_at', type: 'TEXT' },
      { name: 'severity', type: 'TEXT' },
      { name: 'msg', type: 'TEXT' },
      { name: 'app', type: 'TEXT' },
      { name: 'trace_id', type: 'TEXT' },
    ]),
    { timestamp: 'created_at', level: 'severity', message: 'msg', service: 'app', traceId: 'trace_id' },
  );
  // Without a time-like name, any date or time column is the timestamp.
  assert.deepEqual(
    suggestMapping([
      { name: 'when_it_happened', type: 'timestamp with time zone' },
      { name: 'text', type: 'text' },
    ]),
    { timestamp: 'when_it_happened', message: 'text' },
  );
  assert.deepEqual(suggestMapping([{ name: 'value', type: 'REAL' }]), {});
});

test('MySQL and MongoDB connections are kept, IAM sign-in turns on TLS, and each keeps its secret by what it opens', async () => {
  const { isRdsHost, mongoUrl, rdsRegion } = await import('./connections.js');
  const [billing, aurora, events, badMongo] = normalizeConnections([
    { id: 'billing', type: 'mysql', host: 'db', database: 'billing', user: 'reader' },
    {
      id: 'aurora',
      type: 'postgres',
      host: 'orders.cluster-c9.us-east-1.rds.amazonaws.com',
      database: 'orders',
      user: 'app',
      auth: { kind: 'iam', profile: 'prod', region: 'nowhere' },
    },
    { id: 'events', type: 'mongodb', url: 'mongodb+srv://reader@cluster0.example.net/app?retryWrites=true' },
    { id: 'secret', type: 'mongodb', url: 'mongodb://reader:hunter2@db/app' },
  ]);
  assert.deepEqual(billing, {
    id: 'billing',
    label: 'billing',
    type: 'mysql',
    host: 'db',
    port: 3306,
    database: 'billing',
    user: 'reader',
  });
  assert.deepEqual(aurora, {
    id: 'aurora',
    label: 'aurora',
    type: 'postgres',
    host: 'orders.cluster-c9.us-east-1.rds.amazonaws.com',
    port: 5432,
    database: 'orders',
    user: 'app',
    ssl: true,
    auth: { kind: 'iam', profile: 'prod' },
  });
  assert.deepEqual(events, {
    id: 'events',
    label: 'events',
    type: 'mongodb',
    url: 'mongodb+srv://reader@cluster0.example.net/app?retryWrites=true',
    database: 'app',
  });
  assert.equal(badMongo, undefined, 'a URL with a password is refused');
  assert.equal(connectionLabel(billing), 'MySQL · billing');
  assert.equal(connectionLabel(events), 'MongoDB · events');
  assert.equal(secretKey(billing as never), 'logline.connection.mysql://reader@db:3306/billing');
  assert.equal(secretKey(events as never), 'logline.connection.mongodb://reader@cluster0.example.net/app');
  assert.equal(isRdsHost('orders.cluster-c9.us-east-1.rds.amazonaws.com'), true);
  assert.equal(isRdsHost('db.example.com'), false);
  assert.equal(rdsRegion('billing.cluster-ro-c9.eu-central-1.rds.amazonaws.com'), 'eu-central-1');
  assert.equal(mongoUrl('https://example.com'), undefined);
});
