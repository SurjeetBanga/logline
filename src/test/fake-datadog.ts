import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A log as the Logs Search API returns it. */
export interface FakeLog {
  id: string;
  timestamp: string;
  status: string;
  message: string;
  service?: string;
  host?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
}

/** A metric series as GET /api/v1/query returns it: `points` are [ms, value]. */
export interface FakeSeries {
  metric: string;
  scope: string;
  points: [number, number][];
  unit?: string;
}

export interface FakeDatadogOptions {
  apiKey?: string;
  appKey?: string;
  token?: string;
  logs?: FakeLog[];
  series?: FakeSeries[];
}

type Json = Record<string, unknown>;

// --- A small part of Datadog's log search syntax, enough to check what Logline sends. ---

function tokens(query: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < query.length; index++) {
    const character = query[index];
    if (character === '\\' && index + 1 < query.length) {
      current += character + query[++index];
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && (character === '(' || character === '[')) depth++;
    if (!quoted && (character === ')' || character === ']')) depth--;
    if (!quoted && depth === 0 && /\s/.test(character)) {
      if (current) out.push(current);
      current = '';
    } else current += character;
  }
  if (current) out.push(current);
  return out;
}

const unescape = (value: string) => value.replace(/\\(.)/g, '$1');

function field(log: FakeLog, name: string): unknown {
  if (name === 'status' || name === 'service' || name === 'host') return log[name];
  if (name === 'trace_id') return (log.attributes?.dd as Json | undefined)?.trace_id ?? log.attributes?.trace_id;
  if (name.startsWith('@')) {
    let value: unknown = log.attributes;
    for (const part of name.slice(1).split('.'))
      value = value && typeof value === 'object' ? (value as Json)[part] : undefined;
    return value;
  }
  return undefined;
}

function valueMatches(actual: unknown, pattern: string): boolean {
  if (actual === undefined || actual === null) return false;
  if (pattern.startsWith('(') && pattern.endsWith(')'))
    return pattern
      .slice(1, -1)
      .split(/\s+OR\s+/)
      .some((option) => valueMatches(actual, option.trim()));
  const range = pattern.match(/^\[(\S+) TO (\S+)\]$/);
  if (range) return Number(actual) >= Number(range[1]) && Number(actual) <= Number(range[2]);
  const comparison = pattern.match(/^(>=|<=|>|<)(.+)$/);
  if (comparison) {
    const [left, right] = [Number(actual), Number(comparison[2])];
    return { '>': left > right, '>=': left >= right, '<': left < right, '<=': left <= right }[comparison[1]]!;
  }
  if (pattern === '*') return true;
  const value = String(actual).toLowerCase();
  // An unescaped `*` stands for any text; anything else must match whole.
  const source = pattern
    .toLowerCase()
    .replace(/\\(.)|(\*)|([^\\*])/g, (_, escaped: string, star: string, plain: string) =>
      star ? '.*' : (escaped ?? plain).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
  return new RegExp(`^${source}$`, 's').test(value);
}

function termMatches(log: FakeLog, term: string): boolean {
  if (term.startsWith('-')) return !termMatches(log, term.slice(1));
  if (term.startsWith('(') && term.endsWith(')')) return queryMatches(log, term.slice(1, -1));
  const pair = term.match(/^(@?[A-Za-z_][\w.@-]*):(.+)$/s);
  if (pair) return valueMatches(field(log, pair[1]), pair[2]);
  // Free text searches the message.
  const message = log.message.toLowerCase();
  if (term.startsWith('"')) return message.includes(term.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase());
  const text = unescape(term).toLowerCase();
  return text.startsWith('*') && text.endsWith('*')
    ? message.includes(text.slice(1, -1))
    : message.split(/\W+/).includes(text);
}

export function queryMatches(log: FakeLog, query: string): boolean {
  const parts = tokens(query.trim() || '*');
  const groups: string[][] = [[]];
  for (const part of parts)
    if (part === 'OR') groups.push([]);
    else groups.at(-1)!.push(part);
  return groups.some((group) => group.every((term) => term === '*' || termMatches(log, term)));
}

// --- The server. ---

async function body(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Json) : {};
}

/** A Datadog API on 127.0.0.1 for tests and local trials: logs search, counts, and metric queries. */
export async function startFakeDatadog(options: FakeDatadogOptions = {}) {
  const state = {
    logs: options.logs ?? [],
    series: options.series ?? [],
    requests: [] as { path: string; body: Json; headers: Record<string, string | string[] | undefined> }[],
    /** Answer the next requests with 429. */
    rateLimited: 0,
  };
  const authorized = (request: IncomingMessage) =>
    options.token
      ? request.headers.authorization === `Bearer ${options.token}`
      : (!options.apiKey || request.headers['dd-api-key'] === options.apiKey) &&
        (!options.appKey || request.headers['dd-application-key'] === options.appKey);
  const inRange = (log: FakeLog, filter: Json) => {
    const time = Date.parse(log.timestamp);
    return time >= Number(filter.from ?? 0) && time <= Number(filter.to ?? Infinity);
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const json = request.method === 'POST' ? await body(request) : {};
      state.requests.push({ path: url.pathname, body: json, headers: request.headers });
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(payload));
      };
      if (state.rateLimited > 0) {
        state.rateLimited--;
        return send(429, { errors: ['Too many requests'] }, { 'x-ratelimit-reset': '7' });
      }
      if (!authorized(request)) return send(403, { errors: ['Forbidden'] });
      if (url.pathname === '/api/v2/logs/events/search' || url.pathname === '/api/v2/logs/analytics/aggregate') {
        const filter = (json.filter ?? {}) as Json;
        const matching = state.logs
          .filter((log) => inRange(log, filter) && queryMatches(log, String(filter.query ?? '*')))
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        if (url.pathname.endsWith('aggregate'))
          return send(200, {
            data: { buckets: [{ by: {}, computes: { c0: matching.length } }] },
            meta: { status: 'done' },
          });
        if (json.sort === '-timestamp') matching.reverse();
        const page = (json.page ?? {}) as Json;
        const start = Number(page.cursor ?? 0);
        const limit = Number(page.limit ?? 10);
        const slice = matching.slice(start, start + limit);
        const next = start + limit < matching.length ? String(start + limit) : undefined;
        return send(200, {
          data: slice.map((log) => ({
            id: log.id,
            type: 'log',
            attributes: {
              timestamp: log.timestamp,
              status: log.status,
              message: log.message,
              service: log.service,
              host: log.host,
              tags: log.tags ?? [],
              attributes: log.attributes ?? {},
            },
          })),
          meta: { page: next ? { after: next } : {}, status: 'done' },
        });
      }
      if (url.pathname === '/api/v1/query') {
        const query = url.searchParams.get('query') ?? '';
        const from = Number(url.searchParams.get('from')) * 1000;
        const to = Number(url.searchParams.get('to')) * 1000;
        const name = query.replace(/^[a-z]+:/, '').split('{')[0];
        const series = state.series
          .filter((candidate) => candidate.metric === name)
          .map((candidate) => ({
            metric: candidate.metric,
            display_name: candidate.metric,
            scope: candidate.scope,
            expression: query,
            pointlist: candidate.points.filter(([time]) => time >= from && time <= to),
            unit: candidate.unit ? [{ short_name: candidate.unit, family: 'time' }, null] : null,
          }));
        return send(200, { status: 'ok', query, series });
      }
      if (url.pathname === '/api/v1/metrics')
        return send(200, { metrics: [...new Set(state.series.map((series) => series.metric))] });
      send(404, { errors: ['Not found'] });
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
