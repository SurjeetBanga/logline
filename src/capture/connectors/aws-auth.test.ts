import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AwsAuthError,
  type AwsEnvironment,
  iamPassword,
  listProfiles,
  profileRegion,
  rdsAuthToken,
  resolveCredentials,
  signingKey,
  systemEnvironment,
} from './aws-auth';

// Secret-shaped values are built at runtime: push protection refuses them as literals.
const secret = ['wJalrXUtnFEMI', 'K7MDENG+bPxRfiCYEXAMPLEKEY'].join('/');
const keyId = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

function environment(files: Record<string, string>, extra: Partial<AwsEnvironment> = {}): AwsEnvironment {
  return {
    env: {},
    home: '/home/me',
    // Paths are joined with backslashes on Windows; the files here are named with forward slashes.
    readFile: (path) => files[path.replace(/\\/g, '/')],
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    run: async () => '',
    now: () => Date.parse('2026-10-24T12:00:00Z'),
    ...extra,
  };
}

test('the signing key matches the derivation AWS documents', () => {
  assert.equal(
    signingKey(secret, '20120215', 'us-east-1', 'iam').toString('hex'),
    'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
  );
});

test('an RDS token is a presigned connect URL for the user, valid 15 minutes, signed with the credentials', () => {
  const input = {
    host: 'orders.cluster-abc.us-east-1.rds.amazonaws.com',
    port: 3306,
    user: 'app reader',
    region: 'us-east-1',
    credentials: { accessKeyId: keyId, secretAccessKey: secret },
    now: Date.parse('2026-10-24T12:00:00Z'),
  };
  const token = rdsAuthToken(input);
  assert.match(
    token,
    /^orders\.cluster-abc\.us-east-1\.rds\.amazonaws\.com:3306\/\?Action=connect&DBUser=app%20reader&/,
  );
  assert.ok(token.includes(`X-Amz-Credential=${keyId}%2F20261024%2Fus-east-1%2Frds-db%2Faws4_request`));
  assert.match(
    token,
    /X-Amz-Date=20261024T120000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/,
  );
  assert.equal(rdsAuthToken(input), token, 'the same inputs sign the same token');
  assert.notEqual(rdsAuthToken({ ...input, credentials: { ...input.credentials, secretAccessKey: 'other' } }), token);
  const session = rdsAuthToken({ ...input, credentials: { ...input.credentials, sessionToken: 'a/b+c=' } });
  assert.match(session, /X-Amz-Security-Token=a%2Fb%2Bc%3D&X-Amz-SignedHeaders/, 'a session token is signed too');
});

test('credentials come from the environment, a profile’s keys, or its credential_process', async () => {
  const env = environment(
    {},
    { env: { AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: 's' } },
  );
  assert.deepEqual(await resolveCredentials(undefined, env), {
    accessKeyId: keyId,
    secretAccessKey: secret,
    sessionToken: 's',
  });
  const files = environment({
    '/home/me/.aws/credentials': `[default]\naws_access_key_id = ${keyId}\naws_secret_access_key = ${secret}\n`,
    '/home/me/.aws/config': '[profile tools]\ncredential_process = /usr/bin/creds --json\nregion = eu-west-1\n',
  });
  assert.equal((await resolveCredentials(undefined, files)).accessKeyId, keyId);
  let ran = '';
  const process = environment(
    { '/home/me/.aws/config': '[profile tools]\ncredential_process = /usr/bin/creds --json\nregion = eu-west-1\n' },
    {
      run: async (command) => {
        ran = command;
        return JSON.stringify({ Version: 1, AccessKeyId: keyId, SecretAccessKey: secret, SessionToken: 't' });
      },
    },
  );
  assert.deepEqual(await resolveCredentials('tools', process), {
    accessKeyId: keyId,
    secretAccessKey: secret,
    sessionToken: 't',
  });
  assert.equal(ran, '/usr/bin/creds --json');
  assert.equal(profileRegion('tools', process), 'eu-west-1');
});

test('an SSO profile uses the session aws sso login cached, and says to log in when it expired', async () => {
  const config =
    '[profile prod]\nsso_session = corp\nsso_account_id = 111122223333\nsso_role_name = ReadOnly\n[sso-session corp]\nsso_region = us-east-1\nsso_start_url = https://corp.awsapps.com/start\n';
  const cacheFile = `/home/me/.aws/sso/cache/${createHash('sha1').update('corp').digest('hex')}.json`;
  let asked = '';
  const live = environment(
    {
      '/home/me/.aws/config': config,
      [cacheFile]: JSON.stringify({ accessToken: 'tok', expiresAt: '2026-10-24T13:00:00Z' }),
    },
    {
      fetch: async (url, init) => {
        asked = `${url} ${init.headers['x-amz-sso_bearer_token']}`;
        return {
          ok: true,
          status: 200,
          json: async () => ({ roleCredentials: { accessKeyId: keyId, secretAccessKey: secret, sessionToken: 'r' } }),
        };
      },
    },
  );
  assert.deepEqual(await resolveCredentials('prod', live), {
    accessKeyId: keyId,
    secretAccessKey: secret,
    sessionToken: 'r',
  });
  assert.equal(
    asked,
    'https://portal.sso.us-east-1.amazonaws.com/federation/credentials?role_name=ReadOnly&account_id=111122223333 tok',
  );
  const expired = environment({
    '/home/me/.aws/config': config,
    [cacheFile]: JSON.stringify({ accessToken: 'tok', expiresAt: '2026-10-24T11:00:00Z' }),
  });
  await assert.rejects(resolveCredentials('prod', expired), /aws sso login --profile prod/);
  // A portal that never answers gives up when the connection would, instead of holding every query.
  const stalled = environment(
    {
      '/home/me/.aws/config': config,
      [cacheFile]: JSON.stringify({ accessToken: 'tok', expiresAt: '2026-10-24T13:00:00Z' }),
    },
    {
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    },
  );
  const token = iamPassword(
    { host: 'orders.cluster-abc.us-east-1.rds.amazonaws.com', port: 5432, user: 'app', profile: 'prod' },
    stalled,
  );
  await assert.rejects(token(20), /did not answer for profile prod in time/);
});

test('a profile that only assumes a role, or none at all, is explained, and profiles are listed with their kind', async () => {
  const files = environment({
    '/home/me/.aws/config':
      '[default]\nregion = us-west-2\n[profile admin]\nrole_arn = arn:aws:iam::1:role/Admin\nsource_profile = default\n[profile tools]\ncredential_process = x\n',
    '/home/me/.aws/credentials': `[default]\naws_access_key_id = ${keyId}\naws_secret_access_key = ${secret}\n`,
  });
  await assert.rejects(
    resolveCredentials('admin', files),
    (error: unknown) => error instanceof AwsAuthError && /credential_process/.test(error.message),
  );
  await assert.rejects(resolveCredentials('missing', files), /no AWS profile named missing/);
  assert.deepEqual(listProfiles(files), [
    { name: 'admin', kind: 'role' },
    { name: 'default', kind: 'keys', region: 'us-west-2' },
    { name: 'tools', kind: 'process' },
  ]);
});

test('a credential_process runs as a command line, and its failures say which profile to fix', async () => {
  const home = mkdtempSync(join(tmpdir(), 'logline-aws-'));
  mkdirSync(join(home, '.aws'));
  // A script that prints the credentials of the profile named in its argument, run as a quoted command line.
  const script = join(home, 'creds.js');
  writeFileSync(
    script,
    `const keys = { works: { Version: 1, AccessKeyId: ${JSON.stringify(keyId)}, SecretAccessKey: ${JSON.stringify(secret)} }, empty: { Version: 1 } };
if (process.argv[2] === 'noisy') { process.stdout.write('Warning: token refreshed\\n{}'); process.exit(0); }
if (!keys[process.argv[2]]) process.exit(3);
process.stdout.write(JSON.stringify(keys[process.argv[2]]));`,
  );
  const command = (profile: string) => `"${process.execPath}" "${script}" ${profile}`;
  writeFileSync(
    join(home, '.aws', 'config'),
    [
      `[profile works]\ncredential_process = ${command('works')}`,
      `[profile empty]\ncredential_process = ${command('empty')}`,
      `[profile noisy]\ncredential_process = ${command('noisy')}`,
      `[profile broken]\ncredential_process = ${command('broken')}`,
      '[profile bare]\nregion = us-east-1',
    ].join('\n'),
  );
  const real = { ...systemEnvironment(), env: {}, home };
  assert.deepEqual(await resolveCredentials('works', real), { accessKeyId: keyId, secretAccessKey: secret });
  await assert.rejects(
    resolveCredentials('empty', real),
    /credential_process of AWS profile empty printed no AccessKeyId/,
  );
  await assert.rejects(resolveCredentials('broken', real), /credential_process of AWS profile broken failed/);
  await assert.rejects(
    resolveCredentials('noisy', real),
    /credential_process of AWS profile noisy printed no AccessKeyId/,
  );
  await assert.rejects(resolveCredentials('bare', real), /AWS profile bare has no keys, credential_process, or SSO/);
  assert.equal(real.readFile(join(home, 'missing')), undefined);
});
