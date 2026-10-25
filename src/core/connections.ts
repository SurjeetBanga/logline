// Saved connections to log stores outside the editor: the `logline.connections`
// setting. Secrets (passwords) never appear here; the VS Code adapter keeps
// them in secret storage under `secretKey`.

export type ConnectionType = 'sqlite' | 'postgres' | 'mysql' | 'mongodb' | 'datadog';
/** How a timestamp column stores time; `native` is a database date/time type. */
export type TimeEncoding = 'iso' | 'epoch_s' | 'epoch_ms' | 'native';

/** Which columns of a log table hold the fields every event has. */
export interface LogTableMapping {
  table: string;
  timestamp: string;
  level?: string;
  message?: string;
  service?: string;
  traceId?: string;
  /** Detected from the column when left out. */
  timestampFormat?: Exclude<TimeEncoding, 'native'>;
}

interface BaseConnection {
  id: string;
  label: string;
  logs?: LogTableMapping;
}
export interface SqliteConnection extends BaseConnection {
  type: 'sqlite';
  /** Absolute, or relative to the first workspace folder. */
  path: string;
}
/** Sign in to Amazon RDS or Aurora with a short-lived token signed by AWS credentials, instead of a password. */
export interface IamAuth {
  kind: 'iam';
  /** The AWS profile whose credentials sign the token; the default chain when left out. */
  profile?: string;
  /** The region of the database; read from its host name when left out. */
  region?: string;
}
export interface PostgresConnection extends BaseConnection {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: boolean;
  auth?: IamAuth;
}
export interface MysqlConnection extends BaseConnection {
  type: 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: boolean;
  auth?: IamAuth;
}
/** A MongoDB deployment. Its log collection is the mapping's `table`. */
export interface MongoConnection extends BaseConnection {
  type: 'mongodb';
  /** A mongodb:// or mongodb+srv:// URL without a password. */
  url: string;
  database: string;
}
export interface DatadogConnection extends BaseConnection {
  type: 'datadog';
  /** A Datadog site such as `datadoghq.eu`, or the URL of its API. */
  site: string;
  /** Log indexes to search; all when left out. */
  indexes?: string[];
}
export type ConnectionConfig =
  SqliteConnection | PostgresConnection | MysqlConnection | MongoConnection | DatadogConnection;

/** Datadog's sites, by the domain their web app is on. */
export const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'ddog-gov.com',
];

/**
 * The API a Datadog site answers on. A URL is accepted too, for proxies; over
 * plain http only on this machine, since requests carry the keys.
 */
export function datadogApiBase(site: string): string | undefined {
  if (DATADOG_SITES.includes(site)) return `https://api.${site}`;
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    return undefined;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The roles a mapping can assign, in the order the setup asks for them. */
export const MAPPED_FIELDS = ['timestamp', 'level', 'message', 'service', 'traceId'] as const;
export type MappedField = (typeof MAPPED_FIELDS)[number];

const TYPE_NAMES: Record<ConnectionType, string> = {
  sqlite: 'SQLite',
  postgres: 'Postgres',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  datadog: 'Datadog',
};
const SOURCE_PREFIX = 'conn:';

/** The source id that a connection's runs are captured under. */
export function connectionSourceId(id: string): string {
  return `${SOURCE_PREFIX}${id}`;
}

/** The connection id behind a source id, for sources that belong to a connection. */
export function connectionIdOf(sourceId: string | undefined): string | undefined {
  return sourceId?.startsWith(SOURCE_PREFIX) ? sourceId.slice(SOURCE_PREFIX.length) : undefined;
}

export function connectionLabel(connection: Pick<ConnectionConfig, 'type' | 'label'>): string {
  return `${TYPE_NAMES[connection.type]} · ${connection.label}`;
}

/**
 * Where a connection's password or keys are kept: by the database or API they
 * open, so the same one is shared across workspaces, and a workspace that
 * points a connection elsewhere never receives them.
 */
export function secretKey(connection: Exclude<ConnectionConfig, SqliteConnection>): string {
  if (connection.type === 'datadog')
    return `logline.connection.datadog:${datadogApiBase(connection.site) ?? connection.site}`;
  if (connection.type === 'mongodb') {
    const url = mongoUrl(connection.url);
    return `logline.connection.mongodb://${url ? `${url.user ? `${encodeURIComponent(url.user)}@` : ''}${url.hosts}` : connection.url}/${encodeURIComponent(connection.database)}`;
  }
  return `logline.connection.${connection.type}://${encodeURIComponent(connection.user)}@${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`;
}

/** A URL part decoded, or as typed while a stray `%` makes it unreadable, such as a password typed in a URL. */
export function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** How many rows a preview reads: 1 to 50. */
export function sampleLimit(limit: unknown): number {
  return Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 1));
}

/** Whether a host is an Amazon RDS or Aurora endpoint, which can sign in with AWS IAM. */
export function isRdsHost(host: string): boolean {
  return /\.rds\.amazonaws\.com(?:\.cn)?$/i.test(host);
}

/** The AWS region in an RDS or Aurora host name, such as `us-east-1`. */
export function rdsRegion(host: string): string | undefined {
  return /\.([a-z]{2}(?:-gov)?-[a-z]+-\d+)\.rds\.amazonaws\.com(?:\.cn)?$/i.exec(host)?.[1]?.toLowerCase();
}

/**
 * The parts of a MongoDB URL that identify a deployment: its scheme, hosts,
 * and user. A URL with a password, a path other than a database, or anything
 * that is not mongodb:// or mongodb+srv:// is refused.
 */
export function mongoUrl(
  value: string,
): { srv: boolean; hosts: string; user?: string; database?: string; options: string } | undefined {
  const match = /^mongodb(\+srv)?:\/\/(?:([^:@/?#]+)@)?([^/?#@]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(value.trim());
  if (!match) return undefined;
  const [, srv, user, hosts, database, options] = match;
  if (!hosts || /\s/.test(hosts)) return undefined;
  return {
    srv: Boolean(srv),
    hosts,
    ...(user ? { user: decodePart(user) } : {}),
    ...(database ? { database: decodePart(database) } : {}),
    options: options ?? '',
  };
}

function normalizeAuth(value: unknown): IamAuth | undefined {
  if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'iam') return undefined;
  const item = value as Record<string, unknown>;
  const profile = text(item.profile, 128);
  const region = text(item.region, 32);
  return {
    kind: 'iam',
    ...(profile ? { profile } : {}),
    ...(region && /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region) ? { region } : {}),
  };
}

const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0') ? value.trim() : undefined;

function normalizeMapping(value: unknown): LogTableMapping | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const table = text(item.table, 256);
  const timestamp = text(item.timestamp, 128);
  if (!table || !timestamp) return undefined;
  const mapping: LogTableMapping = { table, timestamp };
  for (const field of ['level', 'message', 'service', 'traceId'] as const) {
    const column = text(item[field], 128);
    if (column) mapping[field] = column;
  }
  if (item.timestampFormat === 'iso' || item.timestampFormat === 'epoch_s' || item.timestampFormat === 'epoch_ms')
    mapping.timestampFormat = item.timestampFormat;
  return mapping;
}

/** Keep the well-formed entries of the setting, dropping malformed ones and repeated ids. */
export function normalizeConnections(value: unknown): ConnectionConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): ConnectionConfig[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const id = text(item.id, 128);
    if (!id || seen.has(id)) return [];
    const label = text(item.label, 128) ?? id;
    const logs = normalizeMapping(item.logs);
    let connection: ConnectionConfig | undefined;
    if (item.type === 'sqlite') {
      const path = text(item.path, 4096);
      if (path) connection = { id, label, type: 'sqlite', path };
    } else if (item.type === 'postgres' || item.type === 'mysql') {
      const database = text(item.database, 256);
      const user = text(item.user, 256);
      const fallback = item.type === 'mysql' ? 3306 : 5432;
      const port =
        Number.isSafeInteger(item.port) && item.port > 0 && item.port < 65536 ? (item.port as number) : fallback;
      const auth = normalizeAuth(item.auth);
      if (database && user)
        connection = {
          id,
          label,
          type: item.type,
          host: text(item.host, 256) ?? 'localhost',
          port,
          database,
          user,
          // IAM tokens are only accepted over TLS.
          ...(item.ssl === true || auth ? { ssl: true } : {}),
          ...(auth ? { auth } : {}),
        };
    } else if (item.type === 'mongodb') {
      const url = text(item.url, 2048);
      const database = text(item.database, 256) ?? (url ? mongoUrl(url)?.database : undefined);
      if (url && mongoUrl(url) && database) connection = { id, label, type: 'mongodb', url, database };
    } else if (item.type === 'datadog') {
      const site = text(item.site, 512);
      if (site && datadogApiBase(site)) {
        const indexes = Array.isArray(item.indexes)
          ? item.indexes.filter((index: unknown): index is string => typeof index === 'string' && !!index.trim())
          : [];
        connection = { id, label, type: 'datadog', site, ...(indexes.length ? { indexes } : {}) };
      }
    }
    if (!connection) return [];
    seen.add(id);
    // Datadog logs need no table mapping.
    if (logs && connection.type !== 'datadog') connection.logs = logs;
    return [connection];
  });
}

/**
 * Read `postgres://user:password@host:port/database?sslmode=require`, or
 * `mysql://user:password@host:port/database?ssl=true`, into a connection.
 */
export function parseServerUrl<T extends 'postgres' | 'mysql'>(
  value: string,
  type: T,
): { connection: Extract<ConnectionConfig, { type: T }>; password?: string } | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const protocols = type === 'mysql' ? ['mysql:', 'mariadb:'] : ['postgres:', 'postgresql:'];
  if (!protocols.includes(url.protocol)) return undefined;
  const database = decodePart(url.pathname.replace(/^\//, ''));
  const user = decodePart(url.username);
  if (!database || !user || !url.hostname) return undefined;
  const ssl =
    ['require', 'verify-ca', 'verify-full', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'].includes(
      url.searchParams.get(type === 'mysql' ? 'ssl-mode' : 'sslmode') ?? '',
    ) || ['true', '1'].includes(url.searchParams.get('ssl') ?? '');
  const [connection] = normalizeConnections([
    {
      id: 'draft',
      label: database,
      type,
      host: url.hostname,
      port: url.port ? Number(url.port) : type === 'mysql' ? 3306 : 5432,
      database,
      user,
      ssl,
    },
  ]);
  return connection?.type === type
    ? {
        connection: connection as Extract<ConnectionConfig, { type: T }>,
        ...(url.password ? { password: decodePart(url.password) } : {}),
      }
    : undefined;
}

/** Read `postgres://user:password@host:port/database?sslmode=require` into a connection. */
export function parsePostgresUrl(value: string): { connection: PostgresConnection; password?: string } | undefined {
  return parseServerUrl(value, 'postgres');
}

/**
 * Read a mongodb:// or mongodb+srv:// URL with its database into a connection.
 * A password in it is returned apart, so the saved URL never holds one.
 */
export function parseMongoUrl(value: string): { connection: MongoConnection; password?: string } | undefined {
  const match = /^(mongodb(?:\+srv)?:\/\/)(?:([^:@/?#]+)(?::([^@/?#]*))?@)?([^/?#@]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const [, scheme, user, password, hosts, pathPart, options] = match;
  const url = `${scheme}${user ? `${user}@` : ''}${hosts}${pathPart ?? ''}${options ?? ''}`;
  const database = mongoUrl(url)?.database;
  if (!database) return undefined;
  const [connection] = normalizeConnections([{ id: 'draft', label: database, type: 'mongodb', url, database }]);
  return connection?.type === 'mongodb'
    ? { connection, ...(password ? { password: decodePart(password) } : {}) }
    : undefined;
}

/** The URL of a Postgres or MySQL connection, without a password: the reverse of `parseServerUrl`. */
export function formatServerUrl(
  connection: Pick<PostgresConnection | MysqlConnection, 'type' | 'host' | 'port' | 'user' | 'database' | 'ssl'>,
): string {
  const port = connection.port === (connection.type === 'mysql' ? 3306 : 5432) ? '' : `:${connection.port}`;
  const tls = connection.ssl ? (connection.type === 'mysql' ? '?ssl-mode=REQUIRED' : '?sslmode=require') : '';
  return `${connection.type}://${encodeURIComponent(connection.user)}@${connection.host}${port}/${encodeURIComponent(connection.database)}${tls}`;
}

/** A column as a database describes it. */
export interface ColumnInfo {
  name: string;
  type: string;
}

const ROLE_NAMES: Record<MappedField, RegExp> = {
  timestamp:
    /^(?:timestamp|ts|time|datetime|date_?time|created_?at|logged_?at|inserted_?at|occurred_?at|event_?time)$/i,
  level: /^(?:level|severity|log_?level|lvl|priority)$/i,
  message: /^(?:message|msg|text|body|log|line|description)$/i,
  service: /^(?:service|service_?name|app|application|logger|source|component)$/i,
  traceId: /^(?:trace_?id|traceid|trace|correlation_?id|request_?id)$/i,
};

/** Guess which columns hold time, level, message, service, and trace id from their names. */
export function suggestMapping(columns: ColumnInfo[]): Partial<Record<MappedField, string>> {
  const suggestion: Partial<Record<MappedField, string>> = {};
  const used = new Set<string>();
  for (const role of MAPPED_FIELDS) {
    const match = columns.find((column) => !used.has(column.name) && ROLE_NAMES[role].test(column.name));
    // Any date or time column will do for the timestamp when none is named like one.
    const fallback =
      role === 'timestamp' && !match
        ? columns.find((column) => !used.has(column.name) && /date|time/i.test(column.type))
        : undefined;
    const column = match ?? fallback;
    if (column) {
      suggestion[role] = column.name;
      used.add(column.name);
    }
  }
  return suggestion;
}

const RANGES: Record<string, number> = { '15m': 15, '1h': 60, '4h': 240, '24h': 1440, '7d': 10080 };
/** The time ranges the Logs panel offers for a connection, newest data last. */
export const RANGE_CHOICES = Object.keys(RANGES);

/** Milliseconds in a range such as `1h`, or undefined for an unknown one. */
export function rangeMs(range: string): number | undefined {
  const minutes = Object.hasOwn(RANGES, range) ? RANGES[range] : undefined;
  return minutes === undefined ? undefined : minutes * 60000;
}
