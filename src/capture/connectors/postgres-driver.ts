import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { PostgresConnection } from '../../core/connections';
import type { SqlValue } from '../../core/remote-query';
import { timedOut, type QueryOptions, type Row, type SqlDriver } from './types';

// The part of pg's Client this driver uses.
interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: SqlValue[]): Promise<{ rows: unknown[] }>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}
interface ClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl?: boolean;
  connectionTimeoutMillis: number;
  application_name: string;
  types: TypeParsers;
}
interface TypeParsers {
  getTypeParser(oid: number, format?: string): unknown;
}
type PgModule = { Client: new (config: ClientConfig) => Client; types?: TypeParsers };

// `timestamp` and `date` values have no zone; pg would read them in this
// machine's zone. They stay text, which Logline reads as UTC, as the session does.
const ZONELESS = new Set([1082, 1114]);

function parsers(pg: PgModule): TypeParsers {
  return {
    getTypeParser: (oid, format) =>
      ZONELESS.has(oid) && format !== 'binary' ? String : (pg.types?.getTypeParser(oid, format) ?? String),
  };
}

// The package bundles pg into out/vendor/pg.js; tests and development builds
// can also load it from node_modules.
function loadPg(): PgModule {
  const bundled = path.join(__dirname, '..', '..', 'vendor', 'pg.js');
  return require(existsSync(bundled) ? bundled : 'pg') as PgModule;
}

/**
 * Runs each query in its own read-only transaction with a statement timeout,
 * on one connection opened at the first query and reopened after an error.
 */
export class PostgresDriver implements SqlDriver {
  readonly dialect = 'postgres';
  private client?: Promise<Client>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly connection: PostgresConnection,
    private readonly password: string | undefined,
    private readonly load: () => PgModule = loadPg,
  ) {}

  query(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]> {
    // One connection runs one transaction at a time.
    const result = this.queue.then(() => this.run(sql, params, options));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]> {
    if (options.signal?.aborted) throw new Error('The query was cancelled.');
    const client = await this.connect(options.timeoutMs);
    try {
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`);
        // Times without a zone compare as UTC, as they are read.
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        const result = await client.query(sql, params);
        return result.rows as Row[];
      } finally {
        await client.query('ROLLBACK');
      }
    } catch (error) {
      if (/statement timeout/i.test(error instanceof Error ? error.message : '')) throw timedOut(options.timeoutMs);
      // A broken connection is replaced on the next query.
      if (!(error && typeof error === 'object' && 'severity' in error)) void this.close();
      throw error;
    }
  }

  private connect(timeoutMs: number): Promise<Client> {
    this.client ??= (async () => {
      const pg = this.load();
      const client = new pg.Client({
        host: this.connection.host,
        port: this.connection.port,
        database: this.connection.database,
        user: this.connection.user,
        password: this.password,
        ssl: this.connection.ssl ? true : undefined,
        connectionTimeoutMillis: timeoutMs,
        application_name: 'Logline',
        types: parsers(pg),
      });
      client.on('error', () => {
        void this.close();
      });
      await client.connect();
      return client;
    })().catch((error: unknown) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.then((open) => open.end()).catch(() => undefined);
  }
}
