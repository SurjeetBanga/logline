import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudwatchQuery } from './cloudwatch-query';

test('field terms become a JSON filter pattern, matched whole and with case as CloudWatch does', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['orderId:A-17', '{ $.orderId = "A-17" }'],
    ['env:Prod', '{ $.env = "Prod" }'],
    // A `*` stays CloudWatch's wildcard.
    ['route:/orders*', '{ $.route = "/orders*" }'],
    // A number may be written as one or as text.
    ['user_id:42', '{ ($.user_id = 42 || $.user_id = "42") }'],
    ['durationMs:>200', '{ ($.durationMs > 200 || $.duration > 200 || $.duration_ms > 200 || $.responseTime > 200) }'],
    ['traceId:abc', '{ ($.traceId = "abc" || $.trace_id = "abc" || $.trace.id = "abc") }'],
    ['http.route:/pay', '{ $.http.route = "/pay" }'],
  ];
  for (const [input, pattern] of cases) assert.equal(cloudwatchQuery(input).pattern, pattern, input);
  const level = cloudwatchQuery('level:error').pattern;
  assert.match(
    level,
    /^\{ \(\$\.level = "error" \|\| \$\.level = "ERROR" \|\| \$\.level = "Error" \|\| \$\.level = 50 \|\| \$\.severity = "error"/,
  );
  const status = cloudwatchQuery('status:5xx').pattern;
  assert.match(status, /^\{ \(\(\$\.status >= 500 && \$\.status <= 599\) \|\| /);
});

test('words become a text pattern when the search has no fields, and are left to Logline when it has', () => {
  assert.deepEqual(cloudwatchQuery('payment "timed out" -healthcheck'), {
    pattern: '"payment" "timed out" -"healthcheck"',
    pushed: ['payment', '"timed out"', '-healthcheck'],
    local: [],
  });
  assert.deepEqual(cloudwatchQuery('timeout env:prod'), {
    pattern: '{ $.env = "prod" }',
    pushed: ['env:prod'],
    local: ['timeout'],
  });
  // A word keeps its case: CloudWatch compares with it.
  assert.equal(cloudwatchQuery('Timeout').pattern, '"Timeout"');
  // Only exclusions are not a pattern CloudWatch takes.
  assert.deepEqual(cloudwatchQuery('-healthcheck'), { pattern: '', pushed: [], local: ['-healthcheck'] });
});

test('OR becomes || in a JSON pattern and ? in a text pattern, or is left to Logline', () => {
  assert.equal(
    cloudwatchQuery('env:prod orderId:1 OR env:dev').pattern,
    '{ ($.env = "prod" && ($.orderId = 1 || $.orderId = "1")) || $.env = "dev" }',
  );
  assert.equal(cloudwatchQuery('timeout OR refused').pattern, '?"timeout" ?"refused"');
  // A text pattern cannot say OR of several words; a branch with no field cannot be a JSON pattern.
  for (const input of ['payment timeout OR refused', 'env:prod OR timeout']) {
    const result = cloudwatchQuery(input);
    assert.equal(result.pattern, '', input);
    assert.deepEqual(result.pushed, [], input);
  }
});

test('a service chooses log groups, and what CloudWatch cannot say is applied by Logline', () => {
  assert.deepEqual(cloudwatchQuery('service:checkout level:error').services, ['checkout']);
  assert.equal(cloudwatchQuery('service:checkout').pattern, '');
  assert.deepEqual(cloudwatchQuery('service:checkout').pushed, ['service:checkout']);
  // In an OR, a service would choose groups for every branch: Logline applies it.
  assert.equal(cloudwatchQuery('service:checkout OR service:api').services, undefined);
  const local = cloudwatchQuery('env:prod -env:dev /time.?out/ changed:true last:15m exists:userId');
  assert.equal(local.pattern, '{ $.env = "prod" }');
  assert.deepEqual(local.local, ['-env:dev', '/time.?out/', 'changed:true', 'last:15m', 'exists:userId']);
});
