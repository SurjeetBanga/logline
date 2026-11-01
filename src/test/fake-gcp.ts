import { startFakeHttp, type FakeRequest } from './fake-http';

type Json = Record<string, unknown>;
type Condition = (entry: Json) => boolean;

export interface FakeGcpOptions {
  entries?: Json[];
  /** The access token requests must carry. */
  token?: string;
}

// --- A part of the Logging query language, enough to check what Logline sends. ---

const SEVERITIES = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];

function at(entry: Json, path: string): unknown {
  let value: unknown = entry;
  for (const part of path.split('.'))
    value = value && typeof value === 'object' ? (value as Json)[part.replace(/^"|"$/g, '')] : undefined;
  return value;
}

function compare(actual: unknown, operator: string, literal: unknown, path: string): boolean {
  if (operator === ':') {
    if (literal === '*') return actual !== undefined;
    return (
      actual !== undefined &&
      String(typeof actual === 'object' ? JSON.stringify(actual) : actual)
        .toLowerCase()
        .includes(String(literal).toLowerCase())
    );
  }
  if (actual === undefined) return operator === '!=';
  if (operator === '=~' || operator === '!~') {
    const source = String(literal);
    const insensitive = source.startsWith('(?i)');
    const found = new RegExp(insensitive ? source.slice(4) : source, insensitive ? 'is' : 's').test(String(actual));
    return operator === '=~' ? found : !found;
  }
  if (path === 'severity') {
    const [a, b] = [SEVERITIES.indexOf(String(actual)), SEVERITIES.indexOf(String(literal))];
    return { '=': a === b, '!=': a !== b, '>': a > b, '>=': a >= b, '<': a < b, '<=': a <= b }[operator] ?? false;
  }
  if (typeof literal === 'number') {
    const value = Number(actual);
    if (typeof actual !== 'number') return false;
    return (
      {
        '=': value === literal,
        '!=': value !== literal,
        '>': value > literal,
        '>=': value >= literal,
        '<': value < literal,
        '<=': value <= literal,
      }[operator] ?? false
    );
  }
  const [a, b] = [String(actual), String(literal)];
  return { '=': a === b, '!=': a !== b, '>': a > b, '>=': a >= b, '<': a < b, '<=': a <= b }[operator] ?? false;
}

/** A query as a condition on an entry. In this language NOT binds tightest, then OR, then AND. */
export function parseLoggingQuery(query: string): Condition {
  let at_ = 0;
  const space = () => {
    while (/\s/.test(query[at_] ?? '')) at_++;
  };
  const keyword = (word: string) => {
    space();
    if (query.startsWith(`${word} `, at_) || query.startsWith(`${word}(`, at_)) {
      at_ += word.length;
      return true;
    }
    return false;
  };
  const and = (): Condition => {
    const parts = [or()];
    while (keyword('AND')) parts.push(or());
    return (entry) => parts.every((part) => part(entry));
  };
  const or = (): Condition => {
    const parts = [not()];
    while (keyword('OR')) parts.push(not());
    return (entry) => parts.some((part) => part(entry));
  };
  const not = (): Condition => {
    if (keyword('NOT')) {
      const inner = not();
      return (entry) => !inner(entry);
    }
    return primary();
  };
  const primary = (): Condition => {
    space();
    if (query[at_] === '(') {
      at_++;
      const inner = and();
      space();
      if (query[at_] !== ')') throw new Error(`Unparseable filter: expected ) at ${at_}`);
      at_++;
      return inner;
    }
    const string = /^"(?:\\.|[^"\\])*"/.exec(query.slice(at_));
    if (string) {
      // A bare string searches every field, without case.
      at_ += string[0].length;
      const text = (JSON.parse(string[0]) as string).toLowerCase();
      return (entry) => JSON.stringify(entry).toLowerCase().includes(text);
    }
    const match =
      /^((?:[A-Za-z_]\w*|"(?:\\.|[^"\\])*")(?:\.(?:[A-Za-z_]\w*|"(?:\\.|[^"\\])*"))*)\s*(=~|!~|>=|<=|!=|=|>|<|:)\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|\*|[A-Z]+)/.exec(
        query.slice(at_),
      );
    if (!match) throw new Error(`Unparseable filter at ${at_}: ${query.slice(at_, at_ + 30)}`);
    at_ += match[0].length;
    const [, path, operator, raw] = match;
    const literal: unknown = raw.startsWith('"') ? JSON.parse(raw) : /^-?\d/.test(raw) ? Number(raw) : raw;
    return (entry) => compare(at(entry, path), operator, literal, path);
  };
  const condition = and();
  space();
  if (at_ < query.length) throw new Error(`Unparseable filter at ${at_}: ${query.slice(at_, at_ + 30)}`);
  return condition;
}

// --- The server. ---

/** A Cloud Logging API on 127.0.0.1 for tests and local trials: entries.list. */
export async function startFakeGcp(options: FakeGcpOptions = {}) {
  const state = {
    entries: options.entries ?? [],
    requests: [] as FakeRequest[],
    /** Answer the next requests with 429 RESOURCE_EXHAUSTED. */
    rateLimited: 0,
    /** Answer the next requests with 401, as for a token that stopped working. */
    expired: 0,
  };
  const error = (code: number, status: string, message: string) => ({
    status: code,
    payload: { error: { code, status, message } },
  });
  const fake = await startFakeHttp((request) => {
    if (state.rateLimited > 0) {
      state.rateLimited--;
      return error(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric Read requests');
    }
    if (state.expired > 0) {
      state.expired--;
      return error(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    }
    if (options.token && request.headers.authorization !== `Bearer ${options.token}`)
      return error(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    if (request.path !== '/v2/entries:list') return error(404, 'NOT_FOUND', 'Not found');
    let condition: Condition;
    try {
      condition = parseLoggingQuery(String(request.body.filter ?? ''));
    } catch (failure) {
      return error(400, 'INVALID_ARGUMENT', (failure as Error).message);
    }
    const descending = request.body.orderBy === 'timestamp desc';
    const found = state.entries
      .filter(condition)
      .sort((a, b) => (descending ? -1 : 1) * (Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp))));
    const start = Number(request.body.pageToken ?? 0);
    const size = Number(request.body.pageSize ?? 50);
    const next = start + size < found.length ? String(start + size) : undefined;
    return {
      status: 200,
      payload: { entries: found.slice(start, start + size), ...(next ? { nextPageToken: next } : {}) },
    };
  });
  state.requests = fake.requests;
  return { url: fake.url, state, close: fake.close };
}
