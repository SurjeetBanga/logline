import test from 'node:test';
import assert from 'node:assert/strict';
import { redactEvent, redactText, redactValue } from './redaction';

test('redacts sensitive object keys while retaining safe values', () => {
  assert.deepEqual(redactValue({ token: 'abc', tokenCount: 4, user: 'sam' }),
    { token: '[REDACTED]', tokenCount: 4, user: 'sam' });
});

test('redacts secrets in plain text assignments', () => {
  assert.equal(redactText('authorization: Bearer abc123 token="xyz"'),
    'authorization: [REDACTED] token="[REDACTED]"');
});

test('redacts camelCase secret keys embedded in messages', () => {
  assert.equal(redactText('sessionToken=abc123 userPassword: hunter2 clientSecret="xyz"'),
    'sessionToken=[REDACTED] userPassword: [REDACTED] clientSecret="[REDACTED]"');
});

test('redacts snake_case secret keys and leaves unrelated word:value pairs alone', () => {
  assert.equal(redactText('client_secret=abc123 api_key: "xyz"'),
    'client_secret=[REDACTED] api_key: "[REDACTED]"');
  assert.equal(redactText('tokenCount=5 retryCount=3'), 'tokenCount=5 retryCount=3',
    'a keyword embedded before other letters must not be treated as the field name');
});

test('redacts JSON raw details and fields in an event', () => {
  const event = {
    id: 1, level: 'info', message: 'token=abc', isJson: true,
    raw: '{"user":"sam","apiKey":"abc","nested":{"password":"pw"}}',
    fields: { user: 'sam', apiKey: 'abc' }
  };
  const redacted = redactEvent(event);
  assert.equal(redacted.message, 'token=[REDACTED]');
  assert.equal(redacted.fields?.apiKey, '[REDACTED]');
  assert.match(redacted.raw!, /\[REDACTED\]/);
  assert.doesNotMatch(redacted.raw!, /abc|pw/);
});
