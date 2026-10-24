// Turns a Logline search into SQL for a mapped log table. The SQL may match
// more rows than the search (it is the part a database can answer), never
// fewer: the fetched rows are then filtered again with the full search, so
// terms SQL cannot express, such as regular expressions, still apply.
import type { ColumnInfo, LogTableMapping, MappedField, TimeEncoding } from './connections';
import { parseQuery, type ParsedQuery, type Token } from './query';
import { queryTokens } from './query-tokens';

export type SqlDialect = 'sqlite' | 'postgres' | 'mysql';
export type SqlValue = string | number | null;
export interface SqlStatement {
  sql: string;
  params: SqlValue[];
}

/** What a database reported about a mapped log table. */
export interface TableInfo {
  columns: ColumnInfo[];
  /** How the timestamp column stores time. */
  time: TimeEncoding;
}

export interface SqlLogRequest {
  dialect: SqlDialect;
  mapping: LogTableMapping;
  table: TableInfo;
  query: string;
  fromMs?: number;
  toMs?: number;
  limit: number;
  /** `desc` fetches the newest rows first; tails read forward. */
  order: 'asc' | 'desc';
  now?: number;
}

export interface SqlLogQuery {
  select: SqlStatement;
  /** Counts every row the select would return without its limit. */
  count: SqlStatement;
  /** Search terms the database applies. */
  pushed: string[];
  /** Search terms only Logline can apply, to the fetched rows. */
  local: string[];
}

/** Quote a column or table name: in backticks for MySQL, in double quotes for the rest. */
export function quoteIdentifier(name: string, dialect: SqlDialect = 'postgres'): string {
  return dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
}

/** Quote `table` or `schema.table`. */
export function quoteTable(table: string, dialect: SqlDialect = 'postgres'): string {
  const parts = table.split('.');
  return parts.length === 2 && parts.every(Boolean)
    ? parts.map((part) => quoteIdentifier(part, dialect)).join('.')
    : quoteIdentifier(table, dialect);
}

// MySQL reads a backslash in a string literal as an escape unless NO_BACKSLASH_ESCAPES is on, so
// LIKE there escapes with a character that means the same in both modes.
const likeEscape = (dialect: SqlDialect) => (dialect === 'mysql' ? '!' : '\\');

function escapeLike(value: string, dialect: SqlDialect): string {
  const escape = likeEscape(dialect);
  return value.replace(dialect === 'mysql' ? /[!%_]/g : /[\\%_]/g, (character) => `${escape}${character}`);
}

/** A UTC time as MySQL reads a DATETIME literal; the driver's sessions use UTC. */
function mysqlTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

const NUMERIC_TYPE = /int|real|double|float|numeric|decimal|serial|number/i;

class Params {
  readonly values: SqlValue[] = [];
  constructor(private readonly dialect: SqlDialect) {}
  add(value: SqlValue): string {
    this.values.push(value);
    return this.dialect === 'postgres' ? `$${this.values.length}` : '?';
  }
}

/** A SQL expression for a time column and a matching placeholder for an epoch-milliseconds value. */
function timeExpression(
  dialect: SqlDialect,
  name: string,
  encoding: TimeEncoding,
  params: Params,
): { column: string; at(ms: number): string } {
  const column = quoteIdentifier(name, dialect);
  if (encoding === 'epoch_s') return { column, at: (ms) => params.add(ms / 1000) };
  if (encoding === 'epoch_ms') return { column, at: (ms) => params.add(ms) };
  const iso = (ms: number) => new Date(ms).toISOString();
  if (dialect === 'mysql')
    // ISO text keeps its T and Z, which a MySQL DATETIME does not read; times without a zone are UTC there.
    return {
      column: encoding === 'native' ? column : `CAST(REPLACE(REPLACE(${column}, 'T', ' '), 'Z', '') AS DATETIME(6))`,
      at: (ms) => params.add(mysqlTime(ms)),
    };
  if (dialect === 'sqlite')
    // julianday reads ISO 8601 text with or without the T, fractions, or a zone.
    return { column: `julianday(${column})`, at: (ms) => `julianday(${params.add(iso(ms))})` };
  // Times without a zone are read as UTC: the driver's sessions use UTC.
  return {
    column: encoding === 'native' ? column : `CAST(${column} AS timestamptz)`,
    at: (ms) => `CAST(${params.add(iso(ms))} AS timestamptz)`,
  };
}

function timeTerms(request: SqlLogRequest, params: Params): { column: string; at(ms: number): string } {
  const encoding = request.mapping.timestampFormat ?? request.table.time;
  return timeExpression(request.dialect, request.mapping.timestamp, encoding, params);
}

function columnNamed(columns: ColumnInfo[], name: string): ColumnInfo | undefined {
  const lower = name.toLowerCase();
  return (
    columns.find((column) => column.name === name) ?? columns.find((column) => column.name.toLowerCase() === lower)
  );
}

/** The column a field term reads: a mapped role (level, message…) or a column of that name. */
function columnFor(token: Token, request: SqlLogRequest): ColumnInfo | undefined {
  const role = token.canonical as MappedField | undefined;
  const mapped =
    role && role !== 'timestamp' && Object.hasOwn(request.mapping, role) ? request.mapping[role] : undefined;
  return columnNamed(request.table.columns, mapped ?? token.field ?? '');
}

function textOf(column: ColumnInfo, dialect: SqlDialect): string {
  return `LOWER(CAST(${quoteIdentifier(column.name, dialect)} AS ${dialect === 'mysql' ? 'CHAR' : 'TEXT'}))`;
}

function like(column: ColumnInfo, value: string, params: Params, dialect: SqlDialect, prefix = false): string {
  return `${textOf(column, dialect)} LIKE ${params.add(`${prefix ? '' : '%'}${escapeLike(value, dialect)}%`)} ESCAPE '${likeEscape(dialect)}'`;
}

/** SQL that holds for every row the term matches, or undefined when SQL cannot say. */
function predicate(token: Token, request: SqlLogRequest, params: Params, now: number): string | undefined {
  if (token.changed !== undefined || token.regex !== undefined) return undefined;
  if (token.canonical === 'last') {
    if (token.negate || token.relativeMs === undefined) return undefined;
    const time = timeTerms(request, params);
    return `${time.column} >= ${time.at(now - token.relativeMs)}`;
  }
  if (token.canonical === 'timestamp' || token.canonical === 'time') {
    const range = token.timestampRange;
    if (token.negate || !range || !range.every(Number.isFinite)) return undefined;
    const time = timeTerms(request, params);
    return `${time.column} BETWEEN ${time.at(range[0])} AND ${time.at(range[1])}`;
  }
  if (token.canonical === 'exists') {
    const column = columnNamed(request.table.columns, token.value);
    if (!column) return undefined;
    return `${quoteIdentifier(column.name, request.dialect)} IS ${token.negate ? '' : 'NOT '}NULL`;
  }
  if (token.field === undefined) {
    // Free text can match any column; its negation would have to hold for all of them.
    if (token.negate || !token.value) return undefined;
    const terms = request.table.columns.map((column) => like(column, token.value, params, request.dialect));
    return terms.length ? `(${terms.join(' OR ')})` : undefined;
  }
  const column = columnFor(token, request);
  if (!column) return undefined;
  const numeric = NUMERIC_TYPE.test(column.type);
  const name = quoteIdentifier(column.name, request.dialect);
  const dialect = request.dialect;
  let condition: string | undefined;
  if (token.numericComparison) {
    if (numeric)
      condition = `${name} ${token.numericComparison.operator} ${params.add(token.numericComparison.target)}`;
  } else if (token.numericRange) {
    if (numeric)
      condition = `${name} BETWEEN ${params.add(token.numericRange[0])} AND ${params.add(token.numericRange[1])}`;
  } else if (token.compare) {
    condition = undefined;
  } else if (token.canonical === 'level') {
    // Logline reads numeric levels (pino's 50) and CRITICAL as names, which SQL cannot match.
    if (!numeric)
      condition =
        token.value === 'fatal'
          ? `(${like(column, 'fatal', params, dialect)} OR ${like(column, 'critical', params, dialect)})`
          : like(column, token.value, params, dialect);
  } else if (token.canonical === 'status' && /^\dxx$/.test(token.value)) {
    condition = like(column, token.value[0], params, dialect, true);
  } else condition = like(column, token.value, params, dialect);
  if (!condition) return undefined;
  return token.negate ? `(${name} IS NULL OR NOT ${condition})` : condition;
}

// A regular expression term, with or without a field: SQL never applies it, so
// it is not parsed here, which would compile it for nothing.
const REGEX_TERM = /^-?(?:@?[A-Za-z_][A-Za-z0-9_.]*:(?!\/\/))?\/.+\/[dgimsuvy]*$/;

/** The query's terms as typed, grouped like parseQuery groups them; regular expressions have no token. */
function termGroups(input: string): { text: string; token?: Token }[][] {
  const groups: { text: string; token?: Token }[][] = [[]];
  for (const text of queryTokens(input)) {
    if (text === 'OR' || text === 'or') groups.push([]);
    else if (REGEX_TERM.test(text)) groups.at(-1)!.push({ text });
    else {
      const token = parseQuery(text)[0]?.[0];
      if (token) groups.at(-1)!.push({ text, token });
    }
  }
  return groups.filter((group) => group.length);
}

/** Build the select for the newest (or, for tails, the next) rows of a mapped table that can match a search. */
export function buildSqlLogQuery(request: SqlLogRequest): SqlLogQuery {
  const params = new Params(request.dialect);
  const now = request.now ?? Date.now();
  const conditions: string[] = [];
  const time = timeTerms(request, params);
  if (request.fromMs !== undefined && request.toMs !== undefined)
    conditions.push(`${time.column} BETWEEN ${time.at(request.fromMs)} AND ${time.at(request.toMs)}`);
  else if (request.fromMs !== undefined) conditions.push(`${time.column} >= ${time.at(request.fromMs)}`);
  const pushed = new Set<string>();
  const local = new Set<string>();
  const groups = termGroups(request.query.slice(0, 1024));
  const alternatives: string[] = [];
  let unrestricted = false;
  for (const group of groups) {
    const terms: string[] = [];
    for (const { text, token } of group) {
      const condition = token && predicate(token, request, params, now);
      if (condition) {
        terms.push(condition);
        pushed.add(text);
      } else local.add(text);
    }
    // A branch SQL cannot narrow makes the whole OR unnarrowable.
    if (!terms.length) unrestricted = true;
    alternatives.push(terms.join(' AND '));
  }
  if (unrestricted) {
    // Parameters already added for other branches are unused now; rebuild without them.
    const rebuilt = buildSqlLogQuery({ ...request, query: '' });
    return { ...rebuilt, pushed: [], local: groups.flat().map((term) => term.text) };
  }
  if (alternatives.length === 1) conditions.push(alternatives[0]);
  else if (alternatives.length) conditions.push(`(${alternatives.map((terms) => `(${terms})`).join(' OR ')})`);
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM ${quoteTable(request.mapping.table, request.dialect)}${where}`;
  const countParams = [...params.values];
  const order = `${quoteIdentifier(request.mapping.timestamp, request.dialect)} ${request.order === 'desc' ? 'DESC' : 'ASC'}`;
  const select = `SELECT * ${from} ORDER BY ${order} LIMIT ${params.add(request.limit)}`;
  return {
    select: { sql: select, params: params.values },
    count: { sql: `SELECT COUNT(*) AS n ${from}`, params: countParams },
    pushed: [...pushed],
    local: [...local],
  };
}

/**
 * The search to apply to fetched rows: the whole query except `changed:`
 * terms, which depend on the working tree and are left to the Logs panel's
 * own filter. Undefined when nothing is left to check.
 */
export function rowFilter(query: string): ParsedQuery | undefined {
  const groups = parseQuery(query.slice(0, 1024));
  if (!groups.length) return undefined;
  const kept = groups.map((group) => group.filter((token) => token.changed === undefined));
  return kept.some((group) => !group.length) ? undefined : kept;
}

/**
 * Check that SQL typed by a person is one read-only query. The connection is
 * also opened read-only; this gives a clear message before the database does.
 */
export function checkReadOnlySql(input: string, dialect: SqlDialect): { sql: string } | { error: string } {
  let code = '';
  for (let index = 0; index < input.length;) {
    const character = input[index];
    const next = input[index + 1];
    // MySQL reads `--` as a comment only when a space or the end of a line follows it.
    const dashes = character === '-' && next === '-' && (dialect !== 'mysql' || !/\S/.test(input[index + 2] ?? ' '));
    if (dialect === 'mysql' && character === '/' && next === '*' && input[index + 2] === '!')
      // MySQL runs the text of a /*! … */ comment, so it is not a comment to skip.
      return { error: 'Executable comments (/*! … */) cannot run here.' };
    if (dashes || (character === '#' && dialect === 'mysql')) {
      const end = input.indexOf('\n', index);
      index = end === -1 ? input.length : end;
      code += ' ';
    } else if (character === '/' && next === '*') {
      const end = input.indexOf('*/', index + 2);
      index = end === -1 ? input.length : end + 2;
      code += ' ';
    } else if (character === "'" || character === '"' || character === '`') {
      let end = index + 1;
      // MySQL strings also escape with a backslash, as in 'it\'s'.
      const backslash = dialect === 'mysql' && character !== '`';
      while (end < input.length && !(input[end] === character && input[end + 1] !== character)) {
        end += input[end] === character || (backslash && input[end] === '\\') ? 2 : 1;
      }
      index = end + 1;
      code += ' x ';
    } else if (character === '$' && dialect === 'postgres') {
      // Postgres dollar quoting: $$text$$ or $tag$text$tag$. SQLite has none; there `$a` names a parameter.
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(input.slice(index))?.[0];
      if (tag) {
        const end = input.indexOf(tag, index + tag.length);
        index = end === -1 ? input.length : end + tag.length;
        code += ' x ';
      } else {
        code += character;
        index++;
      }
    } else {
      code += character;
      index++;
    }
  }
  const statement = code.replace(/[\s;]+$/, '');
  if (!statement.trim()) return { error: 'Enter a SELECT query.' };
  if (statement.includes(';')) return { error: 'Run one statement at a time.' };
  if (!/^[\s(]*(?:select|with|values)\b/i.test(statement)) return { error: 'Only SELECT queries can run here.' };
  return { sql: input.trim().replace(/;\s*$/, '') };
}

/** Wrap a checked query so the database returns at most `limit` rows. */
export function limitedSql(sql: string, dialect: SqlDialect, limit: number): SqlStatement {
  // The query sits on its own lines so a trailing -- comment cannot swallow the wrapper.
  return {
    sql: `SELECT * FROM (\n${sql}\n) AS logline_query LIMIT ${dialect === 'postgres' ? '$1' : '?'}`,
    params: [limit],
  };
}

/** How a time value read back from a query is stored, to filter the query on it. */
export function valueEncoding(value: unknown): TimeEncoding | undefined {
  if (value instanceof Date) return 'native';
  const number =
    typeof value === 'number' || typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : undefined;
  if (number !== undefined)
    return Number.isFinite(number) ? (Math.abs(number) < 1e11 ? 'epoch_s' : 'epoch_ms') : undefined;
  return typeof value === 'string' && Number.isFinite(timeValueMs(value, 'iso')) ? 'iso' : undefined;
}

/**
 * Wrap a checked query so the database returns only its rows whose `column`
 * falls in the range, the newest first, at most `limit` of them.
 */
export function rangedSql(
  sql: string,
  dialect: SqlDialect,
  time: { column: string; encoding: TimeEncoding },
  fromMs: number,
  toMs: number,
  limit: number,
): SqlStatement {
  const params = new Params(dialect);
  const terms = timeExpression(dialect, time.column, time.encoding, params);
  const where = `${terms.column} BETWEEN ${terms.at(fromMs)} AND ${terms.at(toMs)}`;
  const order = `${quoteIdentifier(time.column, dialect)} DESC`;
  return {
    sql: `SELECT * FROM (\n${sql}\n) AS logline_query WHERE ${where} ORDER BY ${order} LIMIT ${params.add(limit)}`,
    params: params.values,
  };
}

export interface RowRoles {
  timestamp?: string;
  level?: string;
  message?: string;
  service?: string;
  traceId?: string;
}

// Text such as SQLite's CURRENT_TIMESTAMP has no zone; databases store UTC there.
const NAIVE_DATETIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/;

/** Epoch milliseconds for a stored time value. */
export function timeValueMs(value: unknown, encoding: TimeEncoding | 'auto'): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  let number: number | undefined;
  if (typeof value === 'number' || typeof value === 'bigint') number = Number(value);
  else if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) number = Number(value);
  if (number !== undefined && Number.isFinite(number)) {
    if (encoding === 'epoch_s') return number * 1000;
    if (encoding === 'epoch_ms') return number;
    // Seconds since 1970 stay below 1e11 until the year 5138.
    return Math.abs(number) < 1e11 ? number * 1000 : number;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const parsed = Date.parse(NAIVE_DATETIME.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const ROW_ROLES = ['level', 'message', 'service', 'traceId'] as const;

/** Set a field, defining `__proto__` as a field of its own instead of the object's prototype. */
export function setField(target: Record<string, unknown>, name: string, value: unknown): void {
  if (name === '__proto__')
    Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  else target[name] = value;
}

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}

/**
 * One row as a JSON log line: the time, level, message, service, and trace id
 * under the names Logline reads, then every other column as a field.
 */
export function rowToLine(
  row: Record<string, unknown>,
  roles: RowRoles,
  encoding: TimeEncoding | 'auto',
): { line: string; timeMs?: number } {
  // Built as one object, in order, since this runs for every fetched row.
  const out: Record<string, unknown> = {};
  const used: string[] = [];
  const timeMs = roles.timestamp !== undefined ? timeValueMs(row[roles.timestamp], encoding) : undefined;
  if (timeMs !== undefined) out.timestamp = new Date(timeMs).toISOString();
  if (roles.timestamp !== undefined) used.push(roles.timestamp);
  for (const role of ROW_ROLES) {
    const column = roles[role];
    if (column === undefined || !Object.hasOwn(row, column)) continue;
    used.push(column);
    const value = plain(row[column]);
    if (value !== null && value !== undefined) out[role] = value;
  }
  const named = Object.keys(out);
  for (const name in row) {
    if (!Object.hasOwn(row, name) || used.includes(name)) continue;
    // A column that shares a name with a mapped role keeps its value under another name.
    setField(out, named.includes(name) ? `${name}_column` : name, plain(row[name]));
  }
  return { line: JSON.stringify(out), timeMs };
}

/** Roles for rows from a query typed by a person: the mapping's columns when present, else guessed from names. */
export function rowRoles(columns: string[], mapping?: LogTableMapping): RowRoles {
  const has = (name: string | undefined) => (name !== undefined && columns.includes(name) ? name : undefined);
  const guess = (pattern: RegExp) => columns.find((name) => pattern.test(name));
  return {
    timestamp:
      has(mapping?.timestamp) ??
      guess(/^(?:timestamp|ts|time|datetime|date_?time|created_?at|logged_?at|inserted_?at|occurred_?at)$/i),
    level: has(mapping?.level) ?? guess(/^(?:level|severity|log_?level|lvl)$/i),
    message: has(mapping?.message) ?? guess(/^(?:message|msg|text|body|log|line)$/i),
    service: has(mapping?.service) ?? guess(/^(?:service|service_?name|app|application)$/i),
    traceId: has(mapping?.traceId) ?? guess(/^(?:trace_?id|traceid)$/i),
  };
}
