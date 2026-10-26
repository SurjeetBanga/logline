import assert from 'node:assert/strict';
import { test } from 'node:test';
import { datadogQuery, parseDatadogLink } from './datadog-query';

test('a Logline search becomes Datadog log search syntax', () => {
  const cases: [string, string][] = [
    ['', '*'],
    ['level:error', 'status:(error)'],
    // Logline matches part of a level, so `warn` also finds `warning`, and fatal is any of the severe statuses.
    ['level:warn', 'status:(warn OR warning)'],
    ['severity:fatal', 'status:(emergency OR alert OR critical)'],
    ['service:checkout', 'service:checkout'],
    // A `*` is a wildcard, as in Datadog, except in quotes.
    ['service:check*', 'service:check*'],
    ['service:"check*"', 'service:check\\*'],
    ['traceId:4bf92f35', 'trace_id:4bf92f35'],
    ['host:web-1', 'host:web\\-1'],
    // `status` is the HTTP status in Logline and the level in Datadog.
    ['status:5xx', '@http.status_code:[500 TO 599]'],
    ['status:>=500', '@http.status_code:>=500'],
    ['status:404', '@http.status_code:404'],
    // `source` is reserved in Datadog, like `service`; another field is a tag or an attribute, as `env:prod` is a tag.
    ['source:java', 'source:java'],
    ['env:prod', '(env:prod OR @env:prod)'],
    ['-env:prod', '-env:prod -@env:prod'],
    ['@service:checkout', '@service:checkout'],
    ['durationMs:>200', '@durationMs:>200'],
    ['user_id:[10 to 20]', '@user_id:[10 TO 20]'],
    ['user_id:42', '(user_id:42 OR @user_id:42)'],
    ['@http.route:/orders', '@http.route:\\/orders'],
    ['exists:user_id', '@user_id:*'],
    ['-exists:user_id', '-@user_id:*'],
    // Free text is a word of the message, as Datadog searches it; a phrase stays a phrase. A message term
    // matches a part of the message.
    ['timeout', 'timeout'],
    ['time*', 'time*'],
    ['"gateway timed out"', '"gateway timed out"'],
    ['message:declined', '*declined*'],
    ['-healthcheck', '-healthcheck'],
    ['level:error OR service:api', '(status:(error)) OR (service:api)'],
  ];
  for (const [input, expected] of cases) assert.equal(datadogQuery(input).query, expected, input);
});

test('terms Datadog cannot express are applied by Logline', () => {
  assert.deepEqual(datadogQuery('level:error /time.?out/ changed:true last:5m'), {
    query: 'status:(error)',
    pushed: ['level:error'],
    local: ['/time.?out/', 'changed:true', 'last:5m'],
  });
  assert.deepEqual(datadogQuery('level:error OR /panic/'), {
    query: '*',
    pushed: [],
    local: ['level:error', '/panic/'],
  });
  // Special characters in values are escaped, so a value cannot change the query around it.
  assert.equal(datadogQuery('service:"a OR b) (c"').query, 'service:a\\ OR\\ b\\)\\ \\(c');
  // Datadog compares attribute values with case, so a value keeps the case it was typed in.
  assert.equal(datadogQuery('service:Checkout -@env:Prod').query, 'service:Checkout -@env:Prod');
  assert.equal(datadogQuery('@user:"x:y"').query, '@user:x\\:y');
});

test('Log Explorer links and trace ids are read for what they point at', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.deepEqual(parseDatadogLink('4bf92f3577b34da6a3ce929d0e0e4736'), {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  });
  assert.deepEqual(
    parseDatadogLink(
      'https://app.datadoghq.eu/logs?query=service%3Acheckout%20status%3Aerror&event=AwAAAZ3kT2&from_ts=1761210000000&to_ts=1761213600000&live=false',
    ),
    { query: 'service:checkout status:error', eventId: 'AwAAAZ3kT2', fromMs: 1761210000000, toMs: 1761213600000 },
  );
  // A link without a time range covers the last day.
  assert.deepEqual(parseDatadogLink('https://app.datadoghq.com/logs?event=AwAAAZ3kT2', now), {
    eventId: 'AwAAAZ3kT2',
    fromMs: now - 86400000,
    toMs: now,
  });
  for (const input of ['', 'short', 'https://app.datadoghq.com/apm/traces', 'ftp://x/logs?query=a', 'not a url at all'])
    assert.equal(parseDatadogLink(input, now), undefined, input);
});
