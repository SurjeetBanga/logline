import type { SqlDialect, SqlValue } from '../../core/remote-query';

export type Row = Record<string, unknown>;

export interface QueryOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs read-only SQL against one database. */
export interface SqlDriver {
  readonly dialect: SqlDialect;
  query(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]>;
  close(): Promise<void>;
}

/** A fetched row as a JSON log line, with its time when the row had one. */
export interface RemoteRecord {
  line: string;
  timeMs?: number;
}

export interface FetchRequest {
  query: string;
  fromMs?: number;
  toMs?: number;
  limit: number;
  order: 'asc' | 'desc';
  /** Also count every matching row when the limit cuts the result short. */
  countTotal?: boolean;
}

export interface FetchResult {
  /** In the order the database returned them. */
  records: RemoteRecord[];
  /** Matching rows in the range, when counted. */
  total?: number;
  /** Search terms the database applied, and the ones left for Logline. */
  pushed: string[];
  local: string[];
  /** The statement that ran, for display. */
  statement: string;
  elapsedMs: number;
}

/** A store of logs outside the editor that can be searched over a time range. */
export interface RemoteConnector {
  fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult>;
  /** Run a query typed by a person; only stores that speak SQL have it. */
  runSql?(sql: string, limit: number, signal?: AbortSignal): Promise<FetchResult>;
}

/** The error for a query stopped at its time limit. */
export function timedOut(timeoutMs: number): Error {
  const limit = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
  return new Error(`The query took longer than ${limit} and was stopped.`);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
