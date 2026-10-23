// Saved connections to log stores outside the editor: the `logline.connections`
// setting. Secrets (passwords) never appear here; the VS Code adapter keeps
// them in secret storage under `secretKey`.

export type ConnectionType = 'sqlite' | 'postgres';
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
export interface PostgresConnection extends BaseConnection {
  type: 'postgres';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: boolean;
}
export type ConnectionConfig = SqliteConnection | PostgresConnection;

/** The roles a mapping can assign, in the order the setup asks for them. */
export const MAPPED_FIELDS = ['timestamp', 'level', 'message', 'service', 'traceId'] as const;
export type MappedField = (typeof MAPPED_FIELDS)[number];

const TYPE_NAMES: Record<ConnectionType, string> = { sqlite: 'SQLite', postgres: 'Postgres' };
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

/** Where a connection's password is kept: the same database shares it across workspaces. */
export function secretKey(connection: PostgresConnection): string {
  return `logline.connection.postgres://${encodeURIComponent(connection.user)}@${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`;
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
    } else if (item.type === 'postgres') {
      const database = text(item.database, 256);
      const user = text(item.user, 256);
      const port = Number.isSafeInteger(item.port) && item.port > 0 && item.port < 65536 ? (item.port as number) : 5432;
      if (database && user)
        connection = {
          id,
          label,
          type: 'postgres',
          host: text(item.host, 256) ?? 'localhost',
          port,
          database,
          user,
          ...(item.ssl === true ? { ssl: true } : {}),
        };
    }
    if (!connection) return [];
    seen.add(id);
    if (logs) connection.logs = logs;
    return [connection];
  });
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
