import assert from 'node:assert/strict';
import test from 'node:test';
import { redactEvent, redactText, redactValue } from './core/redaction';

test('redacts sensitive object keys while retaining safe values', () => {
  assert.deepEqual(redactValue({ token: 'test-token', tokenCount: 4, user: 'test-user' }),
    { token: '[REDACTED]', tokenCount: 4, user: 'test-user' });
});

test('redacts secrets in plain text assignments', () => {
  assert.equal(redactText('authorization: Bearer test-token token="test-value"'),
    'authorization: [REDACTED] token="[REDACTED]"');
});

test('redacts camelCase secret keys embedded in messages', () => {
  assert.equal(redactText('sessionToken=test-token userPassword: test-password clientSecret="test-value"'),
    'sessionToken=[REDACTED] userPassword: [REDACTED] clientSecret="[REDACTED]"');
});

test('redacts snake_case secret keys and leaves unrelated word:value pairs alone', () => {
  assert.equal(redactText('client_secret=test-secret api_key: "test-key"'),
    'client_secret=[REDACTED] api_key: "[REDACTED]"');
  assert.equal(redactText('tokenCount=5 retryCount=3'), 'tokenCount=5 retryCount=3',
    'a keyword embedded before other letters must not be treated as the field name');
});

test('redacts JSON raw details and fields in an event', () => {
  const event = {
    id: 1, level: 'info', message: 'token=test-token', isJson: true,
    raw: '{"user":"test-user","apiKey":"test-key","nested":{"password":"test-password"}}',
    fields: { user: 'test-user', apiKey: 'test-key' }
  };
  const redacted = redactEvent(event);
  assert.equal(redacted.message, 'token=[REDACTED]');
  assert.equal(redacted.fields?.apiKey, '[REDACTED]');
  assert.match(redacted.raw!, /\[REDACTED\]/);
  assert.doesNotMatch(redacted.raw!, /test-key|test-password/);
});

test('deep JSON never falls back to unredacted structured credentials', () => {
  const raw = '{"nested":'.repeat(10000) + '{"password":"deep-secret"}' + '}'.repeat(10000);
  const result = redactEvent({ id: 1, level: 'info', isJson: true, raw });
  assert.ok(!result.raw?.includes('deep-secret'));
  assert.ok(result.raw?.includes('[REDACTED]'));
});
