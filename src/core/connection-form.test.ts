import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  keepUnmodeled,
  applyUrl,
  draftFromConnection,
  draftUrl,
  emptyDraft,
  normalizeDraft,
  normalizeMapping,
  readDraft,
  sampleText,
  suggestedLabel,
  suggestsIam,
  type FormDraft,
} from './connection-form';
import { normalizeConnections, type ConnectionConfig } from './connections';

const secret = (name: string) => ['s3', name, '1234'].join('-');

const postgres: ConnectionConfig = {
  id: 'pg',
  label: 'Orders',
  type: 'postgres',
  host: 'db.example.com',
  port: 6543,
  user: 'dev',
  database: 'orders',
  ssl: true,
  auth: { kind: 'iam', profile: 'work' },
};
const mysql: ConnectionConfig = {
  id: 'my',
  label: 'Shop',
  type: 'mysql',
  host: 'mysql.local',
  port: 3306,
  user: 'root',
  database: 'shop',
};
const mongo: ConnectionConfig = {
  id: 'mg',
  label: 'Events',
  type: 'mongodb',
  url: 'mongodb+srv://dev@cluster.example.net/events?retryWrites=true',
  database: 'events',
};
const sqlite: ConnectionConfig = { id: 'sq', label: 'Local', type: 'sqlite', path: 'data/app.db' };
const datadog: ConnectionConfig = { id: 'dd', label: 'Prod', type: 'datadog', site: 'datadoghq.eu' };

test('emptyDraft uses the default port of each type', () => {
  assert.equal(emptyDraft().type, 'postgres');
  assert.equal(emptyDraft('postgres').port, '5432');
  assert.equal(emptyDraft('mysql').port, '3306');
  assert.equal(emptyDraft('mongodb').port, '5432');
  assert.equal(emptyDraft('datadog').site, 'datadoghq.com');
  assert.equal(emptyDraft('postgres').auth, 'password');
});

test('draftFromConnection spreads each connection type over the form fields', () => {
  const pg = draftFromConnection(postgres);
  assert.deepEqual(
    { host: pg.host, port: pg.port, user: pg.user, database: pg.database, ssl: pg.ssl, auth: pg.auth },
    { host: 'db.example.com', port: '6543', user: 'dev', database: 'orders', ssl: true, auth: 'iam' },
  );
  assert.equal(pg.profile, 'work');
  assert.equal(pg.label, 'Orders');
  assert.equal(pg.password, '');

  const my = draftFromConnection(mysql);
  assert.equal(my.type, 'mysql');
  assert.equal(my.auth, 'password');
  assert.equal(my.ssl, false);
  assert.equal(my.profile, '');

  assert.equal(draftFromConnection(mongo).url, mongo.type === 'mongodb' ? mongo.url : '');
  assert.equal(draftFromConnection(sqlite).path, 'data/app.db');
  assert.equal(draftFromConnection(datadog).site, 'datadoghq.eu');
});

test('readDraft(draftFromConnection(c)) gives back an equivalent connection', () => {
  for (const connection of [postgres, mysql, mongo, sqlite, datadog]) {
    const draft = draftFromConnection(connection);
    const result = readDraft(draft, { secret: true });
    assert.deepEqual(result.errors, {}, connection.type);
    assert.deepEqual(result.connection, { ...connection, id: 'draft', label: 'draft' }, connection.type);
  }
});

test('readDraft names missing server fields', () => {
  const result = readDraft({ ...emptyDraft(), host: ' ', user: '', database: '' });
  assert.deepEqual(Object.keys(result.errors).sort(), ['database', 'host', 'user']);
  assert.equal(result.connection, undefined);
});

test('readDraft rejects ports outside 1 to 65535 and non-numbers', () => {
  const ok = { ...emptyDraft(), user: 'u', database: 'd' };
  for (const port of ['0', '70000', 'abc', '', '1.5', '-1']) {
    const result = readDraft({ ...ok, port });
    assert.ok(result.errors.port, port);
    assert.equal(result.connection, undefined, port);
  }
  for (const port of ['1', '65535']) assert.deepEqual(readDraft({ ...ok, port }).errors, {}, port);
});

test('readDraft checks MongoDB URLs', () => {
  const draft = emptyDraft('mongodb');
  assert.ok(readDraft(draft).errors.url);
  assert.ok(readDraft({ ...draft, url: 'mongodb://dev@host' }).errors.database?.includes('database'));
  assert.ok(readDraft({ ...draft, url: 'mongodb://dev:pw@host/app' }).errors.url);
  assert.ok(readDraft({ ...draft, url: 'http://host/app' }).errors.url);
  const good = readDraft({ ...draft, url: ' mongodb://dev@host/app ' });
  assert.deepEqual(good.errors, {});
  assert.equal(good.connection?.type === 'mongodb' && good.connection.database, 'app');
});

test('readDraft requires a SQLite path', () => {
  assert.ok(readDraft(emptyDraft('sqlite')).errors.path);
  const result = readDraft({ ...emptyDraft('sqlite'), path: ' a/b.db ' });
  assert.deepEqual(result.connection, { id: 'draft', label: 'draft', type: 'sqlite', path: 'a/b.db' });
});

test('readDraft checks the Datadog site and requires keys unless saved', () => {
  const draft = emptyDraft('datadog');
  assert.ok(readDraft({ ...draft, site: 'example.com' }).errors.site);
  assert.ok(readDraft({ ...draft, site: 'http://example.com' }).errors.site);
  assert.deepEqual(Object.keys(readDraft(draft).errors).sort(), ['apiKey', 'appKey']);
  assert.deepEqual(readDraft(draft, { secret: true }).errors, {});
  assert.equal(readDraft(draft, { secret: true }).keys, undefined);

  const apiKey = secret('api');
  const appKey = secret('app');
  assert.deepEqual(Object.keys(readDraft({ ...draft, apiKey }, { secret: true }).errors), ['appKey']);
  assert.deepEqual(readDraft({ ...draft, apiKey: ` ${apiKey} `, appKey }).keys, { apiKey, appKey });

  const token = secret('token');
  const kind = { ...draft, keyKind: 'token' as const };
  assert.ok(readDraft(kind).errors.token);
  assert.deepEqual(readDraft(kind, { secret: true }).errors, {});
  assert.deepEqual(readDraft({ ...kind, token }).keys, { token });
});

test('readDraft makes IAM sign-in use TLS and records the profile', () => {
  const base = { ...emptyDraft(), user: 'u', database: 'd', ssl: false };
  const iam = readDraft({ ...base, auth: 'iam', profile: 'work' });
  assert.deepEqual(iam.errors, {});
  assert.equal(iam.connection?.type === 'postgres' && iam.connection.ssl, true);
  assert.deepEqual(iam.connection?.type === 'postgres' && iam.connection.auth, { kind: 'iam', profile: 'work' });
  const noProfile = readDraft({ ...base, auth: 'iam' });
  assert.deepEqual(noProfile.connection?.type === 'postgres' && noProfile.connection.auth, { kind: 'iam' });
  const plain = readDraft(base);
  assert.equal(plain.connection?.type === 'postgres' && plain.connection.auth, undefined);
  assert.equal(plain.connection?.type === 'postgres' && plain.connection.ssl, undefined);
});

test('readDraft returns a password only for servers that use one', () => {
  const password = secret('password');
  const server = { ...emptyDraft(), user: 'u', database: 'd', password };
  assert.equal(readDraft(server).password, password);
  assert.equal(readDraft({ ...server, type: 'mysql' }).password, password);
  assert.equal(readDraft({ ...emptyDraft('mongodb'), url: 'mongodb://u@h/app', password }).password, password);
  assert.equal(readDraft({ ...emptyDraft('sqlite'), path: 'a.db', password }).password, undefined);
  assert.equal(readDraft({ ...emptyDraft('datadog'), password }, { secret: true }).password, undefined);
  assert.equal(readDraft({ ...server, password: '' }).password, undefined);
});

test('readDraft ignores the label', () => {
  const draft = draftFromConnection(postgres);
  const first = readDraft(draft);
  const renamed = readDraft({ ...draft, label: 'Something else' });
  assert.equal(JSON.stringify(first.connection), JSON.stringify(renamed.connection));
  assert.equal(first.connection?.label, 'draft');
});

test('applyUrl spreads a Postgres URL over the fields and moves its password', () => {
  const password = secret('pw');
  const draft = emptyDraft();
  const next = applyUrl(draft, `postgres://dev:${password}@db.example.com:6543/orders?sslmode=require`);
  assert.ok(next);
  assert.deepEqual(
    { host: next.host, port: next.port, user: next.user, database: next.database, ssl: next.ssl },
    { host: 'db.example.com', port: '6543', user: 'dev', database: 'orders', ssl: true },
  );
  assert.equal(next.password, password);
  assert.equal(next.url, '');
  const noPassword = applyUrl({ ...draft, password: 'typed' }, 'postgresql://dev@h/orders');
  assert.equal(noPassword?.password, 'typed');
  assert.equal(noPassword?.ssl, false);
  assert.equal(noPassword?.port, '5432');
});

test('applyUrl uses the MySQL default port', () => {
  const next = applyUrl(emptyDraft('mysql'), 'mysql://root@h/shop');
  assert.equal(next?.port, '3306');
  assert.equal(next?.database, 'shop');
  assert.equal(applyUrl(emptyDraft('mysql'), 'postgres://u@h/d'), undefined);
});

test('applyUrl strips a MongoDB password from the URL', () => {
  const password = secret('mongo');
  const next = applyUrl(emptyDraft('mongodb'), `mongodb://dev:${password}@host/app?tls=true`);
  assert.equal(next?.url, 'mongodb://dev@host/app?tls=true');
  assert.equal(next?.password, password);
  assert.equal(applyUrl(emptyDraft('mongodb'), 'mongodb://dev@host/app')?.password, '');
});

test('applyUrl returns undefined for invalid input and for other types', () => {
  assert.equal(applyUrl(emptyDraft(), 'not a url'), undefined);
  assert.equal(applyUrl(emptyDraft(), 'postgres://dev@host'), undefined);
  assert.equal(applyUrl(emptyDraft('mongodb'), 'mongodb://'), undefined);
  assert.equal(applyUrl(emptyDraft('sqlite'), 'postgres://u@h/d'), undefined);
  assert.equal(applyUrl(emptyDraft('datadog'), 'postgres://u@h/d'), undefined);
});

test('draftUrl omits default ports and adds the TLS query of each dialect', () => {
  const pg: FormDraft = { ...emptyDraft(), host: 'h', user: 'u', database: 'd' };
  assert.equal(draftUrl(pg), 'postgres://u@h/d');
  assert.equal(draftUrl({ ...pg, port: '6543' }), 'postgres://u@h:6543/d');
  assert.equal(draftUrl({ ...pg, ssl: true }), 'postgres://u@h/d?sslmode=require');
  assert.equal(draftUrl({ ...pg, auth: 'iam' }), 'postgres://u@h/d?sslmode=require');
  const my: FormDraft = { ...pg, type: 'mysql', port: '3306' };
  assert.equal(draftUrl(my), 'mysql://u@h/d');
  assert.equal(draftUrl({ ...my, port: '5432' }), 'mysql://u@h:5432/d');
  assert.equal(draftUrl({ ...my, ssl: true }), 'mysql://u@h/d?ssl-mode=REQUIRED');
});

test('draftUrl encodes the user and database and falls back to the default port', () => {
  const pg: FormDraft = { ...emptyDraft(), host: ' h ', user: 'a b@c', database: 'x/y?z' };
  assert.equal(draftUrl(pg), 'postgres://a%20b%40c@h/x%2Fy%3Fz');
  assert.equal(draftUrl({ ...pg, port: 'abc' }), 'postgres://a%20b%40c@h/x%2Fy%3Fz');
  assert.equal(draftUrl({ ...pg, type: 'mysql', port: '' }), 'mysql://a%20b%40c@h/x%2Fy%3Fz');
});

test('draftUrl is empty while the draft is incomplete', () => {
  const pg: FormDraft = { ...emptyDraft(), host: 'h', user: 'u', database: 'd' };
  assert.equal(draftUrl({ ...pg, host: ' ' }), '');
  assert.equal(draftUrl({ ...pg, user: '' }), '');
  assert.equal(draftUrl({ ...pg, database: '' }), '');
});

test('suggestedLabel names a connection after what it opens', () => {
  assert.equal(suggestedLabel({ ...emptyDraft(), database: ' orders ' }), 'orders');
  assert.equal(suggestedLabel({ ...emptyDraft('mysql'), database: 'shop' }), 'shop');
  assert.equal(suggestedLabel({ ...emptyDraft('mongodb'), url: 'mongodb://h/events' }), 'events');
  assert.equal(suggestedLabel(emptyDraft('mongodb')), '');
  assert.equal(suggestedLabel(emptyDraft('datadog')), 'prod');
  const file = (path: string) => suggestedLabel({ ...emptyDraft('sqlite'), path });
  assert.equal(file('data/app.db'), 'app');
  assert.equal(file('C:\\work\\logs.sqlite'), 'logs');
  assert.equal(file('/x/y/z.SQLITE3'), 'z');
  assert.equal(file('a.db3'), 'a');
  assert.equal(file('plain'), 'plain');
  assert.equal(file(''), '');
});

test('suggestsIam is true for RDS and Aurora hosts of Postgres and MySQL', () => {
  const host = 'mydb.abc123.us-east-1.rds.amazonaws.com';
  assert.equal(suggestsIam({ ...emptyDraft(), host }), true);
  assert.equal(suggestsIam({ ...emptyDraft('mysql'), host: ` ${host} ` }), true);
  assert.equal(suggestsIam({ ...emptyDraft(), host: 'localhost' }), false);
  assert.equal(suggestsIam({ ...emptyDraft('mongodb'), host }), false);
});

test('normalizeDraft rejects values that are not drafts', () => {
  for (const value of [null, undefined, 'x', 3, [], {}, { type: 'oracle' }])
    assert.equal(normalizeDraft(value), undefined);
});

test('normalizeDraft keeps fields of the right type and drops the rest', () => {
  const draft = normalizeDraft({
    type: 'mysql',
    host: 'h',
    port: 3307,
    user: 'u',
    ssl: 'yes',
    database: 'x'.repeat(4097),
    path: 'p'.repeat(4096),
    extra: 'ignored',
  });
  assert.equal(draft?.type, 'mysql');
  assert.equal(draft?.host, 'h');
  assert.equal(draft?.port, '3306');
  assert.equal(draft?.user, 'u');
  assert.equal(draft?.ssl, false);
  assert.equal(draft?.database, '');
  assert.equal(draft?.path.length, 4096);
  assert.equal('extra' in (draft ?? {}), false);
});

test('normalizeDraft resets unknown auth and key kinds', () => {
  const bad = normalizeDraft({ type: 'postgres', auth: 'kerberos', keyKind: 'cert' });
  assert.equal(bad?.auth, 'password');
  assert.equal(bad?.keyKind, 'keys');
  const good = normalizeDraft({ type: 'postgres', auth: 'iam', keyKind: 'token' });
  assert.equal(good?.auth, 'iam');
  assert.equal(good?.keyKind, 'token');
});

test('normalizeMapping checks a mapping against the table columns', () => {
  const columns = ['ts', 'lvl', 'msg'];
  assert.equal(normalizeMapping(null, columns), null);
  assert.equal(normalizeMapping(undefined, columns), undefined);
  assert.equal(normalizeMapping('x', columns), undefined);
  assert.equal(normalizeMapping({ timestamp: 'ts' }, columns), undefined);
  assert.equal(normalizeMapping({ table: '', timestamp: 'ts' }, columns), undefined);
  assert.equal(normalizeMapping({ table: 't', timestamp: 'missing' }, columns), undefined);
  assert.deepEqual(
    normalizeMapping({ table: 't', timestamp: 'ts', level: 'lvl', message: 'nope', service: 3, other: 'msg' }, columns),
    { table: 't', timestamp: 'ts', level: 'lvl' },
  );
});

test('sampleText turns every value into short text', () => {
  const rows = sampleText([
    {
      none: null,
      missing: undefined,
      n: 5,
      b: true,
      date: new Date('2026-01-02T03:04:05.000Z'),
      bad: new Date(NaN),
      obj: { a: 1, big: 10n },
      list: [1, 2],
    },
  ]);
  assert.deepEqual(rows, [
    {
      none: '',
      missing: '',
      n: '5',
      b: 'true',
      date: '2026-01-02T03:04:05.000Z',
      bad: '',
      obj: '{"a":1,"big":"10"}',
      list: '[1,2]',
    },
  ]);
});

test('sampleText truncates long values with an ellipsis at the limit', () => {
  const [row] = sampleText([{ s: 'a'.repeat(300), exact: 'b'.repeat(10) }], 10);
  assert.equal(row?.s, `${'a'.repeat(9)}…`);
  assert.equal(row?.exact, 'b'.repeat(10));
  assert.equal(sampleText([{ s: 'a'.repeat(500) }])[0]?.s.length, 120);
});

test('a MongoDB database can be set apart from its URL, which may name only where to sign in', () => {
  const saved = normalizeConnections([
    { id: 'm', label: 'm', type: 'mongodb', url: 'mongodb://reader@host/?authSource=admin', database: 'app' },
  ])[0];
  const draft = draftFromConnection(saved);
  assert.equal(draft.database, 'app');
  const read = readDraft(draft);
  assert.deepEqual(read.errors, {});
  assert.equal(read.connection?.type === 'mongodb' && read.connection.database, 'app');
  assert.equal(suggestedLabel(draft), 'app');
  // One whose database is the URL's own keeps the field empty, and the URL decides.
  const plain = normalizeConnections([{ id: 'p', label: 'p', type: 'mongodb', url: 'mongodb://h/events' }])[0];
  assert.equal(draftFromConnection(plain).database, '');
  // A URL without a database is taken, its password moved out; the database is then asked for.
  const secret = ['s3', 'cret'].join('');
  const moved = applyUrl(emptyDraft('mongodb'), `mongodb://reader:${secret}@host/?authSource=admin`)!;
  assert.equal(moved.url, 'mongodb://reader@host/?authSource=admin');
  assert.equal(moved.password, secret);
  assert.ok(readDraft(moved).errors.database);
});

test('keepUnmodeled keeps what the form does not show from the connection an edit replaces', () => {
  const [datadog, iam, other] = normalizeConnections([
    { id: 'd', label: 'd', type: 'datadog', site: 'datadoghq.com', indexes: ['main', 'audit'] },
    {
      id: 'i',
      label: 'i',
      type: 'postgres',
      host: 'h',
      database: 'd',
      user: 'u',
      auth: { kind: 'iam', profile: 'prod', region: 'eu-west-1' },
    },
    { id: 'o', label: 'o', type: 'sqlite', path: 'x.db' },
  ]);
  const fromForm = (connection: typeof datadog) =>
    readDraft(draftFromConnection(connection), { secret: true }).connection!;
  assert.deepEqual(keepUnmodeled(fromForm(datadog), datadog), { ...datadog, id: 'draft', label: 'draft' });
  assert.deepEqual(keepUnmodeled(fromForm(iam), iam), { ...iam, id: 'draft', label: 'draft' });
  // Switching to a password drops the IAM settings; a new connection and other types are left alone.
  const password = readDraft({ ...draftFromConnection(iam), auth: 'password' }).connection!;
  assert.equal('auth' in keepUnmodeled(password, iam), false);
  const fresh = fromForm(datadog);
  assert.equal(keepUnmodeled(fresh), fresh);
  assert.deepEqual(keepUnmodeled(fromForm(other), datadog), fromForm(other));
});
