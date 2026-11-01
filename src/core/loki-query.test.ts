import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lokiQuery, nativeLokiQuery } from './loki-query';

const SELECTOR = '{service_name=~".+"}';

test('words become line filters without case, before the JSON parser and its label filters', () => {
  assert.deepEqual(lokiQuery(''), { query: SELECTOR, pushed: [], local: [] });
  assert.equal(
    lokiQuery('Timeout "card declined" -healthcheck').query,
    `${SELECTOR} |~ "(?i)Timeout" |~ "(?i)card declined" !~ "(?i)healthcheck"`,
  );
  assert.equal(lokiQuery('payment env:prod').query, `${SELECTOR} |~ "(?i)payment" | json | env=~"(?i).*prod.*"`);
  // Regular expressions are RE2 on both sides; only the case flag carries over.
  assert.equal(lokiQuery('/time.?out/i').query, `${SELECTOR} |~ "(?i)time.?out"`);
  assert.deepEqual(lokiQuery('/time.?out/s').local, ['/time.?out/s']);
});

test('fields match any part of a value as Logline does, under every name Logline reads them by', () => {
  const cases: [string, string][] = [
    ['route:/orders*', '| json | route=~"(?i)/orders.*"'],
    ['http.route:pay', '| json | http_route=~"(?i).*pay.*"'],
    ['-env:dev', '| json | env!~"(?i).*dev.*"'],
    ['durationMs:>200', '| json | (durationMs>200 or duration>200 or duration_ms>200 or responseTime>200)'],
    [
      'status:5xx',
      '| json | ((status>=500 and status<=599) or (statusCode>=500 and statusCode<=599) or (status_code>=500 and status_code<=599) or (http_status_code>=500 and http_status_code<=599) or (http_response_status_code>=500 and http_response_status_code<=599))',
    ],
    [
      'level:error',
      '| json | (level=~"(?i).*error.*|50" or severity=~"(?i).*error.*|50" or detected_level=~"(?i).*error.*|50")',
    ],
    ['exists:userId', '| json | userId!=""'],
  ];
  for (const [input, pipeline] of cases) assert.equal(lokiQuery(input).query, `${SELECTOR} ${pipeline}`, input);
});

test('a service chooses the streams read, and what LogQL cannot say is left to Logline', () => {
  assert.equal(
    lokiQuery('service:checkout level:warn', '{job="x"}').query,
    '{service_name=~"(?i).*checkout.*"} | json | (level=~"(?i).*warn.*|40" or severity=~"(?i).*warn.*|40" or detected_level=~"(?i).*warn.*|40")',
  );
  const left = lokiQuery('env:prod changed:true last:15m -durationMs:>5');
  assert.equal(left.query, `${SELECTOR} | json | env=~"(?i).*prod.*"`);
  assert.deepEqual(left.local, ['changed:true', 'last:15m', '-durationMs:>5']);
  // One query reads one set of streams through one pipeline, so OR is Logline's.
  assert.deepEqual(lokiQuery('timeout OR refused'), { query: SELECTOR, pushed: [], local: ['timeout', 'refused'] });
});

test('LogQL typed as it is, or pipeline stages that read the connection’s streams', () => {
  assert.equal(nativeLokiQuery('{app="api"} |= "x"'), '{app="api"} |= "x"');
  assert.equal(nativeLokiQuery('|= "trace-1"', '{job="api"}'), '{job="api"} |= "trace-1"');
  assert.equal(nativeLokiQuery('  '), SELECTOR);
});
