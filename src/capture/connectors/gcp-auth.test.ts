import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { AuthEnvironment } from './aws-auth';
import { GoogleAuthError, googleToken, serviceAccountAssertion } from './gcp-auth';

const NOW = Date.parse('2026-11-01T12:00:00Z');
// Generated at runtime: key-shaped literals look like leaked secrets to scanners.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ADC = '/home/me/.config/gcloud/application_default_credentials.json';

function environment(files: Record<string, string>, extra: Partial<AuthEnvironment> = {}) {
  const sent: { url: string; body: URLSearchParams }[] = [];
  const env: AuthEnvironment = {
    env: {},
    home: '/home/me',
    readFile: (path) => files[path.replace(/\\/g, '/')],
    fetch: async (url, init) => {
      sent.push({ url, body: new URLSearchParams(init.body ?? '') });
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.token', expires_in: 3599 }) };
    },
    run: async () => {
      throw new Error('gcloud: command not found');
    },
    now: () => NOW,
    ...extra,
  };
  return { env, sent };
}

test('a person’s sign-in from gcloud is exchanged for a token, billed to its quota project', async () => {
  const secret = ['client', 'secret'].join('-');
  const { env, sent } = environment({
    [ADC]: JSON.stringify({
      type: 'authorized_user',
      client_id: 'id',
      client_secret: secret,
      refresh_token: 'refresh',
      quota_project_id: 'billing',
    }),
  });
  assert.deepEqual(await googleToken(env), {
    token: 'ya29.token',
    expiresAtMs: NOW + 3599000,
    quotaProject: 'billing',
  });
  assert.equal(sent[0].url, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(Object.fromEntries(sent[0].body), {
    grant_type: 'refresh_token',
    client_id: 'id',
    client_secret: secret,
    refresh_token: 'refresh',
  });
});

test('a service account key signs a JWT for reading logs, which its token endpoint exchanges', async () => {
  const key = {
    type: 'service_account',
    client_email: 'reader@p.iam.gserviceaccount.com',
    private_key: PRIVATE_KEY,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const { env, sent } = environment(
    { '/keys/reader.json': JSON.stringify(key) },
    { env: { GOOGLE_APPLICATION_CREDENTIALS: '/keys/reader.json' } },
  );
  assert.equal((await googleToken(env)).token, 'ya29.token');
  assert.equal(sent[0].body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = sent[0].body.get('assertion')!;
  assert.equal(assertion, serviceAccountAssertion(key, NOW));
  const [header, claims, signature] = assertion.split('.');
  assert.ok(
    createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')),
  );
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: 'reader@p.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/logging.read',
    aud: 'https://oauth2.googleapis.com/token',
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
  });
});

test('without credentials gcloud’s own token is used, and what cannot sign in says how to', async () => {
  const { env } = environment(
    {},
    { run: async (command) => (command === 'gcloud auth print-access-token' ? 'ya29.gcloud\n' : '') },
  );
  assert.deepEqual(await googleToken(env), { token: 'ya29.gcloud', expiresAtMs: NOW + 30 * 60000 });
  await assert.rejects(googleToken(environment({}).env), {
    message: 'No Google Cloud credentials were found. Run "gcloud auth application-default login", then try again.',
  });
  await assert.rejects(
    googleToken(environment({ [ADC]: JSON.stringify({ type: 'external_account' }) }).env),
    /holds external_account credentials, which Logline cannot use on its own/,
  );
  const refused = environment(
    { [ADC]: JSON.stringify({ type: 'authorized_user', client_id: 'id', client_secret: 's', refresh_token: 'r' }) },
    {
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      }),
    },
  );
  await assert.rejects(
    googleToken(refused.env),
    (error: Error) =>
      error instanceof GoogleAuthError &&
      /\(Token has been expired or revoked\)\. Run "gcloud auth application-default login"/.test(error.message),
  );
});
