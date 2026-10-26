import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ColumnInfo, LogTableMapping } from './connections';
import { buildMongoLogQuery, checkMongoQuery, filterText } from './mongo-query';

const mapping: LogTableMapping = { table: 'logs', timestamp: 'ts', level: 'level', message: 'msg', service: 'svc' };
const fields: ColumnInfo[] = [
  { name: '_id', type: 'objectId' },
  { name: 'ts', type: 'date' },
  { name: 'level', type: 'string' },
  { name: 'msg', type: 'string' },
  { name: 'svc', type: 'string' },
  { name: 'http.status', type: 'number' },
  { name: 'status', type: 'int' },
  { name: 'user.email', type: 'string' },
];
/** The filter for a field whose text contains a pattern, whatever type each document stores it as. */
const text = (name: string, regex: string) => ({
  $or: [
    { [name]: { $regex: regex, $options: 'i' } },
    {
      $expr: {
        $regexMatch: {
          input: { $convert: { input: `$${name}`, to: 'string', onError: '', onNull: '' } },
          regex,
          options: 'i',
        },
      },
    },
  ],
});
const build = (query: string) =>
  buildMongoLogQuery({ mapping, fields, query, now: Date.parse('2026-10-24T12:00:00Z') });

test('field terms become case-insensitive matches on their mapped or nested field, with values escaped', () => {
  assert.deepEqual(build('level:error service:check.out').filter, {
    $and: [text('level', 'error'), text('svc', 'check\\.out')],
  });
  assert.deepEqual(build('http.status:>=500').filter, { 'http.status': { $gte: 500 } });
  assert.deepEqual(build('status:5xx').filter, { status: { $gte: 500, $lte: 599 } });
  assert.deepEqual(build('level:fatal').filter, text('level', 'fatal|critical'));
  assert.deepEqual(build('exists:user.email').filter, { 'user.email': { $exists: true } });
  assert.deepEqual(build('-level:debug').filter, { $nor: [text('level', 'debug')] });
  // A * is a wildcard.
  assert.deepEqual(build('service:check*out').filter, text('svc', 'check.*out'));
});

test('free text and what else a filter cannot promise are applied by Logline; OR becomes $or', () => {
  const free = build('timeout');
  assert.deepEqual([free.filter, free.pushed, free.local], [{}, [], ['timeout']]);
  assert.deepEqual(build('level:error OR level:fatal').filter, {
    $or: [text('level', 'error'), text('level', 'fatal|critical')],
  });
  const local = build('level:error message:/time.?out/ -timeout nosuchfield:x');
  assert.deepEqual(local.pushed, ['level:error']);
  assert.deepEqual(local.local, ['message:/time.?out/', '-timeout', 'nosuchfield:x']);
  const unnarrowed = build('level:error OR message:/x/');
  assert.deepEqual(unnarrowed.filter, {}, 'an OR branch a filter cannot narrow fetches everything in the range');
  assert.deepEqual(unnarrowed.pushed, []);
});

test('time terms narrow the range the connector filters on', () => {
  assert.deepEqual(build('last:15m level:error').fromMs, Date.parse('2026-10-24T11:45:00Z'));
  const range = build('timestamp:[2026-10-24T10:00:00Z TO 2026-10-24T11:00:00Z]');
  assert.deepEqual(
    [range.fromMs, range.toMs],
    [Date.parse('2026-10-24T10:00:00Z'), Date.parse('2026-10-24T11:00:00Z')],
  );
  assert.deepEqual(range.filter, {});
});

test('a typed query is a filter or a pipeline that only reads', () => {
  assert.deepEqual(checkMongoQuery({ level: 'error' }), { kind: 'filter', filter: { level: 'error' } });
  assert.equal((checkMongoQuery([{ $match: {} }, { $group: { _id: '$svc' } }]) as { kind: string }).kind, 'pipeline');
  for (const [query, error] of [
    [[{ $match: {} }, { $out: 'copy' }], /\$out is not allowed/],
    [[{ $merge: { into: 'x' } }], /\$merge is not allowed/],
    [{ $where: 'this.a > 1' }, /\$where is not allowed/],
    [[{ $group: { _id: null, n: { $accumulator: {} } } }], /\$accumulator is not allowed/],
    [[{ $match: {}, $limit: 1 }], /one operator/],
    [[{ $currentOp: {} }], /\$currentOp is not allowed in a pipeline/],
    [[], /Enter a filter/],
    [
      [{ $match: Array.from({ length: 70 }).reduce<object>((inner) => ({ $and: [inner] }), { $where: 'x' }) }],
      /nested too deeply/,
    ],
    ['text', /Enter a filter/],
  ] as const)
    assert.match((checkMongoQuery(query) as { error: string }).error, error);
});

test('a filter reads like the shell, with dates as ISODate', () => {
  assert.equal(
    filterText({ ts: { $gte: new Date('2026-10-24T11:00:00Z') }, level: { $regex: 'error' } }),
    '{"ts":{"$gte":ISODate("2026-10-24T11:00:00.000Z")},"level":{"$regex":"error"}}',
  );
});
