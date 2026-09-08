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

