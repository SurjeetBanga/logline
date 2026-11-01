import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gcpFilter, gcpQuery } from './gcp-query';

test('fields of a JSON payload and of the entry match any part of a value without case', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['orderId:A-17', 'jsonPayload.orderId=~"(?i)A-17"'],
    ['route:/orders*', 'jsonPayload.route=~"(?i)^/orders.*$"'],
    ['user_id:42', '(jsonPayload.user_id=~"(?i)42" OR jsonPayload.user_id=42)'],
    ['resource.type:cloud_run', 'resource.type=~"(?i)cloud_run"'],
    ['labels.k8s-pod:x', '"labels.k8s-pod:x"'],
    ['service:checkout', '(resource.labels.service_name=~"(?i)checkout" OR jsonPayload.service=~"(?i)checkout")'],
    [
      'status:5xx',
      '((jsonPayload.status>=500 AND jsonPayload.status<=599) OR (httpRequest.status>=500 AND httpRequest.status<=599) OR (jsonPayload.statusCode>=500 AND jsonPayload.statusCode<=599) OR (jsonPayload.status_code>=500 AND jsonPayload.status_code<=599))',
    ],
    ['level:error', '(severity=ERROR OR jsonPayload.level=~"(?i)error")'],
    ['level:fatal', '(severity>=CRITICAL OR jsonPayload.level=~"(?i)fatal")'],
    ['exists:userId', 'jsonPayload.userId:*'],
    ['-env:dev', 'NOT (jsonPayload.env=~"(?i)dev")'],
    ['path:/pay\\d+/', 'jsonPayload.path=~"pay\\\\d+"'],
  ];
  for (const [input, filter] of cases) assert.equal(gcpQuery(input).filter, filter, input);
  // A dash is not part of a field name to Logline, so `labels.k8s-pod:x` is free text.
  assert.equal(gcpQuery('labels.k8s-pod:x').pushed.length, 1);
});

test('words are searched as Cloud Logging searches them, and OR is parenthesized since it binds tighter than AND', () => {
  assert.equal(gcpQuery('payment "card declined"').filter, '"payment" AND "card declined"');
  assert.equal(
    gcpQuery('level:error env:prod OR timeout').filter,
    '(((severity=ERROR OR jsonPayload.level=~"(?i)error") AND jsonPayload.env=~"(?i)prod") OR "timeout")',
  );
  const left = gcpQuery('env:prod /time.?out/ changed:true last:15m');
  assert.equal(left.filter, 'jsonPayload.env=~"(?i)prod"');
  assert.deepEqual(left.local, ['/time.?out/', 'changed:true', 'last:15m']);
  assert.equal(
    gcpQuery('service:checkout', 'resource.labels.function_name').filter,
    '(resource.labels.function_name=~"(?i)checkout" OR jsonPayload.service=~"(?i)checkout")',
  );
});

test('a query sent is the connection’s filter, the range, and the search, each in parentheses', () => {
  assert.equal(
    gcpFilter({
      base: 'resource.type="cloud_run_revision" OR resource.type="k8s_container"',
      fromMs: 0,
      toMs: 60000,
      query: 'severity>=ERROR',
    }),
    '(resource.type="cloud_run_revision" OR resource.type="k8s_container") AND timestamp>="1970-01-01T00:00:00.000Z" AND timestamp<="1970-01-01T00:01:00.000Z" AND (severity>=ERROR)',
  );
  assert.equal(
    gcpFilter({ fromMs: 0, toMs: 0, query: '' }),
    'timestamp>="1970-01-01T00:00:00.000Z" AND timestamp<="1970-01-01T00:00:00.000Z"',
  );
});
