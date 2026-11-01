// What each kind of connection is, in one place: the editor, the Logs panel,
// and the connection form ask this instead of testing for each type, so a new
// kind of store is one entry here and one connector.
import type { CloudWatchConnection, ConnectionConfig, ConnectionType, SqliteConnection } from './connections';

export interface ConnectionKind {
  /** The store's name, as the panel says it. */
  label: string;
  /** What the form says it is for. */
  description: string;
  /** A log service is searched as it is; a database once a log table or collection is mapped. */
  service: boolean;
  icon: 'cloud' | 'database';
  /** What one fetched record is called. */
  noun: 'log' | 'row' | 'document';
  /** The language of queries a person types and runs, for stores that take them. */
  language?: 'sql' | 'mongo';
  /** A search syntax of the store's own that Run and Tail can send as typed. */
  native?: {
    /** The toggle's label: `Datadog syntax`. */
    label: string;
    /** The toggle's tooltip. */
    title: string;
  };
  /** The store's own query for one trace's logs, when a trace id is not a search of the mapped trace field. */
  traceQuery?(traceId: string): string;
  /** For a log service, which fields its searches use, as the form explains them. */
  fields?: string;
  /** Whether the store can list the services that logged in a range. */
  services: boolean;
  /** The setting that caps one search, when it is not `connectionMaxRows`. */
  maxRowsSetting?: 'datadogMaxRows' | 'logServiceMaxRows';
  /** What is kept in secret storage: a password, or a service's keys. */
  secret: 'none' | 'password' | 'keys';
}

/** Every kind of connection, in the order the form offers them. */
export const CONNECTION_KINDS: Record<ConnectionType, ConnectionKind> = {
  datadog: {
    label: 'Datadog',
    description: 'Search the logs of a Datadog organization',
    service: true,
    icon: 'cloud',
    noun: 'log',
    native: { label: 'Datadog syntax', title: "Type the query in Datadog's own syntax, sent as you type it" },
    traceQuery: (traceId) => `trace_id:${traceId}`,
    fields: 'Searches use Datadog’s own fields: service, host, status, and @attributes.',
    services: true,
    maxRowsSetting: 'datadogMaxRows',
    secret: 'keys',
  },
  cloudwatch: {
    label: 'CloudWatch',
    description: 'Search the log groups of an AWS account',
    service: true,
    icon: 'cloud',
    noun: 'log',
    native: { label: 'Filter pattern', title: 'Type a CloudWatch filter pattern, sent as you type it' },
    traceQuery: (traceId) => {
      const id = JSON.stringify(traceId);
      return `{ $.traceId = ${id} || $.trace_id = ${id} || $.trace.id = ${id} }`;
    },
    fields:
      'Searches become CloudWatch filter patterns: a field such as level:error matches the fields of JSON logs, whole and with case, as CloudWatch does.',
    services: true,
    maxRowsSetting: 'logServiceMaxRows',
    secret: 'none',
  },
  loki: {
    label: 'Loki',
    description: 'Search the logs of Grafana Loki or Grafana Cloud',
    service: true,
    icon: 'cloud',
    noun: 'log',
    native: {
      label: 'LogQL',
      title: "Type a LogQL query, sent as you type it; one that starts with | reads the connection's streams",
    },
    // Pipeline stages alone run on the connection's selector.
    traceQuery: (traceId) => `|= ${JSON.stringify(traceId)}`,
    fields:
      'Searches become LogQL: words match a line without case, and fields are read from JSON lines and stream labels.',
    services: true,
    maxRowsSetting: 'logServiceMaxRows',
    secret: 'password',
  },
  postgres: {
    label: 'Postgres',
    description: 'Also Aurora PostgreSQL, RDS, Cloud SQL',
    service: false,
    icon: 'database',
    noun: 'row',
    language: 'sql',
    services: false,
    secret: 'password',
  },
  mysql: {
    label: 'MySQL',
    description: 'Also Aurora MySQL, MariaDB, RDS',
    service: false,
    icon: 'database',
    noun: 'row',
    language: 'sql',
    services: false,
    secret: 'password',
  },
  mongodb: {
    label: 'MongoDB',
    description: 'Also Atlas, DocumentDB',
    service: false,
    icon: 'database',
    noun: 'document',
    language: 'mongo',
    services: false,
    secret: 'password',
  },
  sqlite: {
    label: 'SQLite',
    description: 'A database file on this machine',
    service: false,
    icon: 'database',
    noun: 'row',
    language: 'sql',
    services: false,
    secret: 'none',
  },
};

export function connectionKind(type: ConnectionType): ConnectionKind {
  return CONNECTION_KINDS[type];
}

/** What the result line says the time went to: the service by name, or the database. */
export function storeName(type: ConnectionType): string {
  const kind = CONNECTION_KINDS[type];
  return kind.service || kind.language === 'mongo' ? kind.label : 'database';
}

/** A connection whose password or keys are kept in secret storage. */
export function keepsSecret(
  connection: ConnectionConfig,
): connection is Exclude<ConnectionConfig, SqliteConnection | CloudWatchConnection> {
  return CONNECTION_KINDS[connection.type].secret !== 'none';
}
