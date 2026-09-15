import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesQuery, parseQuery } from './core/query';
import { queryTokens } from './core/query-tokens';
import type { LogEvent } from './core/types';
import { cellFilterQuery, valueForCell } from './webview/search/cell-filter';

test('cell filters preserve literal values and use the existing matching rules', () => {
  for (const value of ['say "hello"', 'C:\\work\\logs\\', ' padded ', ' \t ', 'first\nsecond', '/foo/i', '[a   TO   b]', '__TO__', 'x OR y', '>200', 0, false]) {
    const event = { id: 1, level: 'info', message: String(value), fields: { custom: value } };
    for (const exclude of [false, true]) {
      const result = cellFilterQuery('', { field: 'custom', value }, exclude);
      assert.ok(result.query);
      assert.equal(parseQuery(result.query)[0][0].value, String(value).toLowerCase());
      assert.equal(matchesQuery(event, result.query), !exclude, String(value));
      assert.equal(matchesQuery({ ...event, fields: { custom: 'unrelated' } }, result.query), exclude);
    }
  }
  const query = cellFilterQuery('', { field: 'service', value: 'api' }, false).query!;
  assert.equal(matchesQuery({ id: 1, level: 'info', fields: { service_name: 'API-worker' } }, query), true);
  const statusQuery = cellFilterQuery('', { field: 'status', value: 503 }, false).query!;
  assert.equal(matchesQuery({ id: 1, level: 'info', fields: { statusCode: 5030 } }, statusQuery), false);
});

test('cell conditions narrow every OR branch, leaving quoted OR and ranges intact', () => {
  const input = 'service:api OR message:"x OR y" or duration:[100 TO 200]';
  for (const exclude of [false, true]) {
    const result = cellFilterQuery(input, { field: 'level', value: 'error' }, exclude);
    assert.equal(result.query, `service:api ${exclude ? '-' : ''}level:"error" OR message:"x OR y" ${exclude ? '-' : ''}level:"error" OR duration:[100 TO 200] ${exclude ? '-' : ''}level:"error"`);
    const bases: Partial<LogEvent>[] = [{ fields: { service: 'api' } }, { message: 'x OR y' }, { fields: { duration: 150 } }];
    for (const base of bases) {
      assert.equal(matchesQuery({ ...base, id: 1, level: 'error' }, result.query!), !exclude);
      assert.equal(matchesQuery({ ...base, id: 1, level: 'info' }, result.query!), exclude);
    }
  }
  assert.equal(cellFilterQuery('"OR"', { field: 'service', value: 'api' }, false).query, '"OR" service:"api"');
  assert.deepEqual(queryTokens('message:"[a  TO  b]" duration:[1 TO 2]'), ['message:"[a  TO  b]"', 'duration:[1 TO 2]']);
});

test('unquoted range searches still work while quoted timestamp brackets remain literal', () => {
  const event = { id: 1, level: 'info', timestamp: '[2026-01-01 TO 2026-01-02]' };
  assert.equal(matchesQuery(event, cellFilterQuery('', { field: 'timestamp', value: event.timestamp }, false).query!), true);
  assert.equal(matchesQuery({ ...event, timestampMs: Date.parse('2026-01-01T12:00:00Z') }, 'timestamp:[2026-01-01 TO 2026-01-02]'), true);
});

test('invalid field names, missing values and oversized composed queries explain why actions are disabled', () => {
  for (const field of ['with space', 'some-key', 'a:b', '9field', '', 'exists', 'last'])
    assert.match(cellFilterQuery('', { field, value: 'x' }, false).reason!, /field name/);
  for (const value of [undefined, ''])
    assert.match(cellFilterQuery('', { field: 'service', value }, false).reason!, /no value/);
  const cell = { field: 'a', value: 'x' };
  const prefix = 'x'.repeat(250);
  assert.equal(cellFilterQuery(prefix, cell, false).query?.length, 256);
  assert.match(cellFilterQuery(prefix, cell, true).reason!, /256-character/);
  assert.match(cellFilterQuery('x'.repeat(123) + ' OR ' + 'y'.repeat(123), cell, false).reason!, /256-character/);
});

test('cell extraction handles metadata, payload fields, false and zero without reading inherited properties', () => {
  const event = { id: 1, level: 'error', timestamp: '12:00', message: 'oops', stream: 'stderr', fields: { count: 0, success: false } };
  assert.deepEqual(['base:time', 'base:level', 'base:message', 'base:source', 'field:count', 'field:success'].map(column => valueForCell(event, column)), [
    { field: 'timestamp', value: '12:00' }, { field: 'level', value: 'error' }, { field: 'message', value: 'oops' },
    { field: 'stream', value: 'stderr' }, { field: 'count', value: 0 }, { field: 'success', value: false }
  ]);
  assert.deepEqual(valueForCell(event, 'field:constructor'), { field: 'constructor', value: undefined });
});
