import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MongoConnection } from '../../core/connections';
import { MongoConnector, plainDocument, sampleFields, type MongoModule } from './mongo';

type Doc = Record<string, unknown>;

class FakeObjectId {
  readonly _bsontype = 'ObjectId';
  constructor(private readonly hex: string) {}
  toHexString() {
    return this.hex;
  }
  static createFromTime(seconds: number) {
    return new FakeObjectId(`${seconds.toString(16).padStart(8, '0')}0000000000000000`);
  }
}

/** A driver that records each call and answers from a list of documents. */
function fakeMongo(documents: Doc[], fail?: Error) {
  const calls: { op: string; args: unknown[] }[] = [];
  const cursor = (op: string, args: unknown[], rows: Doc[]) => {
    const record = {
      op,
      args,
      sort: undefined as unknown,
      limit: undefined as unknown,
      maxTimeMS: undefined as unknown,
    };
    calls.push(record as never);
    const self = {
      sort: (spec: unknown) => ((record.sort = spec), self),
      limit: (count: number) => ((record.limit = count), self),
      maxTimeMS: (ms: number) => ((record.maxTimeMS = ms), self),
      toArray: () =>
        fail ? Promise.reject(fail) : Promise.resolve(rows.slice(0, (record.limit as number) ?? undefined)),
      close: () => Promise.resolve(),
    };
    return self;
  };
  let opened = 0;
  let closed = 0;
  const module: MongoModule = {
    MongoClient: class {
      constructor(
        readonly url: string,
        readonly options: Doc,
      ) {
        calls.push({ op: 'client', args: [url, options] });
      }
      connect() {
        opened++;
        return Promise.resolve();
      }
      close() {
        closed++;
        return Promise.resolve();
      }
      db(name: string) {
        return {
          collection: (collection: string) => ({
            find: (filter: Doc, options?: Doc) => {
              const found = cursor('find', [collection, filter], documents);
              Object.assign(calls[calls.length - 1], { options });
              (calls[calls.length - 1] as unknown as { limit: unknown }).limit = options?.limit;
              return found;
            },
            aggregate: (pipeline: Doc[], options: Doc) =>
              cursor('aggregate', [collection, pipeline, options], documents),
            countDocuments: (filter: Doc) => {
              calls.push({ op: 'count', args: [collection, filter] });
              return Promise.resolve(1234);
            },
          }),
          command: (command: Doc) => {
            calls.push({ op: 'command', args: [name, command] });
            return Promise.resolve({ version: '7.0.4' });
          },
          listCollections: () => ({
            toArray: () => Promise.resolve([{ name: 'logs' }, { name: 'events' }, { name: 'system.views' }]),
          }),
        };
      }
    } as never,
    EJSON: { parse: (text: string) => JSON.parse(text) as unknown },
    ObjectId: FakeObjectId,
  };
  return { module, calls, counts: () => ({ opened, closed }) };
}

const connection = (logs?: MongoConnection['logs']): MongoConnection => ({
  id: 'events',
  label: 'events',
  type: 'mongodb',
  url: 'mongodb://reader@db/app',
  database: 'app',
  ...(logs ? { logs } : {}),
});

const documents: Doc[] = [
  {
    _id: new FakeObjectId('671a1b2c0000000000000001'),
    ts: new Date('2026-10-24T10:00:00Z'),
    level: 'error',
    msg: 'payment failed',
    http: { status: 502, path: '/pay' },
  },
  { _id: new FakeObjectId('671a1b2d0000000000000002'), ts: new Date('2026-10-24T09:59:00Z'), level: 'info', msg: 'ok' },
];

test('a sample of documents gives every nested field with the type seen most, and BSON values read as JSON', () => {
  assert.deepEqual(sampleFields(documents), [
    { name: '_id', type: 'objectId' },
    { name: 'ts', type: 'date' },
    { name: 'level', type: 'string' },
    { name: 'msg', type: 'string' },
    { name: 'http.status', type: 'number' },
    { name: 'http.path', type: 'string' },
  ]);
  assert.deepEqual(plainDocument(documents[0]), {
    _id: '671a1b2c0000000000000001',
    ts: '2026-10-24T10:00:00.000Z',
    level: 'error',
    msg: 'payment failed',
    http: { status: 502, path: '/pay' },
  });
  const binary = { _bsontype: 'Binary', buffer: new Uint8Array([1, 2]), sub_type: 4, position: 2 };
  assert.deepEqual(sampleFields([{ payload: binary, at: { _bsontype: 'Timestamp', low: 1, high: 2 } }]), [
    { name: 'payload', type: 'binary' },
    { name: 'at', type: 'timestamp' },
  ]);
  const long = { _bsontype: 'Long', toString: () => '9007199254740993' };
  assert.deepEqual(plainDocument({ small: { _bsontype: 'Int32', toString: () => '7' }, long }), {
    small: 7,
    long: '9007199254740993',
  });
});

test('a search becomes a find on the mapped collection, newest first, with the range in the form time is stored', async () => {
  const fake = fakeMongo(documents);
  const connector = new MongoConnector(
    connection({ table: 'logs', timestamp: 'ts', level: 'level', message: 'msg' }),
    'pw',
    () => 5000,
    () => fake.module,
  );
  assert.equal(await connector.test(), 'MongoDB 7.0.4 · 3 collections');
  assert.deepEqual(await connector.tables(), ['events', 'logs']);
  const [, options] = fake.calls[0].args as [string, Doc];
  assert.deepEqual(options.auth, { username: 'reader', password: 'pw' });
  assert.equal(options.readPreference, 'secondaryPreferred');

  const from = Date.parse('2026-10-24T09:00:00Z');
  const result = await connector.fetchLogs({
    query: 'level:error http.status:>=500',
    fromMs: from,
    limit: 2,
    order: 'desc',
    countTotal: true,
  });
  const find = fake.calls.find((call) => call.op === 'find') as unknown as {
    args: [string, Doc];
    sort: Doc;
    limit: number;
  };
  assert.deepEqual(find.args, [
    'logs',
    {
      $and: [
        { ts: { $gte: new Date(from) } },
        {
          $and: [
            {
              $or: [
                { level: { $regex: 'error', $options: 'i' } },
                {
                  $expr: {
                    $regexMatch: {
                      input: { $convert: { input: '$level', to: 'string', onError: '', onNull: '' } },
                      regex: 'error',
                      options: 'i',
                    },
                  },
                },
              ],
            },
            { 'http.status': { $gte: 500 } },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual([find.sort, find.limit], [{ ts: -1 }, 2]);
  assert.equal(result.total, 1234);
  assert.deepEqual(result.pushed, ['level:error', 'http.status:>=500']);
  assert.equal(result.records.length, 2);
  assert.match(result.records[0].line, /payment failed/);
  assert.match(
    result.statement ?? '',
    /^db\.logs\.find\(\{"\$and":\[\{"ts":\{"\$gte":ISODate\("2026-10-24T09:00:00\.000Z"\)\}\}/,
  );
  const preview = await connector.preview('-msg:ok', from);
  assert.match(preview.statement, /\.sort\(\{ "ts": -1 \}\)$/);
  await connector.dispose();
  assert.deepEqual(fake.counts(), { opened: 1, closed: 1 });
});

test('with time only in _id, a range compares ObjectIds made from the time', async () => {
  const fake = fakeMongo(documents);
  const connector = new MongoConnector(
    connection({ table: 'logs', timestamp: '_id', message: 'msg' }),
    undefined,
    () => 5000,
    () => fake.module,
  );
  const from = Date.parse('2026-10-24T09:00:00Z');
  const result = await connector.fetchLogs({ query: '', fromMs: from, limit: 10, order: 'asc' });
  const find = fake.calls.find((call) => call.op === 'find') as unknown as { args: [string, Doc]; sort: Doc };
  const range = (find.args[1]._id as { $gte: FakeObjectId }).$gte;
  assert.equal(range.toHexString().slice(0, 8), (from / 1000).toString(16));
  assert.deepEqual(find.sort, { _id: 1 });
  assert.match(result.records[0].line, /^{"timestamp":"2024-10-24T10:02:20.000Z"/);
  assert.equal((fake.calls[0].args[1] as Doc).auth, undefined, 'no password, no auth option');
});

test('typed queries run as a filter or a read-only pipeline, and metric pipelines chart their groups', async () => {
  const fake = fakeMongo([
    { _id: '2026-10-24T10:00:00Z', value: 3 },
    { _id: '2026-10-24T10:01:00Z', value: 5 },
  ]);
  const connector = new MongoConnector(
    connection({ table: 'logs', timestamp: 'ts' }),
    undefined,
    () => 5000,
    () => fake.module,
  );
  await connector.runSql('{ "level": "error" }', 50);
  const find = fake.calls.find((call) => call.op === 'find') as unknown as { args: unknown[]; limit: number };
  assert.deepEqual([find.args, find.limit], [['logs', { level: 'error' }], 50]);
  await connector.runSql('[{ "$match": {} }]', 10);
  const aggregate = fake.calls.find((call) => call.op === 'aggregate')!;
  assert.deepEqual(aggregate.args[1], [{ $match: {} }, { $limit: 10 }]);
  await assert.rejects(connector.runSql('[{ "$out": "copy" }]', 10), /\$out is not allowed/);
  await assert.rejects(connector.runSql('{ nope', 10), /Write the query as JSON/);
  await assert.rejects(connector.queryMetrics('{ "a": 1 }', 0, 1), /pipeline/);
  const metrics = await connector.queryMetrics(
    '[{ "$group": { "_id": "$minute", "value": { "$sum": 1 } } }]',
    Date.parse('2026-10-24T10:00:30Z'),
    Date.parse('2026-10-24T11:00:00Z'),
  );
  assert.deepEqual(
    metrics.series.map((series) => series.points),
    [[[Date.parse('2026-10-24T10:01:00Z'), 5]]],
  );
  assert.deepEqual(await connector.listMetrics(), []);
});

test('the server time limit reads as a timeout, and a search needs a mapped collection', async () => {
  const slow = fakeMongo([], Object.assign(new Error('operation exceeded time limit'), { code: 50 }));
  const connector = new MongoConnector(
    connection({ table: 'logs', timestamp: 'ts' }),
    undefined,
    () => 5000,
    () => slow.module,
  );
  await assert.rejects(connector.runSql('{}', 1), /5 s|timed out|time limit/i);
  const unmapped = new MongoConnector(
    connection(),
    undefined,
    () => 5000,
    () => slow.module,
  );
  await assert.rejects(unmapped.fetchLogs({ query: '', limit: 1, order: 'desc' }), /Map a log collection/);
  await assert.rejects(unmapped.runSql('{}', 1), /Choose a log collection/);
});

test('a document key named __proto__ stays a field of the document', () => {
  const document = JSON.parse('{"msg":"hi","__proto__":{"admin":true}}') as Record<string, unknown>;
  assert.equal(JSON.stringify(plainDocument(document)), '{"msg":"hi","__proto__":{"admin":true}}');
});

test('time kept as seconds, milliseconds, or ISO text, even in a nested field, is filtered in that form', async () => {
  const from = Date.parse('2026-10-24T09:00:00Z');
  const cases: [Doc, string, unknown][] = [
    [{ meta: { at: from / 1000 }, msg: 'a' }, 'meta.at', from / 1000],
    [{ at: from }, 'at', from],
    [{ at: '2026-10-24T09:30:00Z' }, 'at', '2026-10-24T09:00:00.000Z'],
  ];
  for (const [document, field, expected] of cases) {
    const fake = fakeMongo([document]);
    const connector = new MongoConnector(
      connection({ table: 'logs', timestamp: field, message: 'msg' }),
      undefined,
      () => 5000,
      () => fake.module,
    );
    const result = await connector.fetchLogs({ query: '', fromMs: from, limit: 10, order: 'desc' });
    const find = fake.calls.filter((call) => call.op === 'find').at(-1) as unknown as { args: [string, Doc] };
    assert.deepEqual(find.args[1], { [field]: { $gte: expected } }, field);
    assert.equal(result.records.length, 1);
    if (field === 'meta.at') assert.equal(result.records[0].timeMs, from, 'a nested time is read for the line');
  }
});

test('a time field holding ObjectIds other than _id is the one ranges, sorting, and lines use', async () => {
  const fake = fakeMongo([
    {
      _id: new FakeObjectId('000000010000000000000001'),
      eventId: new FakeObjectId('671a1b2c0000000000000002'),
      msg: 'a',
    },
  ]);
  const connector = new MongoConnector(
    connection({ table: 'logs', timestamp: 'eventId', message: 'msg' }),
    undefined,
    () => 5000,
    () => fake.module,
  );
  const from = Date.parse('2026-10-24T09:00:00Z');
  const result = await connector.fetchLogs({ query: '', fromMs: from, limit: 10, order: 'desc' });
  const find = fake.calls.find((call) => call.op === 'find') as unknown as { args: [string, Doc]; sort: Doc };
  assert.deepEqual(Object.keys(find.args[1]), ['eventId']);
  assert.deepEqual(find.sort, { eventId: -1 });
  assert.match(result.records[0].line, /^{"timestamp":"2024-10-24T10:02:20\.000Z"/);
});

test('a sample is a few documents of a collection, limited to 1 to 50, read as JSON', async () => {
  const fake = fakeMongo(documents);
  const connector = new MongoConnector(
    connection(),
    undefined,
    () => 5000,
    () => fake.module,
  );
  const rows = await connector.sample('logs');
  assert.deepEqual(rows[0], plainDocument(documents[0]));
  const find = () =>
    fake.calls.filter((call) => call.op === 'find').at(-1) as unknown as { args: unknown[]; options: Doc };
  assert.deepEqual(find().args, ['logs', {}]);
  assert.deepEqual(find().options, { limit: 5, maxTimeMS: 5000 });
  await connector.sample('logs', 500);
  assert.equal(find().options.limit, 50);
  await connector.sample('logs', 0);
  assert.equal(find().options.limit, 1);
  await connector.sample('logs', 2.9);
  assert.equal(find().options.limit, 2);
});
