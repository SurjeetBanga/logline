import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportChunks, serializeExport, CSV_FIELD_LIMIT } from './transfer/log-export';
import { parseCsv, parseCsvRecords } from './transfer/log-import';
import { writeExportFile, PROVIDER_EXPORT_LIMIT } from './storage/export-file';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LogStore } from './core/log-store';
import { redactEvent } from './core/redaction';
import { parseLogLine } from './core/log-event';

test('export formats share redacted events and CSV retains raw JSON through quoted cells', () => {
  const event = redactEvent(parseLogLine(JSON.stringify({ message: 'quote " and comma, and\nnewline', token: 'test-secret', service: 'api' }), 'stdout', 1, new Date(0)));
  const json = serializeExport([event], 'json');
  const jsonl = serializeExport([event], 'jsonl');
  const csv = serializeExport([event], 'csv');
  for (const output of [json, jsonl, csv]) assert.ok(!output.includes('test-secret'));
  assert.deepEqual(JSON.parse(json), [event]);
  assert.deepEqual(JSON.parse(jsonl), event);
  assert.deepEqual(parseCsvRecords(csv), [event.raw]);
  assert.equal(serializeExport([], 'jsonl'), '');
});

test('streamed serialization matches whole serialization and redacts incrementally', async () => {
  const events = Array.from({ length: 500 }, (_, i) => parseLogLine(JSON.stringify({ message: `line ${i}`, token: 'secret', 'a,b': 'value' }), 'stdout', i, new Date(0)));
  for (const format of ['json', 'jsonl', 'csv'] as const) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of exportChunks(events, format)) chunks.push(chunk);
    assert.ok(chunks.length > 1);
    const result = Buffer.concat(chunks).toString('utf8');
    assert.equal(result, serializeExport(events.map(event => redactEvent(event)), format));
    assert.ok(!result.includes('secret'));
  }
  const readIds = new Set<number>();
  for (const event of events) {
    const raw = event.raw;
    Object.defineProperty(event, 'raw', { enumerable: true, get() { readIds.add(event.id); return raw; } });
  }
  const stream = exportChunks(events, 'jsonl');
  await stream.next();
  assert.equal(readIds.size, 128, 'first batch must not redact later rows');
  await stream.return(undefined);
});

test('CSV quotes header names and bounds wide schemas while retaining raw payloads', () => {
  const events = Array.from({ length: 400 }, (_, id) => ({ id, level: 'info', raw: `original ${id}`, fields: { [`field,${id}`]: id } }));
  const csv = serializeExport(events, 'csv');
  const rows = parseCsv(csv);
  assert.equal(rows[0].length, 10 + CSV_FIELD_LIMIT);
  assert.equal(rows[0][10], 'field:field,0');
  assert.deepEqual(parseCsvRecords(csv), events.map(event => event.raw));
});

test('an export snapshot survives eviction without including newly captured rows', () => {
  const store = new LogStore(2);
  store.add({ id: 1, level: 'info', raw: 'old' });
  const snapshot = store.exportEvents();
  store.clear(); store.add({ id: 2, level: 'info', raw: 'new' });
  assert.deepEqual(snapshot.map(event => event.raw), ['old']);
});

test('local export commits complete output and preserves the destination on cancellation or failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'logline-export-'));
  const file = path.join(directory, 'logs.txt');
  const provider = async () => { throw new Error('Native export must stream'); };
  try {
    for (const cancel of [false, true]) {
      await writeFile(file, 'original');
      let cancelled = false;
      const chunks = (async function* () {
        yield Buffer.from('partial');
        if (!cancel) throw new Error('write failed');
        cancelled = true;
        yield Buffer.from('cancelled');
      })();
      await assert.rejects(writeExportFile(file, chunks, () => cancelled, provider), /write failed|cancelled/);
      assert.equal(await readFile(file, 'utf8'), 'original');
      assert.deepEqual(await readdir(directory), ['logs.txt']);
    }
    await writeExportFile(file, (async function* () { yield Buffer.from('first'); yield Buffer.from('last'); })(), () => false, provider);
    assert.equal(await readFile(file, 'utf8'), 'firstlast');
    assert.deepEqual(await readdir(directory), ['logs.txt']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('whole-file providers receive no partial or oversized export', async () => {
  let writes = 0;
  const write = async () => { writes++; };
  await assert.rejects(writeExportFile(undefined, (async function* () {
    yield Buffer.alloc(PROVIDER_EXPORT_LIMIT); yield Buffer.from('overflow');
  })(), () => false, write), /16 MiB/);
  assert.equal(writes, 0);
  await writeExportFile(undefined, (async function* () { yield Buffer.from('ok'); })(), () => false, write);
  assert.equal(writes, 1);
});
