import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogTableMapping } from './connections';
import { matchesQuery } from './query';
import { parseLogLine } from './log-event';
import {
  buildSqlLogQuery,
  checkReadOnlySql,
  limitedSql,
  rangedSql,
  quoteTable,
  rowFilter,
  rowRoles,
  valueEncoding,
  rowToLine,
  timeValueMs,
  type SqlLogRequest,
  type TableInfo,
} from './remote-query';

const mapping: LogTableMapping = { table: 'app_logs', timestamp: 'created_at', level: 'severity', message: 'msg' };
const table: TableInfo = {
  time: 'iso',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'created_at', type: 'TEXT' },
    { name: 'severity', type: 'TEXT' },
    { name: 'msg', type: 'TEXT' },
    { name: 'user_id', type: 'INTEGER' },
    { name: 'status', type: 'TEXT' },
  ],
};
const FROM = Date.parse('2026-10-23T09:00:00.000Z');
const TO = Date.parse('2026-10-23T10:00:00.000Z');
const build = (query: string, overrides: Partial<SqlLogRequest> = {}) =>
  buildSqlLogQuery({ dialect: 'sqlite', mapping, table, query, limit: 500, order: 'desc', ...overrides });
const like = (column: string) => `LOWER(CAST("${column}" AS TEXT)) LIKE ? ESCAPE '\\'`;

test('a field term becomes a parameterized condition on its mapped column, within the range', () => {
  const built = build('level:error', { fromMs: FROM, toMs: TO });
  assert.equal(
    built.select.sql,
    `SELECT * FROM "app_logs" WHERE julianday("created_at") BETWEEN julianday(?) AND julianday(?) AND ${like('severity')} ORDER BY "created_at" DESC LIMIT ?`,
  );
  assert.deepEqual(built.select.params, ['2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z', '%error%', 500]);
  // The count covers the same rows, without the limit.
  assert.equal(
    built.count.sql,
    `SELECT COUNT(*) AS n FROM "app_logs" WHERE julianday("created_at") BETWEEN julianday(?) AND julianday(?) AND ${like('severity')}`,
  );
  assert.deepEqual(built.count.params, built.select.params.slice(0, -1));
  assert.deepEqual(built.pushed, ['level:error']);
  assert.deepEqual(built.local, []);
});

test('Postgres gets numbered placeholders and compares time as timestamptz', () => {
  const native = buildSqlLogQuery({
    dialect: 'postgres',
    mapping: { ...mapping, table: 'public.app_logs' },
    table: { ...table, time: 'native' },
    query: 'msg:timeout',
    fromMs: FROM,
    toMs: TO,
    limit: 10,
    order: 'asc',
  });
  assert.equal(
    native.select.sql,
    `SELECT * FROM "public"."app_logs" WHERE "created_at" BETWEEN CAST($1 AS timestamptz) AND CAST($2 AS timestamptz) AND LOWER(CAST("msg" AS TEXT)) LIKE $3 ESCAPE '\\' ORDER BY "created_at" ASC LIMIT $4`,
  );
  // Time kept as text is cast before it is compared.
  const text = buildSqlLogQuery({
    dialect: 'postgres',
    mapping,
    table,
    query: '',
    fromMs: FROM,
    limit: 1,
    order: 'asc',
  });
  assert.match(text.select.sql, /WHERE CAST\("created_at" AS timestamptz\) >= CAST\(\$1 AS timestamptz\)/);
});

test('epoch columns compare numbers in their own unit', () => {
  const seconds = build('', { table: { ...table, time: 'epoch_s' }, fromMs: FROM, toMs: TO });
  assert.match(seconds.select.sql, /WHERE "created_at" BETWEEN \? AND \?/);
  assert.deepEqual(seconds.select.params.slice(0, 2), [FROM / 1000, TO / 1000]);
  const millis = build('', { mapping: { ...mapping, timestampFormat: 'epoch_ms' }, fromMs: FROM, toMs: TO });
  assert.deepEqual(millis.select.params.slice(0, 2), [FROM, TO]);
});

test('free text, numbers, negation, existence, status classes and fatal levels', () => {
  const built = build('Timeout user_id:>40 -level:debug exists:user_id status:5xx');
  assert.equal(
    built.select.sql,
    'SELECT * FROM "app_logs" WHERE ' +
      `(${['id', 'created_at', 'severity', 'msg', 'user_id', 'status'].map(like).join(' OR ')}) AND ` +
      '"user_id" > ? AND ' +
      `("severity" IS NULL OR NOT ${like('severity')}) AND ` +
      '"user_id" IS NOT NULL AND ' +
      `${like('status')} ORDER BY "created_at" DESC LIMIT ?`,
  );
  assert.deepEqual(built.select.params, [...Array(6).fill('%timeout%'), 40, '%debug%', '5%', 500]);
  assert.equal(built.local.length, 0);
  // Logline reads CRITICAL as fatal, so SQL looks for both.
  assert.deepEqual(build('level:fatal').select.params.slice(0, 2), ['%fatal%', '%critical%']);
  assert.deepEqual(build('-exists:user_id').pushed, ['-exists:user_id']);
  assert.match(build('-exists:user_id').select.sql, /"user_id" IS NULL/);
});

test('terms SQL cannot express are left for Logline, and never narrow the fetch', () => {
  const built = build('level:error /time.?out/ changed:true user:42 msg:>5 -timeout');
  assert.deepEqual(built.pushed, ['level:error']);
  assert.deepEqual(built.local, ['/time.?out/', 'changed:true', 'user:42', 'msg:>5', '-timeout']);
  assert.equal(built.select.params.length, 2);
  // Regular expressions stay local, with or without a field; a URL value is not one.
  const regexes = build('msg:http://a/b/ msg:/x/i -/y/');
  assert.deepEqual(regexes.pushed, ['msg:http://a/b/']);
  assert.deepEqual(regexes.local, ['msg:/x/i', '-/y/']);
  assert.deepEqual(regexes.select.params, ['%http://a/b/%', 500]);
  // A level column that stores numbers (pino's 50) cannot be matched by name.
  const numeric = build('level:error', { table: { ...table, columns: [{ name: 'severity', type: 'INTEGER' }] } });
  assert.deepEqual(numeric.local, ['level:error']);
});

test('OR branches are pushed down together, unless one branch cannot be', () => {
  const both = build('level:error OR msg:panic');
  assert.match(
    both.select.sql,
    new RegExp(`WHERE \\(\\(${escape(like('severity'))}\\) OR \\(${escape(like('msg'))}\\)\\)`),
  );
  assert.deepEqual(both.select.params, ['%error%', '%panic%', 500]);
  // SQL cannot narrow the regex branch, so it fetches everything in the range and filters locally.
  const either = build('level:error OR /panic/', { fromMs: FROM, toMs: TO });
  assert.doesNotMatch(either.select.sql, /LIKE/);
  assert.deepEqual(either.select.params, ['2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z', 500]);
  assert.deepEqual(either.pushed, []);
  assert.deepEqual(either.local, ['level:error', '/panic/']);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('relative and absolute time terms become time conditions', () => {
  const now = Date.parse('2026-10-23T10:00:00.000Z');
  const recent = build('last:5m', { now });
  assert.match(recent.select.sql, /WHERE julianday\("created_at"\) >= julianday\(\?\)/);
  assert.deepEqual(recent.select.params, ['2026-10-23T09:55:00.000Z', 500]);
  const window = build('timestamp:[2026-10-23T09:10:00Z to 2026-10-23T09:15:00Z]');
  assert.deepEqual(window.select.params.slice(0, 2), ['2026-10-23T09:10:00.000Z', '2026-10-23T09:15:00.000Z']);
  assert.deepEqual(build('-last:5m').local, ['-last:5m']);
});

test('values only ever reach the database as parameters, and identifiers are quoted', () => {
  const hostile = `msg:"'); DROP TABLE app_logs; --" 100%_done\\`;
  const built = build(hostile);
  assert.doesNotMatch(built.select.sql, /DROP|100/);
  assert.deepEqual(built.select.params.slice(0, 1), [`%'); drop table app\\_logs; --%`]);
  // LIKE wildcards in a value match themselves.
  assert.ok(built.select.params.includes('%100\\%\\_done\\\\%'));
  assert.equal(quoteTable('we"ird'), '"we""ird"');
  assert.equal(quoteTable('main.logs'), '"main"."logs"');
  assert.equal(quoteTable('a.b.c'), '"a.b.c"');
  const odd = build('', {
    mapping: { table: 'x"; DROP TABLE y; --', timestamp: 't"s' },
    table: { ...table, columns: [] },
  });
  assert.equal(odd.select.sql, 'SELECT * FROM "x""; DROP TABLE y; --" ORDER BY "t""s" DESC LIMIT ?');
});

test('typed SQL must be one read-only query', () => {
  assert.deepEqual(checkReadOnlySql('  SELECT * FROM logs;  ', 'postgres'), { sql: 'SELECT * FROM logs' });
  assert.deepEqual(checkReadOnlySql('with recent as (select 1) select * from recent', 'postgres'), {
    sql: 'with recent as (select 1) select * from recent',
  });
  assert.deepEqual(checkReadOnlySql("SELECT ';' AS semicolon -- trailing; comment", 'postgres'), {
    sql: "SELECT ';' AS semicolon -- trailing; comment",
  });
  assert.deepEqual(checkReadOnlySql("SELECT 'it''s; fine', $$a;b$$, $tag$c;d$tag$, \"x;y\" /* ; */", 'postgres'), {
    sql: "SELECT 'it''s; fine', $$a;b$$, $tag$c;d$tag$, \"x;y\" /* ; */",
  });
  assert.deepEqual(checkReadOnlySql('SELECT 1; DELETE FROM logs', 'postgres'), {
    error: 'Run one statement at a time.',
  });
  assert.deepEqual(checkReadOnlySql('DELETE FROM logs', 'postgres'), { error: 'Only SELECT queries can run here.' });
  assert.deepEqual(checkReadOnlySql('/* SELECT */ UPDATE logs SET a = 1', 'postgres'), {
    error: 'Only SELECT queries can run here.',
  });
  assert.deepEqual(checkReadOnlySql('  -- nothing\n', 'postgres'), { error: 'Enter a SELECT query.' });
  // SQLite has no dollar quoting: `$a` names a parameter there, so it cannot hide a second statement.
  const hidden = 'SELECT 1 AS x WHERE $a$ IS NULL) AS t;\n.shell touch pwned\nSELECT * FROM (SELECT $a$';
  assert.deepEqual(checkReadOnlySql(hidden, 'sqlite'), { error: 'Run one statement at a time.' });
  assert.deepEqual(checkReadOnlySql('SELECT $a$;$a$', 'postgres'), { sql: 'SELECT $a$;$a$' });
  // A trailing comment cannot swallow the wrapper that limits the rows.
  assert.deepEqual(limitedSql('SELECT 1 -- note', 'sqlite', 5), {
    sql: 'SELECT * FROM (\nSELECT 1 -- note\n) AS logline_query LIMIT ?',
    params: [5],
  });
  assert.equal(limitedSql('SELECT 1', 'postgres', 5).sql.endsWith('LIMIT $1'), true);
});

test('rows become JSON log lines with time, level and message under the names Logline reads', () => {
  const roles = rowRoles(['id', 'created_at', 'severity', 'msg', 'timestamp', 'payload'], mapping);
  assert.deepEqual(roles, {
    timestamp: 'created_at',
    level: 'severity',
    message: 'msg',
    service: undefined,
    traceId: undefined,
  });
  const { line, timeMs } = rowToLine(
    {
      id: 7n,
      created_at: '2026-10-23 09:12:04',
      severity: 'ERROR',
      msg: 'payment gateway timed out',
      timestamp: 'kept under another name',
      payload: new Uint8Array(3),
      big: 2n ** 64n,
      at: new Date('2026-10-23T09:00:00Z'),
    },
    roles,
    'iso',
  );
  // Text without a zone is UTC, as SQLite's CURRENT_TIMESTAMP stores it.
  assert.equal(timeMs, Date.parse('2026-10-23T09:12:04Z'));
  assert.deepEqual(JSON.parse(line), {
    timestamp: '2026-10-23T09:12:04.000Z',
    level: 'ERROR',
    message: 'payment gateway timed out',
    id: 7,
    timestamp_column: 'kept under another name',
    payload: '<3 bytes>',
    big: '18446744073709551616',
    at: '2026-10-23T09:00:00.000Z',
  });
  const event = parseLogLine(line, 'remote', 1, new Date());
  assert.equal(event.level, 'error');
  assert.equal(event.message, 'payment gateway timed out');
  assert.equal(event.timestampMs, timeMs);
  // A field named like a prototype key stays data.
  assert.deepEqual(
    JSON.parse(rowToLine(JSON.parse('{"__proto__": "x"}'), {}, 'auto').line),
    JSON.parse('{"__proto__": "x"}'),
  );
});

test('stored times are read in their unit', () => {
  assert.equal(timeValueMs(1761210724, 'auto'), 1761210724000);
  assert.equal(timeValueMs(1761210724000, 'auto'), 1761210724000);
  assert.equal(timeValueMs('1761210724', 'epoch_s'), 1761210724000);
  assert.equal(timeValueMs(1761210724000n, 'epoch_ms'), 1761210724000);
  assert.equal(timeValueMs('2026-10-23T09:12:04+02:00', 'iso'), Date.parse('2026-10-23T07:12:04Z'));
  assert.equal(timeValueMs(new Date(5), 'native'), 5);
  assert.equal(timeValueMs('not a time', 'iso'), undefined);
  assert.equal(timeValueMs(null, 'iso'), undefined);
});

test('fetched rows are filtered by the whole search except changed:', () => {
  assert.equal(rowFilter(''), undefined);
  assert.equal(rowFilter('changed:true'), undefined);
  const filter = rowFilter('/time.?out/ changed:true')!;
  const event = (message: string) => parseLogLine(JSON.stringify({ level: 'error', message }), 'remote', 1, new Date());
  assert.equal(matchesQuery(event('request timed out'), filter), false);
  assert.equal(matchesQuery(event('request timeout'), filter), true);
});

test('a metric query is narrowed to its range on the time column it returns', () => {
  assert.deepEqual(
    [new Date(0), 1761210000, 1761210000000, '1761210000', '2026-10-23 09:00:00', 'soon', null].map(valueEncoding),
    ['native', 'epoch_s', 'epoch_ms', 'epoch_s', 'iso', undefined, undefined],
  );
  assert.deepEqual(rangedSql('SELECT 1', 'postgres', { column: 'time', encoding: 'iso' }, 0, 1000, 10), {
    sql: 'SELECT * FROM (\nSELECT 1\n) AS logline_query WHERE CAST("time" AS timestamptz) BETWEEN CAST($1 AS timestamptz) AND CAST($2 AS timestamptz) ORDER BY "time" DESC LIMIT $3',
    params: ['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:01.000Z', 10],
  });
  assert.deepEqual(
    rangedSql('SELECT 1', 'sqlite', { column: 't', encoding: 'epoch_s' }, 0, 1000, 10).params,
    [0, 1, 10],
  );
});
