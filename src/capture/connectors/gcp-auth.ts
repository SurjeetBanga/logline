import { createSign } from 'node:crypto';
import { join } from 'node:path';
import { systemEnvironment, type AuthEnvironment } from './aws-auth';

// Reads Google Cloud's Application Default Credentials without Google's SDK:
// the file `gcloud auth application-default login` writes, or a service
// account key named by GOOGLE_APPLICATION_CREDENTIALS, else gcloud's own token.

const SCOPE = 'https://www.googleapis.com/auth/logging.read';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

export interface GoogleToken {
  token: string;
  /** When the token stops working, in milliseconds since 1970. */
  expiresAtMs: number;
  /** The project a person's credentials bill API use to, sent as x-goog-user-project. */
  quotaProject?: string;
}

export class GoogleAuthError extends Error {}

const LOGIN = 'Run "gcloud auth application-default login", then try again.';
const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Where gcloud keeps Application Default Credentials. */
function adcPath(environment: AuthEnvironment): string {
  const { env, home } = environment;
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  return env.APPDATA && process.platform === 'win32'
    ? join(env.APPDATA, 'gcloud', 'application_default_credentials.json')
    : join(env.CLOUDSDK_CONFIG || join(home, '.config', 'gcloud'), 'application_default_credentials.json');
}

/** A service account's signed JWT, which the token endpoint exchanges for an access token. */
export function serviceAccountAssertion(
  key: { client_email: string; private_key: string; token_uri?: string },
  nowMs: number,
): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? TOKEN_URI, iat: now, exp: now + 3600 }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

async function exchange(
  environment: AuthEnvironment,
  url: string,
  form: Record<string, string>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<{ token: string; expiresAtMs: number }> {
  let response: Awaited<ReturnType<AuthEnvironment['fetch']>>;
  try {
    response = await environment.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (error) {
    throw new GoogleAuthError(`Google's sign-in could not be reached for ${what}: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token)
    throw new GoogleAuthError(
      `Google refused ${what} (${(body.error_description ?? body.error ?? `HTTP ${response.status}`).replace(/\.$/, '')}).${what === 'your sign-in' ? ` ${LOGIN}` : ''}`,
    );
  return { token: body.access_token, expiresAtMs: environment.now() + (body.expires_in ?? 3600) * 1000 };
}

/**
 * An access token to read logs, from Application Default Credentials as gcloud
 * and Google's libraries find them, else from `gcloud auth print-access-token`.
 */
export async function googleToken(
  environment: AuthEnvironment = systemEnvironment(),
  signal?: AbortSignal,
): Promise<GoogleToken> {
  const path = adcPath(environment);
  const text = environment.readFile(path);
  if (text === undefined) {
    if (environment.env.GOOGLE_APPLICATION_CREDENTIALS)
      throw new GoogleAuthError(`GOOGLE_APPLICATION_CREDENTIALS names ${path}, which cannot be read.`);
    // Without application default credentials, gcloud's own sign-in may still do.
    let token: string;
    try {
      token = (await environment.run('gcloud auth print-access-token', 30000)).trim();
    } catch {
      throw new GoogleAuthError(`No Google Cloud credentials were found. ${LOGIN}`);
    }
    if (!token) throw new GoogleAuthError(`gcloud printed no access token. ${LOGIN}`);
    // gcloud's tokens last an hour; one is asked for again well before.
    return { token, expiresAtMs: environment.now() + 30 * 60000 };
  }
  let file: Record<string, string>;
  try {
    file = JSON.parse(text) as Record<string, string>;
  } catch {
    throw new GoogleAuthError(`${path} is not a credentials file.`);
  }
  if (file.type === 'authorized_user') {
    if (!file.client_id || !file.client_secret || !file.refresh_token)
      throw new GoogleAuthError(`${path} lacks a client id, client secret, or refresh token. ${LOGIN}`);
    const token = await exchange(
      environment,
      TOKEN_URI,
      {
        grant_type: 'refresh_token',
        client_id: file.client_id,
        client_secret: file.client_secret,
        refresh_token: file.refresh_token,
      },
      signal,
      'your sign-in',
    );
    return { ...token, ...(file.quota_project_id ? { quotaProject: file.quota_project_id } : {}) };
  }
  if (file.type === 'service_account') {
    if (!file.client_email || !file.private_key)
      throw new GoogleAuthError(`${path} is a service account key without its email or private key.`);
    return exchange(
      environment,
      file.token_uri || TOKEN_URI,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: serviceAccountAssertion(
          { client_email: file.client_email, private_key: file.private_key, token_uri: file.token_uri },
          environment.now(),
        ),
      },
      signal,
      `the service account ${file.client_email}`,
    );
  }
  throw new GoogleAuthError(
    `${path} holds ${file.type || 'credentials'} credentials, which Logline cannot use on its own. Sign in with "gcloud auth application-default login", or use a service account key.`,
  );
}
