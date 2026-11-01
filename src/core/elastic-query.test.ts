import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ColumnInfo, LogTableMapping } from './connections';
import { buildElasticQuery, serviceField } from './elastic-query';

const mapping: LogTableMapping = {
  table: 'logs-*',
  timestamp: '@timestamp',
  level: 'log.level',
  message: 'message',
  service: 'service.name',
  traceId: 'trace.id',
};
const fields: ColumnInfo[] = [
  { name: '@timestamp', type: 'date' },
  { name: 'log.level', type: 'keyword' },
  { name: 'message', type: 'text' },
  { name: 'message.keyword', type: 'keyword' },
  { name: 'service.name', type: 'keyword' },
  { name: 'trace.id', type: 'keyword' },
  { name: 'http.response.status_code', type: 'long' },
  { name: 'durationMs', type: 'float' },
  { name: 'user.ok', type: 'boolean' },
  { name: 'client.ip', type: 'ip' },
  { name: 'note', type: 'text' },
];
const build = (query: string) => buildElasticQuery({ mapping, fields, query });
const filter = (query: string) => (build(query).query as { bool: { filter: unknown[] } }).bool.filter;

test('fields are matched by their type: keywords anywhere without case, text by its words, numbers as numbers', () => {
  assert.deepEqual(filter('service:check*'), [
    { wildcard: { 'service.name': { value: 'check*', case_insensitive: true } } },
  ]);
  assert.deepEqual(filter('level:error'), [
    { wildcard: { 'log.level': { value: '*error*', case_insensitive: true } } },
  ]);
  // A text field with a keyword beside it matches any part of the value, or its words.
  assert.deepEqual(filter('message:declined'), [
    {
      bool: {
        should: [
          { wildcard: { 'message.keyword': { value: '*declined*', case_insensitive: true } } },
          { match_phrase: { message: 'declined' } },
        ],
        minimum_should_match: 1,
      },
    },
  ]);
  assert.deepEqual(filter('note:"card declined"'), [{ match_phrase: { note: 'card declined' } }]);
  assert.deepEqual(filter('status:5xx'), [{ range: { 'http.response.status_code': { gte: 500, lte: 599 } } }]);
  assert.deepEqual(filter('durationMs:>200'), [{ range: { durationMs: { gt: 200 } } }]);
  assert.deepEqual(filter('user.ok:true client.ip:10.0.0.1'), [
    { term: { 'user.ok': true } },
    { term: { 'client.ip': '10.0.0.1' } },
  ]);
  assert.deepEqual(filter('-service:api'), [
    { bool: { must_not: [{ wildcard: { 'service.name': { value: '*api*', case_insensitive: true } } }] } },
  ]);
  assert.deepEqual(filter('exists:trace'), [{ exists: { field: 'trace.id' } }]);
});

test('words are searched in text and keyword fields, OR becomes should, and the range filters the time field', () => {
  const words = filter('timeout') as { simple_query_string: { query: string; fields: string[] } }[];
  assert.equal(words[0].simple_query_string.query, '"timeout"');
  assert.deepEqual(words[0].simple_query_string.fields, ['log.level', 'message', 'service.name', 'trace.id', 'note']);
  const or = buildElasticQuery({ mapping, fields, query: 'level:error OR status:5xx', fromMs: 1, toMs: 2 });
  assert.deepEqual(or.query, {
    bool: {
      filter: [
        { range: { '@timestamp': { gte: 1, lte: 2, format: 'epoch_millis' } } },
        {
          bool: {
            should: [
              { wildcard: { 'log.level': { value: '*error*', case_insensitive: true } } },
              { range: { 'http.response.status_code': { gte: 500, lte: 599 } } },
            ],
            minimum_should_match: 1,
          },
        },
      ],
    },
  });
});

test('what a query cannot say is left to Logline, and Lucene is sent as typed', () => {
  const left = build('level:error missing.field:x durationMs:abc /time.?out/ changed:true');
  assert.deepEqual(left.pushed, ['level:error']);
  assert.deepEqual(left.local, ['missing.field:x', 'durationMs:abc', '/time.?out/', 'changed:true']);
  // A branch nothing narrows leaves the whole OR to Logline.
  assert.deepEqual(build('level:error OR missing.field:x').pushed, []);
  assert.deepEqual(
    buildElasticQuery({ mapping, fields, query: 'ignored', native: 'service.name:api AND NOT log.level:debug' }).query,
    {
      bool: { filter: [{ query_string: { query: 'service.name:api AND NOT log.level:debug', lenient: true } }] },
    },
  );
  assert.equal(serviceField(mapping, fields), 'service.name');
  assert.equal(serviceField({ ...mapping, service: 'message' }, fields), 'message.keyword');
});
