import type { ColumnInfo, ConnectionConfig, LogTableMapping, TimeEncoding } from '../../core/connections';
import {
  buildSqlLogQuery,
  checkReadOnlySql,
  limitedSql,
  rowRoles,
  rowToLine,
  type RowRoles,
  type TableInfo,
} from '../../core/remote-query';
import type { Connector, FetchRequest, FetchResult, Row, SqlDriver } from './types';

const NUMERIC_TYPE = /int|real|double|float|numeric|decimal|serial|number/i;

/** Split `schema.table`; a bare name is in the default schema. */
function tableParts(table: string): { schema?: string; name: string } {
  const parts = table.split('.');
  return parts.length === 2 && parts.every(Boolean) ? { schema: parts[0], name: parts[1] } : { name: table };
}

/** Searches a log table in SQLite or Postgres, and runs read-only queries typed by a person. */
export class SqlConnector implements Connector {
  private table?: Promise<TableInfo>;

  constructor(
    readonly connection: ConnectionConfig,
    private readonly driver: SqlDriver,
    private readonly timeoutMs: () => number,
  ) {}

  get mapping(): LogTableMapping | undefined {
    return this.connection.logs;
  }

  private query(sql: string, params: (string | number | null)[] = [], signal?: AbortSignal): Promise<Row[]> {
    return this.driver.query(sql, params, { timeoutMs: this.timeoutMs(), signal });
  }

  /** The database's version and how many tables it has, to confirm the connection works. */
  async test(): Promise<string> {
    const [version] = await this.query(
      this.driver.dialect === 'sqlite' ? 'SELECT sqlite_version() AS v' : 'SHOW server_version',
    );
    const tables = await this.tables();
    const number = String(version?.v ?? version?.server_version ?? '').split(' ')[0];
    const name = this.driver.dialect === 'sqlite' ? 'SQLite' : 'Postgres';
    return `${name} ${number} · ${tables.length} table${tables.length === 1 ? '' : 's'}`;
  }

  async tables(): Promise<string[]> {
    if (this.driver.dialect === 'sqlite') {
      const rows = await this.query(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      return rows.map((row) => String(row.name));
    }
    const rows = await this.query(
      "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema = 'public' DESC, table_schema, table_name",
    );
    return rows.map((row) => (row.s === 'public' ? String(row.t) : `${String(row.s)}.${String(row.t)}`));
  }

  async columns(table: string): Promise<ColumnInfo[]> {
    if (this.driver.dialect === 'sqlite') {
      const rows = await this.query('SELECT name, type FROM pragma_table_info(?)', [table]);
      return rows.map((row) => ({ name: String(row.name), type: String(row.type ?? '') }));
    }
    const { schema, name } = tableParts(table);
    const rows = await this.query(
      'SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [schema ?? 'public', name],
    );
    return rows.map((row) => ({ name: String(row.name), type: String(row.type ?? '') }));
  }

  /** How the mapped table stores time, read once per connection. */
  private describe(): Promise<TableInfo> {
    const mapping = this.mapping;
    if (!mapping) return Promise.reject(new Error('Map a log table for this connection first, or use Run SQL.'));
    this.table ??= this.readTable(mapping).catch((error: unknown) => {
      this.table = undefined;
      throw error;
    });
    return this.table;
  }

  private async readTable(mapping: LogTableMapping): Promise<TableInfo> {
    const columns = await this.columns(mapping.table);
    if (!columns.length) throw new Error(`Table ${mapping.table} was not found.`);
    const column = columns.find((candidate) => candidate.name === mapping.timestamp);
    if (!column) throw new Error(`Column ${mapping.timestamp} is not in ${mapping.table}.`);
    return { columns, time: mapping.timestampFormat ?? (await this.timeEncoding(mapping, column)) };
  }

  private async timeEncoding(mapping: LogTableMapping, column: ColumnInfo): Promise<TimeEncoding> {
    if (this.driver.dialect === 'postgres' && /timestamp|^date$/i.test(column.type)) return 'native';
    if (this.driver.dialect === 'postgres' && !NUMERIC_TYPE.test(column.type)) return 'iso';
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const table = tableParts(mapping.table);
    const from = table.schema ? `${quote(table.schema)}.${quote(table.name)}` : quote(table.name);
    const [sample] = await this.query(
      `SELECT ${quote(column.name)} AS v FROM ${from} WHERE ${quote(column.name)} IS NOT NULL LIMIT 1`,
    );
    const value = sample?.v;
    const number = typeof value === 'number' || typeof value === 'bigint' ? Number(value) : Number(String(value));
    if (value === undefined || !Number.isFinite(number) || (typeof value === 'string' && !/^-?\d/.test(value)))
      return 'iso';
    return Math.abs(number) < 1e11 ? 'epoch_s' : 'epoch_ms';
  }

  private roles(table: TableInfo): RowRoles {
    const mapping = this.mapping!;
    return rowRoles(
      table.columns.map((column) => column.name),
      mapping,
    );
  }

  /** The SQL a search would run and the terms Logline would apply itself, without running it. */
  async preview(query: string, fromMs?: number, toMs?: number): Promise<{ statement: string; local: string[] }> {
    const table = await this.describe();
    const built = buildSqlLogQuery({
      dialect: this.driver.dialect,
      mapping: this.mapping!,
      table,
      query,
      fromMs,
      toMs,
      limit: 0,
      order: 'desc',
    });
    return { statement: built.select.sql, local: built.local };
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    const table = await this.describe();
    const built = buildSqlLogQuery({
      dialect: this.driver.dialect,
      mapping: this.mapping!,
      table,
      query: request.query,
      fromMs: request.fromMs,
      toMs: request.toMs,
      limit: request.limit,
      order: request.order,
    });
    const rows = await this.query(built.select.sql, built.select.params, signal);
    let total: number | undefined;
    if (request.countTotal && rows.length >= request.limit) {
      const [count] = await this.query(built.count.sql, built.count.params, signal);
      const value = Number(count?.n);
      if (Number.isFinite(value)) total = value;
    }
    const roles = this.roles(table);
    const encoding = this.mapping!.timestampFormat ?? table.time;
    return {
      records: rows.map((row) => rowToLine(row, roles, encoding)),
      ...(total !== undefined ? { total } : {}),
      pushed: built.pushed,
      local: built.local,
      statement: built.select.sql,
      elapsedMs: Date.now() - started,
    };
  }

  async runSql(sql: string, limit: number, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    const checked = checkReadOnlySql(sql);
    if ('error' in checked) throw new Error(checked.error);
    const statement = limitedSql(checked.sql, this.driver.dialect, limit);
    const rows = await this.query(statement.sql, statement.params, signal);
    const roles = rowRoles(Object.keys(rows[0] ?? {}), this.mapping);
    return {
      records: rows.map((row) => rowToLine(row, roles, 'auto')),
      pushed: [],
      local: [],
      statement: checked.sql,
      elapsedMs: Date.now() - started,
    };
  }

  dispose(): Promise<void> {
    return this.driver.close();
  }
}
