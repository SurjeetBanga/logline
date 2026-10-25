// The Connection form: what the person has typed so far, how it becomes a
// saved connection, and the messages between the form and the extension. Both
// sides check a draft with the same functions, so the form can say what is
// missing as the person types and the extension never trusts the form.

import {
  DATADOG_SITES,
  datadogApiBase,
  formatServerUrl,
  isRdsHost,
  MAPPED_FIELDS,
  decodePart,
  mongoUrl,
  normalizeConnections,
  parseServerUrl,
  secretKey,
  type ColumnInfo,
  type ConnectionConfig,
  type ConnectionType,
  type LogTableMapping,
  type MappedField,
} from './connections';

/** What the form offers: a log service, whose logs are searched, or a database, which is queried. */
export const CONNECTION_TYPES: {
  type: ConnectionType;
  kind: 'logs' | 'database';
  label: string;
  description: string;
}[] = [
  { type: 'datadog', kind: 'logs', label: 'Datadog', description: 'Search the logs of a Datadog organization' },
  { type: 'postgres', kind: 'database', label: 'Postgres', description: 'Also Aurora PostgreSQL, RDS, Cloud SQL' },
  { type: 'mysql', kind: 'database', label: 'MySQL', description: 'Also Aurora MySQL, MariaDB, RDS' },
  { type: 'mongodb', kind: 'database', label: 'MongoDB', description: 'Also Atlas, DocumentDB' },
  { type: 'sqlite', kind: 'database', label: 'SQLite', description: 'A database file on this machine' },
];

export const ROLE_LABELS: Record<MappedField, string> = {
  timestamp: 'Time',
  level: 'Level',
  message: 'Message',
  service: 'Service',
  traceId: 'Trace id',
};

/** Everything the form holds. Secrets are what was typed now; empty keeps a saved one. */
export interface FormDraft {
  type: ConnectionType;
  label: string;
  host: string;
  port: string;
  user: string;
  database: string;
  ssl: boolean;
  /** How Postgres or MySQL signs in: a password, or an AWS IAM token made with `profile` ('' for the default). */
  auth: 'password' | 'iam';
  profile: string;
  /** A MongoDB URL, without its password. */
  url: string;
  /** A SQLite file, relative to the workspace when inside it. */
  path: string;
  /** A Datadog site from DATADOG_SITES, or an API URL. */
  site: string;
  keyKind: 'keys' | 'token';
  password: string;
  apiKey: string;
  appKey: string;
  token: string;
  /** When editing, drop the saved password instead of keeping it while the field is empty. */
  forgetSecret: boolean;
}

export type DraftField = keyof FormDraft;

export function emptyDraft(type: ConnectionType = 'postgres'): FormDraft {
  return {
    type,
    label: '',
    host: 'localhost',
    port: type === 'mysql' ? '3306' : '5432',
    user: '',
    database: '',
    ssl: false,
    auth: 'password',
    profile: '',
    url: '',
    path: '',
    site: DATADOG_SITES[0],
    keyKind: 'keys',
    password: '',
    apiKey: '',
    appKey: '',
    token: '',
    forgetSecret: false,
  };
}

/** The form for a saved connection, its secrets left empty to keep them. */
export function draftFromConnection(connection: ConnectionConfig): FormDraft {
  const draft = { ...emptyDraft(connection.type), label: connection.label };
  switch (connection.type) {
    case 'postgres':
    case 'mysql':
      return {
        ...draft,
        host: connection.host,
        port: String(connection.port),
        user: connection.user,
        database: connection.database,
        ssl: connection.ssl === true,
        auth: connection.auth ? 'iam' : 'password',
        profile: connection.auth?.profile ?? '',
      };
    case 'mongodb':
      // A database set apart from the URL, such as one whose URL names only an authSource, keeps its own field.
      return {
        ...draft,
        url: connection.url,
        database: connection.database === mongoUrl(connection.url)?.database ? '' : connection.database,
      };
    case 'sqlite':
      return { ...draft, path: connection.path };
    case 'datadog':
      return { ...draft, site: connection.site };
  }
}

/** The name a new connection is offered: its database, its file, or prod for Datadog. */
export function suggestedLabel(draft: FormDraft): string {
  if (draft.type === 'datadog') return 'prod';
  if (draft.type === 'sqlite')
    return (
      draft.path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.(?:db|sqlite3?|db3)$/i, '') ?? ''
    );
  if (draft.type === 'mongodb') return draft.database.trim() || (mongoUrl(draft.url)?.database ?? '');
  return draft.database.trim();
}

/** The URL a Postgres or MySQL draft stands for, password left out. */
export function draftUrl(draft: FormDraft): string {
  const port = Number(draft.port);
  if (!draft.host.trim() || !draft.user.trim() || !draft.database.trim()) return '';
  return formatServerUrl({
    type: draft.type === 'mysql' ? 'mysql' : 'postgres',
    host: draft.host.trim(),
    port: Number.isInteger(port) && port > 0 ? port : draft.type === 'mysql' ? 3306 : 5432,
    user: draft.user.trim(),
    database: draft.database.trim(),
    ssl: draft.ssl || draft.auth === 'iam',
  });
}

/**
 * A URL typed or pasted into the form, spread over its fields. A password in
 * it moves to the password field, so it is never saved with the URL.
 */
export function applyUrl(draft: FormDraft, value: string): FormDraft | undefined {
  if (draft.type === 'mongodb') {
    // The database may be in the URL or its own field, so a URL without one is taken too.
    const password = /^\s*mongodb(?:\+srv)?:\/\/[^:@/?#]+:([^@/?#]*)@/i.exec(value)?.[1];
    const url = withoutPassword(value).trim();
    if (!mongoUrl(url)) return undefined;
    return { ...draft, url, ...(password ? { password: decodePart(password) } : {}) };
  }
  if (draft.type !== 'postgres' && draft.type !== 'mysql') return undefined;
  const parsed = parseServerUrl(value, draft.type);
  if (!parsed) return undefined;
  const connection = parsed.connection;
  return {
    ...draft,
    host: connection.host,
    port: String(connection.port),
    user: connection.user,
    database: connection.database,
    ssl: connection.ssl === true,
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}

/** A connection URL with its password taken out, as typed otherwise: `scheme://user:secret@host` → `scheme://user@host`. */
export function withoutPassword(url: string): string {
  return url.replace(/^(\s*[a-z][\w+.-]*:\/\/[^:@/?#]+):[^@/?#]*@/i, '$1@');
}

/**
 * A connection from the form, with what the form does not show kept from the
 * saved one it replaces: Datadog's indexes and an IAM region. Without this,
 * saving an edit unchanged would drop them.
 */
export function keepUnmodeled(next: ConnectionConfig, before?: ConnectionConfig): ConnectionConfig {
  if (!before || before.type !== next.type) return next;
  if (next.type === 'datadog' && before.type === 'datadog' && before.indexes && !next.indexes)
    return { ...next, indexes: before.indexes };
  if (
    (next.type === 'postgres' || next.type === 'mysql') &&
    (before.type === 'postgres' || before.type === 'mysql') &&
    next.auth &&
    before.auth?.region &&
    !next.auth.region
  )
    return { ...next, auth: { ...next.auth, region: before.auth.region } };
  return next;
}

/** Whether the form should offer AWS IAM sign-in first: the host is RDS or Aurora. */
export function suggestsIam(draft: FormDraft): boolean {
  return (draft.type === 'postgres' || draft.type === 'mysql') && isRdsHost(draft.host.trim());
}

export type DatadogSecret = { apiKey: string; appKey: string } | { token: string };

export interface DraftResult {
  /** The connection the draft describes, with id `draft`, when it is complete. */
  connection?: ConnectionConfig;
  /** What is missing or wrong, by field, worded for the person. */
  errors: Partial<Record<DraftField, string>>;
  password?: string;
  keys?: DatadogSecret;
}

/**
 * Where a draft's password or keys are kept, as for its saved connection, or
 * undefined while it is incomplete or needs none. A saved secret is used only
 * while this stays the same, so it never goes to another server or site.
 */
export function draftSecretKey(draft: FormDraft): string | undefined {
  const { connection } = readDraft(draft, { secret: true });
  return connection && connection.type !== 'sqlite' ? secretKey(connection) : undefined;
}

/**
 * Check a draft and build its connection. `saved` says which secrets are
 * already stored, so leaving them empty is allowed when editing.
 */
export function readDraft(draft: FormDraft, saved: { secret?: boolean } = {}): DraftResult {
  const errors: DraftResult['errors'] = {};
  const required = (field: DraftField, message: string) => {
    const value = draft[field];
    if (typeof value === 'string' && !value.trim()) errors[field] = message;
  };
  const password = draft.password || undefined;
  let item: Record<string, unknown> | undefined;
  let keys: DatadogSecret | undefined;
  switch (draft.type) {
    case 'postgres':
    case 'mysql': {
      required('host', 'Enter the server’s host name');
      required('user', 'Enter the user to sign in as');
      required('database', 'Enter the database');
      const port = Number(draft.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'A port from 1 to 65535';
      item = {
        type: draft.type,
        host: draft.host.trim(),
        port,
        user: draft.user.trim(),
        database: draft.database.trim(),
        ssl: draft.ssl || draft.auth === 'iam',
        ...(draft.auth === 'iam'
          ? { auth: { kind: 'iam', ...(draft.profile ? { profile: draft.profile } : {}) } }
          : {}),
      };
      break;
    }
    case 'mongodb': {
      const url = mongoUrl(draft.url);
      const database = draft.database.trim() || url?.database;
      if (!draft.url.trim()) errors.url = 'Enter a mongodb:// or mongodb+srv:// URL';
      else if (!url) errors.url = 'Enter mongodb://user@host/database or mongodb+srv://…, without a password';
      else if (!database) errors.database = 'Enter the database, here or at the end of the URL, such as …/app';
      item = { type: 'mongodb', url: draft.url.trim(), ...(database ? { database } : {}) };
      break;
    }
    case 'sqlite':
      required('path', 'Choose the database file');
      item = { type: 'sqlite', path: draft.path.trim() };
      break;
    case 'datadog':
      if (!datadogApiBase(draft.site.trim())) errors.site = 'Choose a site, or enter an https API URL';
      item = { type: 'datadog', site: draft.site.trim() };
      if (draft.keyKind === 'token') {
        if (draft.token.trim()) keys = { token: draft.token.trim() };
        else if (!saved.secret) errors.token = 'Enter an access token';
      } else if (draft.apiKey.trim() || draft.appKey.trim() || !saved.secret) {
        if (!draft.apiKey.trim()) errors.apiKey = 'Enter an API key';
        if (!draft.appKey.trim()) errors.appKey = 'Enter an application key';
        if (draft.apiKey.trim() && draft.appKey.trim())
          keys = { apiKey: draft.apiKey.trim(), appKey: draft.appKey.trim() };
      }
      break;
  }
  const [connection] = Object.keys(errors).length
    ? []
    : // The name is not part of what a test opens, so renaming after a test needs no new one.
      normalizeConnections([{ id: 'draft', label: 'draft', ...item }]);
  return {
    ...(connection ? { connection } : {}),
    errors,
    ...(password !== undefined && draft.type !== 'sqlite' && draft.type !== 'datadog' ? { password } : {}),
    ...(keys ? { keys } : {}),
  };
}

/** A draft from the form, keeping only fields of the right type; undefined when it is not one. */
export function normalizeDraft(value: unknown): FormDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!CONNECTION_TYPES.some((entry) => entry.type === item.type)) return undefined;
  const draft = emptyDraft(item.type as ConnectionType);
  for (const key of Object.keys(draft) as DraftField[]) {
    const current = draft[key];
    const next = item[key];
    if (typeof next !== typeof current) continue;
    if (typeof next === 'string' && next.length > 4096) continue;
    (draft as unknown as Record<string, unknown>)[key] = next;
  }
  if (draft.auth !== 'password' && draft.auth !== 'iam') draft.auth = 'password';
  if (draft.keyKind !== 'keys' && draft.keyKind !== 'token') draft.keyKind = 'keys';
  return draft;
}

/** A mapping from the form, checked against the columns the table has. */
export function normalizeMapping(value: unknown, columns: string[]): LogTableMapping | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.table !== 'string' || !item.table) return undefined;
  const mapping: Partial<LogTableMapping> = { table: item.table };
  for (const role of MAPPED_FIELDS) {
    const column = item[role];
    if (typeof column === 'string' && columns.includes(column)) mapping[role] = column;
  }
  return mapping.timestamp ? (mapping as LogTableMapping) : undefined;
}

/** A sample row as the form shows it: every value as short text. */
export type SampleRow = Record<string, string>;

/** Values of sample rows as short text, so the form never receives a whole document. */
export function sampleText(rows: Record<string, unknown>[], max = 120): SampleRow[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        let text: string;
        if (value === null || value === undefined) text = '';
        else if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
        else if (typeof value === 'object') {
          try {
            text = JSON.stringify(value, (_, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner));
          } catch {
            text = String(value);
          }
        } else text = String(value);
        return [key, text.length > max ? `${text.slice(0, max - 1)}…` : text];
      }),
    ),
  );
}

export interface FormProfile {
  name: string;
  description: string;
}

/** What the form asks of the extension. */
export type FormRequest =
  | { type: 'ready' }
  | { type: 'test'; draft: FormDraft }
  | { type: 'browse' }
  | { type: 'table'; table: string }
  | { type: 'save'; draft: FormDraft; mapping: LogTableMapping | null }
  | { type: 'cancel' }
  /** A Logs view starting up, which shows a form left open in an earlier one. */
  | { type: 'resume' };

/** What the extension tells the form. */
export type FormUpdate =
  | {
      type: 'init';
      mode: 'add' | 'edit';
      draft: FormDraft;
      /** When editing, the saved table and columns, chosen again once the test lists tables. */
      mapping?: LogTableMapping;
      /** Whether a password or keys are saved for the connection being edited. */
      secret: boolean;
      /** Where they are kept: they are used only while the draft's own secret key matches. */
      secretKey?: string;
      profiles: FormProfile[];
      sites: string[];
    }
  | { type: 'tested'; ok: true; detail: string; tables?: string[] }
  | { type: 'tested'; ok: false; error: string }
  | {
      type: 'columns';
      table: string;
      columns: ColumnInfo[];
      suggested: Partial<Record<MappedField, string>>;
      rows: SampleRow[];
      /** Why the preview rows could not be read; the columns can still be mapped. */
      previewError?: string;
    }
  | { type: 'columns'; table: string; error: string }
  | { type: 'file'; path: string; outside: boolean }
  | { type: 'saveFailed'; error: string }
  /** The form is done, saved or cancelled, or was replaced by another: its tab closes. */
  | { type: 'close' };
