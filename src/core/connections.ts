// Saved connections to log stores outside the editor: the `logline.connections`
// setting. Secrets (passwords) never appear here; the VS Code adapter keeps
// them in secret storage under `secretKey`.
import { CONNECTION_KINDS } from './connection-types';

export type ConnectionType =
  'sqlite' | 'postgres' | 'mysql' | 'mongodb' | 'datadog' | 'cloudwatch' | 'loki' | 'elasticsearch' | 'gcp';
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
/** Log groups of an AWS account in one region, read with the credentials of an AWS profile. */
export interface CloudWatchConnection extends BaseConnection {
  type: 'cloudwatch';
  region: string;
  /** The AWS profile whose credentials sign requests; the default chain when left out. */
  profile?: string;
  /** Log group names or ARNs: 1 to 10, since a search reads each one. */
  logGroups: string[];
  /** A CloudWatch Logs API in place of the region's, such as LocalStack on this machine. */
  endpoint?: string;
}
/** A Grafana Loki API, self-hosted or Grafana Cloud's. */
export interface LokiConnection extends BaseConnection {
  type: 'loki';
  /** The API's URL, such as `https://logs-prod-012.grafana.net` or `http://localhost:3100`. */
  url: string;
  /** The tenant of a multi-tenant Loki, sent as X-Scope-OrgID. */
  tenant?: string;
  /** With a password or token, signs in with basic auth; a token alone is a bearer token. */
  user?: string;
  /** The streams a search reads when it names no service. */
  selector?: string;
}
/**
 * An Elasticsearch or OpenSearch cluster. Its log index pattern is the mapping's `table`, and its fields the
 * mapping's columns.
 */
export interface ElasticConnection extends BaseConnection {
  type: 'elasticsearch';
  /** The cluster's URL, such as `https://search-logs.us-east-1.es.amazonaws.com` or `http://localhost:9200`. */
  url: string;
  /** With a password, signs in with basic auth; a secret without a user is an API key. */
  user?: string;
  /** Amazon OpenSearch Service, signed with AWS credentials instead of a password. */
  auth?: IamAuth;
}
/** The logs of a Google Cloud project, read with Application Default Credentials. */
export interface GcpConnection extends BaseConnection {
  type: 'gcp';
  project: string;
  /** A Logging query every search is narrowed by, such as `resource.type="cloud_run_revision"`. */
  filter?: string;
  /** The field of a log entry that names its service; `resource.labels.service_name` when left out. */
  serviceField?: string;
  /** A Cloud Logging API in place of Google's, on this machine, for tests. */
  endpoint?: string;
}
export type ConnectionConfig =
  | GcpConnection
  | ElasticConnection
  | SqliteConnection
  | PostgresConnection
  | MysqlConnection
  | MongoConnection
  | DatadogConnection
  | CloudWatchConnection
  | LokiConnection;

/** The most log groups one connection searches. */
export const MAX_LOG_GROUPS = 10;

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
  return apiUrl(site);
}

/**
 * The URL of an API typed in place of a service's own, such as a proxy: https,
 * or plain http only on this machine, since requests carry credentials.
 */
export function apiUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const AWS_REGION = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d+$/;

/** Whether text is an AWS region's name, such as `us-east-1`. */
export function isAwsRegion(value: string): boolean {
  return AWS_REGION.test(value);
}

/** The streams a Loki search reads when it names no service: every stream with a service name. */
export const LOKI_SELECTOR = '{service_name=~".+"}';

const SELECTOR_MATCHER = String.raw`\s*[A-Za-z_]\w*\s*(?:=~|!~|!=|=)\s*"(?:\\.|[^"\\])*"\s*`;
const SELECTOR = new RegExp(`^\\{${SELECTOR_MATCHER}(?:,${SELECTOR_MATCHER})*\\}$`);

/** Whether text is a LogQL stream selector, such as `{job="api"}`. */
export function isLokiSelector(value: string): boolean {
  return SELECTOR.test(value.trim());
}

/** The AWS region and service of an Amazon OpenSearch endpoint, such as `search-logs-abc.us-east-1.es.amazonaws.com`. */
export function openSearchService(url: string): { region?: string; service: 'es' | 'aoss' } {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const match = /\.([a-z]{2}(?:-gov)?-[a-z]+-\d+)\.(es|aoss)\.amazonaws\.com(?:\.cn)?$/i.exec(host);
  return match
    ? { region: match[1].toLowerCase(), service: match[2].toLowerCase() as 'es' | 'aoss' }
    : { service: 'es' };
}

/** Whether text is a Google Cloud project id, such as `shop-prod-1234`, or a domain-scoped one. */
export function isGcpProject(value: string): boolean {
  return /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

/** The CloudWatch Logs API a connection reads: its endpoint, or its region's. */
export function cloudwatchEndpoint(connection: Pick<CloudWatchConnection, 'region' | 'endpoint'>): string {
  if (connection.endpoint) return connection.endpoint;
  return `https://logs.${connection.region}.amazonaws.com${connection.region.startsWith('cn-') ? '.cn' : ''}`;
}

/** A log group's name or ARN as CloudWatch takes it, or undefined when it is neither. */
export function logGroupIdentifier(value: string): string | undefined {
  const text = value.trim();
  // An ARN copied from the console ends in `:*`, which the API refuses.
  const arn = /^arn:aws(?:-[a-z-]+)?:logs:[a-z0-9-]+:\d{12}:log-group:([\w.\-/#]{1,512})(?::\*)?$/.exec(text);
  if (arn) return text.replace(/:\*$/, '');
  return /^[\w.\-/#]{1,512}$/.test(text) ? text : undefined;
}

/** The roles a mapping can assign, in the order the setup asks for them. */
export const MAPPED_FIELDS = ['timestamp', 'level', 'message', 'service', 'traceId'] as const;
export type MappedField = (typeof MAPPED_FIELDS)[number];

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
  return `${CONNECTION_KINDS[connection.type].label} · ${connection.label}`;
}

/**
 * Where a connection's password or keys are kept: by the database or API they
 * open, so the same one is shared across workspaces, and a workspace that
 * points a connection elsewhere never receives them.
 */
export function secretKey(
  connection: Exclude<ConnectionConfig, SqliteConnection | CloudWatchConnection | GcpConnection>,
): string {
  if (connection.type === 'elasticsearch')
    return `logline.connection.elasticsearch:${apiUrl(connection.url) ?? connection.url}/${encodeURIComponent(connection.user ?? '')}`;
  if (connection.type === 'loki')
    return `logline.connection.loki:${apiUrl(connection.url) ?? connection.url}/${encodeURIComponent(connection.tenant ?? '')}/${encodeURIComponent(connection.user ?? '')}`;
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
  // An unescaped @ past the host means a password with a / or ? in it was read as the host and path.
  // Azure Cosmos DB's own URLs end in appName=@account@, which is not one.
  if (database?.includes('@') || options?.replace(/(^|&)appName=[^&]*/gi, '').includes('@')) return undefined;
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
    ...(region && AWS_REGION.test(region) ? { region } : {}),
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
    } else if (item.type === 'gcp') {
      const project = text(item.project, 64);
      const filter = text(item.filter, 4096);
      const serviceField = text(item.serviceField, 256);
      // Only a Cloud Logging API on this machine stands in for Google's: requests carry a token for the project.
      const endpoint = typeof item.endpoint === 'string' ? apiUrl(item.endpoint.trim()) : undefined;
      if (project && isGcpProject(project))
        connection = {
          id,
          label,
          type: 'gcp',
          project,
          ...(filter ? { filter } : {}),
          ...(serviceField && /^[A-Za-z_][\w.]*$/.test(serviceField) ? { serviceField } : {}),
          ...(endpoint && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/]/.test(`${endpoint}/`) ? { endpoint } : {}),
        };
    } else if (item.type === 'elasticsearch') {
      const url = typeof item.url === 'string' ? apiUrl(item.url.trim()) : undefined;
      const user = text(item.user, 256);
      const auth = normalizeAuth(item.auth);
      // AWS signs requests only over TLS.
      if (url && (!auth || url.startsWith('https:')))
        connection = {
          id,
          label,
          type: 'elasticsearch',
          url,
          ...(user && !auth ? { user } : {}),
          ...(auth ? { auth } : {}),
        };
    } else if (item.type === 'loki') {
      const url = typeof item.url === 'string' ? apiUrl(item.url.trim()) : undefined;
      const tenant = text(item.tenant, 256);
      const user = text(item.user, 256);
      const selector = text(item.selector, 1024);
      if (url)
        connection = {
          id,
          label,
          type: 'loki',
          url,
          ...(tenant ? { tenant } : {}),
          ...(user ? { user } : {}),
          ...(selector && isLokiSelector(selector) ? { selector } : {}),
        };
    } else if (item.type === 'cloudwatch') {
      const region = text(item.region, 32);
      const profile = text(item.profile, 128);
      const endpoint = typeof item.endpoint === 'string' ? apiUrl(item.endpoint.trim()) : undefined;
      const groups: unknown[] = Array.isArray(item.logGroups) ? item.logGroups : [];
      const logGroups = [
        ...new Set(
          groups.flatMap((group) => {
            const identifier = typeof group === 'string' ? logGroupIdentifier(group) : undefined;
            return identifier ? [identifier] : [];
          }),
        ),
      ].slice(0, MAX_LOG_GROUPS);
      if (region && AWS_REGION.test(region) && logGroups.length)
        connection = {
          id,
          label,
          type: 'cloudwatch',
          region,
          ...(profile ? { profile } : {}),
          logGroups,
          ...(endpoint ? { endpoint } : {}),
        };
    }
    if (!connection) return [];
    seen.add(id);
    // A log service's logs need no table mapping.
    if (logs && !CONNECTION_KINDS[connection.type].service) connection.logs = logs;
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
    /^(?:@timestamp|timestamp|ts|time|datetime|date_?time|created_?at|logged_?at|inserted_?at|occurred_?at|event_?time)$/i,
  level: /^(?:level|severity|log_?level|log\.level|lvl|priority)$/i,
  message: /^(?:message|msg|text|body|log|line|description)$/i,
  service: /^(?:service|service_?name|service\.name|app|application|logger|source|component)$/i,
  traceId: /^(?:trace_?id|traceid|trace\.id|trace|correlation_?id|request_?id)$/i,
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
