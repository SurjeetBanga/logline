import test from 'node:test';
import assert from 'node:assert/strict';
import { importRecords, parseCsvRecords } from './log-import';
import { parseLogLine } from './log-event';

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
