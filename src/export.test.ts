import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeExport } from './transfer/log-export';
import { parseCsvRecords } from './transfer/log-import';
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
