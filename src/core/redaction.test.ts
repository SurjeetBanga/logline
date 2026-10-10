import assert from 'node:assert/strict';
import test from 'node:test';
import { redactEvent, redactText, redactValue } from './redaction';

test('redacts sensitive object keys while retaining safe values', () => {
  assert.deepEqual(redactValue({ token: 'test-token', tokenCount: 4, user: 'test-user' }), {
    token: '[REDACTED]',
    tokenCount: 4,
    user: 'test-user',
  });
});

test('redacts secrets in plain text assignments', () => {
  assert.equal(
    redactText('authorization: Bearer test-token token="test-value"'),
    'authorization: [REDACTED] token="[REDACTED]"',
  );
});

test('redacts camelCase secret keys embedded in messages', () => {
  assert.equal(
    redactText('sessionToken=test-token userPassword: test-password clientSecret="test-value"'),
    'sessionToken=[REDACTED] userPassword: [REDACTED] clientSecret="[REDACTED]"',
  );
});

test('redacts snake_case secret keys and leaves unrelated word:value pairs alone', () => {
  assert.equal(
    redactText('client_secret=test-secret api_key: "test-key"'),
    'client_secret=[REDACTED] api_key: "[REDACTED]"',
  );
  assert.equal(
    redactText('tokenCount=5 retryCount=3'),
    'tokenCount=5 retryCount=3',
    'a keyword embedded before other letters must not be treated as the field name',
  );
});

test('redacts JSON raw details and fields in an event', () => {
  const event = {
    id: 1,
    level: 'info',
    message: 'token=test-token',
    isJson: true,
    raw: '{"user":"test-user","apiKey":"test-key","nested":{"password":"test-password"}}',
    fields: { user: 'test-user', apiKey: 'test-key' },
  };
  const redacted = redactEvent(event);
  assert.equal(redacted.message, 'token=[REDACTED]');
  assert.equal(redacted.fields?.apiKey, '[REDACTED]');
  assert.match(redacted.raw!, /\[REDACTED\]/);
  assert.doesNotMatch(redacted.raw!, /test-key|test-password/);
});

test('redacts quoted keys, incomplete JSON, and JSON embedded in messages', () => {
  assert.equal(redactText('{"token":"secret"'), '{"token":"[REDACTED]"');
  assert.equal(
    redactText('message="payload {\\"apiKey\\":\\"secret\\"}"'),
    'message="payload {\\"apiKey\\":\\"[REDACTED]\\"}"',
  );
});

test('apostrophes and quoted phrases do not stop redaction', () => {
  assert.equal(redactText("Don't log password=hunter2"), "Don't log password=[REDACTED]");
  assert.equal(redactText('error "failed password=hunter2" occurred'), 'error "failed password=[REDACTED]" occurred');
  assert.equal(redactText("it's 'quoted' then token=abc"), "it's 'quoted' then token=[REDACTED]");
});

test('redacts secrets inside unquoted non-sensitive values such as URLs', () => {
  assert.equal(
    redactText('redirect=https://x/cb?access_token=abc123&state=ok'),
    'redirect=https://x/cb?access_token=[REDACTED]',
  );
  assert.equal(
    redactText('url=https://x/cb?a=1&token=abc next=fine'),
    'url=https://x/cb?a=1&token=[REDACTED] next=fine',
  );
});

test('redaction stays linear on long chained assignments', () => {
  const text = 'a='.repeat(50_000);
  const started = Date.now();
  assert.equal(redactText(text), text);
  assert.ok(Date.now() - started < 500, 'rescanning nested values should not be quadratic');
});

test('redaction stays linear on long ordinary text', () => {
  const text = 'safe '.repeat(20_000);
  const started = Date.now();
  assert.equal(redactText(text), text);
  assert.ok(Date.now() - started < 500, 'ordinary redaction should not backtrack');
});

test('deep JSON never falls back to unredacted structured credentials', () => {
  const raw = '{"nested":'.repeat(10000) + '{"password":"deep-secret"}' + '}'.repeat(10000);
  const result = redactEvent({ id: 1, level: 'info', isJson: true, raw });
  assert.ok(!result.raw?.includes('deep-secret'));
  assert.ok(result.raw?.includes('[REDACTED]'));
});

test('redacts flattened aliases of nested sensitive fields', () => {
  const result = redactEvent({
    id: 2,
    level: 'info',
    isJson: true,
    raw: '{"credentials":{"value":"nested-secret"}}',
    fields: { 'credentials.value': 'nested-secret', value: 'nested-secret' },
  });
  assert.equal(result.fields?.['credentials.value'], '[REDACTED]');
  assert.equal(result.fields?.value, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(result), /nested-secret/);
});

test('redacts task dependency labels in event metadata', () => {
  const result = redactEvent({ id: 3, level: 'info', dependencies: ['safe', 'token=dependency-secret'] });
  assert.deepEqual(result.dependencies, ['safe', 'token=[REDACTED]']);
});

test('redacts only aliases of a sensitive path, not fields that share its value', () => {
  const result = redactEvent({
    id: 4,
    level: 'info',
    isJson: true,
    raw: '{"user":{"password_reset":false},"success":false,"statusCode":200,"api_key_id":200}',
    fields: { 'user.password_reset': false, password_reset: false, success: false, statusCode: 200, api_key_id: 200 },
  });
  assert.equal(result.fields?.['user.password_reset'], '[REDACTED]');
  assert.equal(result.fields?.password_reset, '[REDACTED]');
  assert.equal(result.fields?.api_key_id, '[REDACTED]');
  assert.equal(result.fields?.success, false);
  assert.equal(result.fields?.statusCode, 200);
});

test('redacts a deeper alias and the nested path of a sensitive parent', () => {
  const result = redactEvent({
    id: 5,
    level: 'info',
    isJson: true,
    raw: '{"secret":{"inner":{"value":"deep-secret"}},"note":"value"}',
    fields: { 'secret.inner.value': 'deep-secret', 'secret.inner': 'x', value: 'deep-secret', note: 'value' },
  });
  assert.equal(result.fields?.['secret.inner.value'], '[REDACTED]');
  assert.equal(result.fields?.value, '[REDACTED]');
  assert.equal(result.fields?.note, 'value');
});

test('redacts credentials recognizable by value even without a sensitive key', () => {
  const github = 'ghp_' + 'a'.repeat(36);
  assert.equal(redactText(`calling github with ${github} now`), 'calling github with [REDACTED] now');
  // Fixtures are assembled at runtime so secret scanners do not mistake them for real keys.
  assert.equal(redactText(`aws key ${'AKIA' + 'ABCDEFGHIJKLMNOP'} used`), 'aws key [REDACTED] used');
  assert.equal(
    redactText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijklmnop ok'),
    'jwt [REDACTED] ok',
  );
  assert.equal(redactText(`stripe ${'sk_' + 'live_' + 'a'.repeat(24)}`), 'stripe [REDACTED]');
  assert.equal(redactText(`slack ${'xox' + 'b-' + '1'.repeat(10)}-abcdef`), 'slack [REDACTED]');
  assert.equal(redactText('sent Bearer abcdefghijklmnopqrstuv upstream'), 'sent Bearer [REDACTED] upstream');
  assert.equal(
    redactText('-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA\\n-----END RSA PRIVATE KEY----- loaded'),
    '[REDACTED] loaded',
  );
});

test('redacts the password in a URL and keeps the rest of it', () => {
  assert.equal(
    redactText('connect postgres://admin:hunter2@db:5432/app'),
    'connect postgres://admin:[REDACTED]@db:5432/app',
  );
  assert.equal(redactText('GET https://example.com:8443/path?q=1'), 'GET https://example.com:8443/path?q=1');
  assert.equal(redactText('mailto user@example.com at http://host/a@b'), 'mailto user@example.com at http://host/a@b');
});

test('value-pattern redaction reaches structured fields and raw JSON', () => {
  const token = 'ghp_' + 'b'.repeat(36);
  const event = redactEvent({
    id: 1,
    level: 'info',
    message: `using ${token}`,
    fields: { note: `token was ${token}` },
    raw: JSON.stringify({ msg: `using ${token}`, url: 'redis://default:s3cret@cache:6379' }),
  });
  assert.equal(event.message, 'using [REDACTED]');
  assert.equal(event.fields!.note, 'token was [REDACTED]');
  assert.doesNotMatch(event.raw!, /ghp_|s3cret/);
});
