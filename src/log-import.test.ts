import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogLine } from './core/log-event';
import { importRecords, parseCsv, parseCsvRecords } from './transfer/log-import';

async function* chunks(text: string, size: number) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
async function read(text: string, format: string, size = 7, limit = 65536) {
  const records = [];
  for await (const record of importRecords(chunks(text, size), format, limit)) records.push(record);
  return records;
}

test('JSONL keeps UTF-8, large numeric IDs and original raw JSON across chunk boundaries', async () => {
  const raw = '{"message":"café 🚀","id":9007199254740993}';
  const records = await read(raw + '\r\nplain text\n\n[1,2]\nfinal', 'jsonl', 1);
  assert.deepEqual(records.map(record => record.raw.trim()), [raw, 'plain text', '[1,2]', 'final']);
  assert.ok(records.every(record => !record.truncated));
});

test('JSON documents stream array elements, nested values, scalars and multiline objects', async () => {
  const values = [{ message: 'comma, bracket ] quote " slash \\', nested: [1, { x: true }] }, [1, 2], '🚀', null, 42, false];
  for (const size of [1, 7, 65536]) {
    const records = await read('\uFEFF' + JSON.stringify(values, null, 2), 'json', size);
    assert.deepEqual(records.map(record => JSON.parse(record.raw)), values);
  }
  const object = { message: 'multiline', nested: { key: 'value' } };
  assert.deepEqual((await read(JSON.stringify(object, null, 2), 'json')).map(record => JSON.parse(record.raw)), [object]);
  assert.deepEqual(await read('[]', 'json'), []);
  assert.deepEqual(await read('   ', 'json'), []);
});

test('CSV framing preserves escaped quotes, embedded CRLF and whitespace across chunks', async () => {
  const csv = 'message,service\r\n"a ""quoted"" value\r\nsecond line",api\r\n  padded  ,worker\r\n';
  for (const size of [1, 2, 7, 65536]) {
    const records = await read(csv, 'csv', size);
    assert.deepEqual(records.map(record => JSON.parse(record.raw)), parseCsvRecords(csv));
  }
  const raw = '{"message":"boom","level":"error"}';
  const exported = 'id,raw\n1,"' + raw.replace(/"/g, '""') + '"\n';
  assert.equal((await read(exported, 'csv', 1))[0].raw, raw);
  assert.deepEqual((await read('\uFEFF"message"\r\n  \r\n', 'csv', 1)).map(record => JSON.parse(record.raw)), [{ message: '  ' }]);
});

test('oversized lines, JSON elements and CSV rows recover at the next record', async () => {
  for (const [format, text] of [
    ['jsonl', 'x'.repeat(1000) + '\n{"message":"next"}'],
    ['json', JSON.stringify([{ message: 'x'.repeat(1000) }, { message: 'next' }])],
    ['csv', 'message\n"' + 'x\n'.repeat(500) + '"\nnext\n']
  ]) {
    const records = await read(text, format, 7, 64);
    assert.equal(records.length, 2);
    assert.equal(records[0].truncated, true);
    assert.ok(records[0].raw.length <= 64);
    assert.equal(records[1].truncated, false);
    assert.equal(parseLogLine(records[1].raw, 'import', 1, new Date()).message, 'next');
  }
});

test('records are emitted before the rest of the input is read', async () => {
  let reads = 0;
  async function* source() {
    reads++; yield Buffer.from('{"message":"first"}\n');
    reads++; yield Buffer.from('{"message":"second"}\n');
  }
  const iterator = importRecords(source());
  assert.equal((await iterator.next()).value?.raw, '{"message":"first"}');
  assert.equal(reads, 1);
  await iterator.return(undefined);
});

test('CSV imports round-trip a Logline export and accept foreign files', () => {
  // A Logline CSV export carries `raw`, which replays the original line exactly.
  const exported = 'id,timestamp,level,message,raw,field:service\n'
    + '7,10:00:00.000,error,Boom,"{""level"":""error"",""message"":""Boom"",""service"":""api""}",api\n';
  assert.deepEqual(parseCsvRecords(exported), ['{"level":"error","message":"Boom","service":"api"}']);

  // A CSV from anywhere else becomes a record built from its own headers.
  const foreign = 'level,message,service\nwarn,"Disk ""nearly"" full, 91%",storage\ninfo,Started,storage\n';
  assert.deepEqual(parseCsvRecords(foreign), [
    { level: 'warn', message: 'Disk "nearly" full, 91%', service: 'storage' },
    { level: 'info', message: 'Started', service: 'storage' }
  ]);

  // Quoted cells may span newlines, and blank rows are skipped.
  assert.deepEqual(parseCsv('a,b\n"line one\nline two",second\n\n'),
    [['a', 'b'], ['line one\nline two', 'second'], ['']]);
  assert.deepEqual(parseCsvRecords('level,message\n\ninfo,ok\n'), [{ level: 'info', message: 'ok' }]);
  assert.deepEqual(parseCsvRecords(''), []);
  assert.deepEqual(parseCsvRecords('id,timestampMs,message\n5,1700000000000,hi\n'), [{ message: 'hi' }],
    'ids and epoch columns are re-derived on ingest rather than carried over');
});
