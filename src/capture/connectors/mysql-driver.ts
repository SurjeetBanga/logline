import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isRdsHost, type MysqlConnection } from '../../core/connections';
import { inlineMysqlParams, type SqlValue } from '../../core/remote-query';
import { rdsCertificates } from './aws-auth';
import { timedOut, type QueryOptions, type Row, type SqlDriver } from './types';

// The part of mysql2's callback Connection this driver uses.
interface Connection {
  query(
    options: { sql: string; values?: SqlValue[]; timeout?: number },
    callback: (error: (Error & { code?: string; errno?: number; fatal?: boolean }) | null, rows: unknown) => void,
  ): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(callback?: () => void): void;
  destroy(): void;
}
interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl?: { ca?: string[]; rejectUnauthorized: boolean };
  connectTimeout: number;
  // DATETIME and TIMESTAMP stay text, read as UTC like the session; mysql2 would read them in this machine's zone.
  dateStrings: boolean;
  supportBigNumbers: boolean;
  bigNumberStrings: boolean;
  multipleStatements: boolean;
  timezone: string;
  authPlugins?: Record<string, () => () => Buffer>;
}
type Mysql2Module = {
  createConnection(options: ConnectionOptions): Connection;
};

// The package bundles mysql2 into out/vendor/mysql2.js; tests and development builds can also load it from node_modules.
function loadMysql(): Mysql2Module {
  const bundled = path.join(__dirname, '..', '..', 'vendor', 'mysql2.js');
  return require(existsSync(bundled) ? bundled : 'mysql2') as Mysql2Module;
}

/** The server stopped the query at its time limit: MySQL's max_execution_time, or MariaDB's max_statement_time. */
const stoppedForTime = (error: { code?: string; errno?: number }) =>
  error.code === 'ER_QUERY_TIMEOUT' ||
  error.errno === 3024 ||
  error.errno === 1969 ||
  error.code === 'PROTOCOL_SEQUENCE_TIMEOUT';

/**
 * Runs each query in its own read-only transaction with a time limit, on one
 * connection opened at the first query and reopened after an error. Sessions
 * use UTC, so times without a zone compare as they are read.
 */
export class MysqlDriver implements SqlDriver {
  readonly dialect = 'mysql';
  private connection?: Promise<Connection>;
  private queue: Promise<unknown> = Promise.resolve();
  /** MariaDB names the time limit max_statement_time, in seconds; found on first use. */
  private timeLimit?: 'max_execution_time' | 'max_statement_time' | 'none';
  /** The limit the open session has, in milliseconds. */
  private limitMs?: number;

  constructor(
    private readonly settings: MysqlConnection,
    /** A saved password, or one made for each connection, such as an IAM token. */
    private readonly password: string | undefined | ((timeoutMs: number) => Promise<string | undefined>),
    private readonly load: () => Mysql2Module = loadMysql,
  ) {}

  query(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]> {
    // One connection runs one transaction at a time.
    const result = this.queue.then(() => this.run(sql, params, options));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private send(connection: Connection, sql: string, values: SqlValue[] = [], timeout?: number): Promise<unknown> {
    // Parameters are put in here: mysql2 would also replace a `?` inside a string or a quoted name.
    const text = inlineMysqlParams(sql, values);
    return new Promise((resolve, reject) =>
      connection.query({ sql: text, ...(timeout ? { timeout } : {}) }, (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
  }

  private async limit(connection: Connection, timeoutMs: number): Promise<void> {
    const ms = Math.max(1, Math.floor(timeoutMs));
    // The session keeps its limit, so it is set again only when the setting changes.
    if (this.timeLimit === 'none' || this.limitMs === ms) return;
    if (this.timeLimit !== 'max_statement_time') {
      try {
        await this.send(connection, `SET SESSION max_execution_time = ${ms}`);
        this.timeLimit = 'max_execution_time';
        this.limitMs = ms;
        return;
      } catch {
        // MariaDB has no max_execution_time; try its own name below.
      }
    }
    try {
      await this.send(connection, `SET SESSION max_statement_time = ${ms / 1000}`);
      this.timeLimit = 'max_statement_time';
      this.limitMs = ms;
    } catch {
      // Neither exists: the client's own timeout still stops the query.
      this.timeLimit = 'none';
    }
  }

  private async run(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]> {
    if (options.signal?.aborted) throw new Error('The query was cancelled.');
    const connection = await this.connect(options.timeoutMs);
    try {
      await this.limit(connection, options.timeoutMs);
      // The server stops a SELECT without its own LIMIT at this many rows.
      if (options.maxRows !== undefined)
        await this.send(connection, `SET SESSION sql_select_limit = ${Math.max(0, Math.floor(options.maxRows))}`);
      await this.send(connection, 'START TRANSACTION READ ONLY');
      try {
        // A little longer than the server's own limit, so the server says why it stopped.
        const rows = await this.send(connection, sql, params, options.timeoutMs + 1000);
        const list = (Array.isArray(rows) ? rows : []) as Row[];
        // A query with a larger LIMIT of its own still returns no more than asked.
        return options.maxRows !== undefined ? list.slice(0, options.maxRows) : list;
      } finally {
        await this.send(connection, 'ROLLBACK').catch(() => undefined);
        if (options.maxRows !== undefined)
          await this.send(connection, 'SET SESSION sql_select_limit = DEFAULT').catch(() => undefined);
      }
    } catch (error) {
      const failure = error as { code?: string; errno?: number; fatal?: boolean };
      if (stoppedForTime(failure)) {
        void this.close();
        throw timedOut(options.timeoutMs);
      }
      // A broken connection is replaced on the next query.
      if (failure.fatal !== false) void this.close();
      throw error;
    }
  }

  private connect(timeoutMs: number): Promise<Connection> {
    if (this.connection) return this.connection;
    // A late error from a connection already replaced must not close its replacement.
    const opening: Promise<Connection> = (async () => {
      const mysql = this.load();
      const password = typeof this.password === 'function' ? await this.password(timeoutMs) : this.password;
      const iam = this.settings.auth !== undefined;
      // RDS and Aurora present certificates from Amazon's own authorities, which Node does not trust by default.
      const rds = iam || isRdsHost(this.settings.host);
      const connection = mysql.createConnection({
        host: this.settings.host,
        port: this.settings.port,
        database: this.settings.database,
        user: this.settings.user,
        password,
        ...(this.settings.ssl || iam
          ? { ssl: rds ? { ca: rdsCertificates(), rejectUnauthorized: true } : { rejectUnauthorized: true } }
          : {}),
        connectTimeout: timeoutMs,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
        timezone: 'Z',
        // An IAM token is sent as a clear-text password, which is only ever done over TLS.
        ...(iam ? { authPlugins: { mysql_clear_password: () => () => Buffer.from(`${password ?? ''}\0`) } } : {}),
      });
      connection.on('error', () => {
        if (this.connection === opening) void this.close();
      });
      await this.send(connection, "SET time_zone = '+00:00'");
      return connection;
    })().catch((error: unknown) => {
      if (this.connection === opening) this.connection = undefined;
      throw error;
    });
    this.connection = opening;
    return opening;
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.timeLimit = undefined;
    this.limitMs = undefined;
    await connection?.then((open) => new Promise<void>((resolve) => open.end(() => resolve()))).catch(() => undefined);
  }
}
