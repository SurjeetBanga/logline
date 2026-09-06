const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, matchesQuery } = require('./query');
const { parseLogLine } = require('./log-event');
const event = { level: 'error', message: 'Database timeout', raw: '{"service":"api","status":503}', fields: { service: 'api', status: 503, requestId: 'abc-123' } };
test('supports field filters, phrases, negation and OR', () => {
  assert.equal(matchesQuery(event, 'level:error service:api status:5xx'), true);
  assert.equal(matchesQuery(event, 'service:web OR requestId:abc'), true);
  assert.equal(matchesQuery(event, '"database timeout" -service:web'), true);
  assert.equal(matchesQuery(event, 'status:200'), false);
  assert.equal(parseQuery('service:api OR level:error').length, 2);
});

test('supports exists, status wildcards and exact status', () => {
  assert.equal(matchesQuery(event, 'exists:requestId'), true);
  assert.equal(matchesQuery(event, 'exists:missingField'), false);
  assert.equal(matchesQuery(event, '-exists:missingField'), true);
  assert.equal(matchesQuery(event, 'status:503'), true);
  assert.equal(matchesQuery(event, 'status:200'), false);
  assert.equal(matchesQuery(event, 'status:5xx'), true);
  assert.equal(matchesQuery(event, 'status:2xx'), false);
});

test('supports numeric comparisons and ranges', () => {
  assert.equal(matchesQuery(event, 'status:>500'), true);
  assert.equal(matchesQuery(event, 'status:>=503'), true);
  assert.equal(matchesQuery(event, 'status:<500'), false);
  assert.equal(matchesQuery(event, 'status:[500 TO 599]'), true);
  assert.equal(matchesQuery(event, 'status:[100 TO 199]'), false);
});

test('supports regex matching, including invalid patterns', () => {
  assert.equal(matchesQuery(event, 'message:/time.?out/i'), true);
  assert.equal(matchesQuery(event, 'message:/nomatch/'), false);
  assert.equal(matchesQuery(event, 'message:/[/'), false);
});

test('resolves field aliases', () => {
  assert.equal(matchesQuery(event, 'severity:error'), true);
  assert.equal(matchesQuery(event, 'statuscode:503'), true);
  assert.equal(matchesQuery(event, 'service_name:api'), true);
  assert.equal(matchesQuery(event, 'request_id:abc-123'), true);
});

test('a colon inside a pasted value does not create a field filter', () => {
  const event = parseLogLine(
    '{"level":"info","message":"GET http://api.internal/health took 12ms","service":"web"}',
    'stdout', 1, new Date());
  assert.equal(matchesQuery(event, 'http://api.internal'), true);
  assert.equal(matchesQuery(event, 'http://nope.internal'), false);
  assert.equal(matchesQuery(event, 'service:web'), true, 'real field filters still parse');
  assert.equal(parseQuery('http://api')[0][0].field, undefined);
  assert.equal(parseQuery('service:web')[0][0].field, 'service');
  assert.equal(parseQuery('12:30:05')[0][0].field, undefined, 'a bare clock time is free text');
});

test('numeric comparisons ignore non-numeric field values instead of matching them', () => {
  const numeric = parseLogLine('{"message":"x","durationMs":250}', 'stdout', 1, new Date());
  const textual = parseLogLine('{"message":"x","durationMs":"fast"}', 'stdout', 2, new Date());
  assert.equal(matchesQuery(numeric, 'durationMs:>200'), true);
  assert.equal(matchesQuery(numeric, 'durationMs:>900'), false);
  assert.equal(matchesQuery(textual, 'durationMs:>200'), false);
  assert.equal(matchesQuery(textual, 'durationMs:fast'), true, 'text still matches as a substring');
});

test('a field filter matches the name as typed, whichever variant the log uses', () => {
  const camel = parseLogLine('{"level":"info","message":"hb","statusCode":200,"durationMs":30}', 'stdout', 1, new Date());
  const snake = parseLogLine('{"level":"info","message":"hb","status":200,"duration":30}', 'stdout', 2, new Date());
  for (const event of [camel, snake]) {
    assert.equal(matchesQuery(event, 'statusCode:200'), true);
    assert.equal(matchesQuery(event, 'status:200'), true);
    assert.equal(matchesQuery(event, 'status:2xx'), true);
    assert.equal(matchesQuery(event, 'statusCode:>=200'), true);
    assert.equal(matchesQuery(event, 'statusCode:404'), false);
    assert.equal(matchesQuery(event, 'duration:>10'), true);
    assert.equal(matchesQuery(event, 'durationMs:>10'), true);
  }
  assert.equal(matchesQuery(camel, 'msg:hb'), true, 'message aliases still resolve');
  assert.equal(matchesQuery(camel, 'severity:info'), true, 'level aliases still resolve');
});

test('an exact field name wins over its alias group', () => {
  const both = parseLogLine('{"level":"info","message":"x","status":500,"statusCode":200}', 'stdout', 1, new Date());
  assert.equal(matchesQuery(both, 'status:500'), true);
  assert.equal(matchesQuery(both, 'statusCode:200'), true);
  assert.equal(matchesQuery(both, 'status:200'), false);
  assert.equal(matchesQuery(both, 'statusCode:500'), false);
});
