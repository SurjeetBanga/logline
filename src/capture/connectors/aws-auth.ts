import { exec } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rdsRegion } from '../../core/connections';

// Signs Amazon RDS and Aurora IAM auth tokens without the AWS SDK: a token is a
// SigV4 presigned `rds-db:connect` URL, valid for 15 minutes, sent as the
// password over TLS. Credentials come from the same places the AWS CLI reads.

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A profile in ~/.aws/config or ~/.aws/credentials, and how it gets its credentials. */
export interface AwsProfile {
  name: string;
  kind: 'keys' | 'sso' | 'process' | 'role';
  region?: string;
}

/** What reading credentials touches, so tests can stand in for files, the network, and processes. */
export interface AwsEnvironment {
  env: NodeJS.ProcessEnv;
  home: string;
  readFile(path: string): string | undefined;
  fetch(
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  run(command: string, timeoutMs: number): Promise<string>;
  now(): number;
}

export function systemEnvironment(): AwsEnvironment {
  return {
    env: process.env,
    home: homedir(),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    fetch: (url, init) => fetch(url, init),
    // credential_process is a command line, as the AWS CLI runs it.
    // exec runs it in the platform's shell, keeping quoted paths intact on Windows too.
    run: (command, timeoutMs) =>
      new Promise((resolve, reject) =>
        exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
          error ? reject(error) : resolve(String(stdout)),
        ),
      ),
    now: () => Date.now(),
  };
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();
// SigV4 encodes everything but unreserved characters, which encodeURIComponent leaves a few more of.
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The SigV4 signing key for a day, region, and service. */
export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const day = hmac(`AWS4${secretAccessKey}`, date);
  return hmac(hmac(hmac(day, region), service), 'aws4_request');
}

/** A token to sign in to an RDS or Aurora database as `user`, valid for 15 minutes from `now`. */
export function rdsAuthToken(input: {
  host: string;
  port: number;
  user: string;
  region: string;
  credentials: AwsCredentials;
  now: number;
}): string {
  const stamp = new Date(input.now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = stamp.slice(0, 8);
  const scope = `${date}/${input.region}/rds-db/aws4_request`;
  const host = `${input.host}:${input.port}`;
  const query: [string, string][] = [
    ['Action', 'connect'],
    ['DBUser', input.user],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', '900'],
    ...(input.credentials.sessionToken
      ? [['X-Amz-Security-Token', input.credentials.sessionToken] as [string, string]]
      : []),
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = ['GET', '/', canonicalQuery, `host:${host}\n`, 'host', sha256('')].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, date, input.region, 'rds-db'))
    .update(toSign, 'utf8')
    .digest('hex');
  return `${host}/?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Sections of an AWS INI file, by name. */
export function parseIni(text: string | undefined): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1].trim(), current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current[pair[1].toLowerCase()] = pair[2];
  }
  return sections;
}

function files(environment: AwsEnvironment) {
  const { env, home } = environment;
  const credentials = parseIni(
    environment.readFile(env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials')),
  );
  const config = parseIni(environment.readFile(env.AWS_CONFIG_FILE || join(home, '.aws', 'config')));
  // In config, a profile's section is [profile name], except [default].
  const profile = (name: string) =>
    config.get(name === 'default' ? 'default' : `profile ${name}`) ??
    (name === 'default' ? undefined : config.get(name));
  return { credentials, config, profile };
}

/** Every profile in the shared files, with how it signs in, for choosing one. */
export function listProfiles(environment: AwsEnvironment = systemEnvironment()): AwsProfile[] {
  const { credentials, config, profile } = files(environment);
  const names = new Set<string>([...credentials.keys()]);
  for (const section of config.keys()) {
    if (section === 'default') names.add('default');
    else if (section.startsWith('profile ')) names.add(section.slice('profile '.length).trim());
  }
  return [...names].sort().map((name) => {
    const settings = { ...profile(name), ...credentials.get(name) };
    const kind: AwsProfile['kind'] = settings.aws_access_key_id
      ? 'keys'
      : settings.credential_process
        ? 'process'
        : settings.sso_session || settings.sso_start_url
          ? 'sso'
          : 'role';
    return { name, kind, ...(settings.region ? { region: settings.region } : {}) };
  });
}

export class AwsAuthError extends Error {}

/**
 * Credentials the way the AWS CLI finds them: the environment, unless a
 * profile is named; then the profile's keys, its credential_process, or its
 * SSO session from `aws sso login`.
 */
export async function resolveCredentials(
  profileName: string | undefined,
  environment: AwsEnvironment = systemEnvironment(),
  signal?: AbortSignal,
): Promise<AwsCredentials> {
  const { env } = environment;
  if (!profileName && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    };
  const name = profileName || env.AWS_PROFILE || 'default';
  const { credentials, config, profile } = files(environment);
  const settings = { ...profile(name), ...credentials.get(name) };
  if (!profile(name) && !credentials.get(name))
    throw new AwsAuthError(`There is no AWS profile named ${name} in ~/.aws/config or ~/.aws/credentials.`);
  if (settings.aws_access_key_id && settings.aws_secret_access_key)
    return {
      accessKeyId: settings.aws_access_key_id,
      secretAccessKey: settings.aws_secret_access_key,
      ...(settings.aws_session_token ? { sessionToken: settings.aws_session_token } : {}),
    };
  if (settings.credential_process) {
    let output: string;
    try {
      output = await environment.run(settings.credential_process, 30_000);
    } catch (error) {
      throw new AwsAuthError(`The credential_process of AWS profile ${name} failed: ${(error as Error).message}`);
    }
    const parsed = JSON.parse(output) as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
    if (!parsed.AccessKeyId || !parsed.SecretAccessKey)
      throw new AwsAuthError(
        `The credential_process of AWS profile ${name} printed no AccessKeyId and SecretAccessKey.`,
      );
    return {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      ...(parsed.SessionToken ? { sessionToken: parsed.SessionToken } : {}),
    };
  }
  if (settings.sso_session || settings.sso_start_url) return sso(name, settings, config, environment, signal);
  if (settings.role_arn)
    throw new AwsAuthError(
      `AWS profile ${name} assumes a role, which Logline cannot do on its own. Use a profile with keys or SSO, or give this one a credential_process such as "aws configure export-credentials --profile ${name}".`,
    );
  throw new AwsAuthError(`AWS profile ${name} has no keys, credential_process, or SSO session.`);
}

async function sso(
  name: string,
  settings: Record<string, string>,
  config: Map<string, Record<string, string>>,
  environment: AwsEnvironment,
  signal?: AbortSignal,
): Promise<AwsCredentials> {
  const session = settings.sso_session ? config.get(`sso-session ${settings.sso_session}`) : undefined;
  const region = session?.sso_region ?? settings.sso_region;
  const account = settings.sso_account_id;
  const role = settings.sso_role_name;
  if (!region || !account || !role)
    throw new AwsAuthError(`AWS profile ${name} needs sso_region, sso_account_id, and sso_role_name.`);
  // `aws sso login` caches the token under the SHA-1 of the session name, or of the start URL for older profiles.
  const key = createHash('sha1')
    .update(settings.sso_session ?? settings.sso_start_url, 'utf8')
    .digest('hex');
  const cached = environment.readFile(join(environment.home, '.aws', 'sso', 'cache', `${key}.json`));
  const token = cached ? (JSON.parse(cached) as { accessToken?: string; expiresAt?: string }) : undefined;
  const login = `Run "aws sso login --profile ${name}", then try again.`;
  if (!token?.accessToken || !token.expiresAt || Date.parse(token.expiresAt) <= environment.now())
    throw new AwsAuthError(`The SSO session of AWS profile ${name} has expired or was never started. ${login}`);
  let response: Awaited<ReturnType<AwsEnvironment['fetch']>>;
  try {
    response = await environment.fetch(
      `https://portal.sso.${region}.amazonaws.com/federation/credentials?role_name=${encode(role)}&account_id=${encode(account)}`,
      { headers: { 'x-amz-sso_bearer_token': token.accessToken }, signal },
    );
  } catch (error) {
    if (signal?.aborted)
      throw new AwsAuthError(`AWS SSO did not answer for profile ${name} in time. Check your network or VPN.`);
    throw new AwsAuthError(`AWS SSO could not be reached for profile ${name}: ${(error as Error).message}`);
  }
  if (!response.ok)
    throw new AwsAuthError(`AWS SSO refused the session of profile ${name} (HTTP ${response.status}). ${login}`);
  const { roleCredentials } = (await response.json()) as {
    roleCredentials?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
  };
  if (!roleCredentials?.accessKeyId || !roleCredentials.secretAccessKey)
    throw new AwsAuthError(`AWS SSO returned no credentials for profile ${name}. ${login}`);
  return {
    accessKeyId: roleCredentials.accessKeyId,
    secretAccessKey: roleCredentials.secretAccessKey,
    ...(roleCredentials.sessionToken ? { sessionToken: roleCredentials.sessionToken } : {}),
  };
}

/** The region of a profile in the shared config, for databases whose host does not say. */
export function profileRegion(
  name: string | undefined,
  environment: AwsEnvironment = systemEnvironment(),
): string | undefined {
  const profile = name || environment.env.AWS_PROFILE || 'default';
  return (
    environment.env.AWS_REGION || environment.env.AWS_DEFAULT_REGION || files(environment).profile(profile)?.region
  );
}

/**
 * A password for a database that signs in with IAM: a new token each time
 * one is asked for, since each lasts 15 minutes and is only checked when a
 * connection opens.
 */
export function iamPassword(
  target: { host: string; port: number; user: string; profile?: string; region?: string },
  environment: AwsEnvironment = systemEnvironment(),
): (timeoutMs?: number) => Promise<string> {
  // A connection waits for its token, so the token waits no longer than the connection would.
  return async (timeoutMs = 30_000) => {
    const region = target.region ?? rdsRegion(target.host) ?? profileRegion(target.profile, environment);
    if (!region)
      throw new AwsAuthError(
        `The region of ${target.host} is not in its name: set "region" in the connection's "auth" in logline.connections.`,
      );
    const credentials = await resolveCredentials(target.profile, environment, AbortSignal.timeout(timeoutMs));
    return rdsAuthToken({ ...target, region, credentials, now: environment.now() });
  };
}

/** Amazon RDS certificate authorities, which RDS and Aurora endpoints present for TLS. */
export function rdsCertificates(): string[] {
  const bundled = join(__dirname, '..', '..', 'vendor', 'aws-ssl-profiles.js');
  // The package bundles them into out/vendor; tests and development builds load them from node_modules.
  const module = require(existsSync(bundled) ? bundled : 'aws-ssl-profiles') as { ca: string[] };
  return module.ca;
}
