import { LOKI_SELECTOR, type LokiConnection } from '../../core/connections';
import { lokiQuery, nativeLokiQuery } from '../../core/loki-query';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';
import { readPages } from './paging';
import { LogFields } from './record';
import type { Connector, FetchRequest, FetchResult, RemoteRecord } from './types';

// The most lines Loki returns for one query unless its limits are raised (max_entries_limit_per_query).
const PAGE = 5000;
// A first page this small comes back sooner, to show while the rest is read.
const FIRST_PAGE = 200;
// Fields every Logline event has; set from the stream when a JSON line does not have them.
const OWN = new Set(['timestamp', 'message', 'service']);

/** Milliseconds from Loki's nanoseconds, which are too many digits for a number. */
const milliseconds = (ns: string) => Number(ns.length > 6 ? ns.slice(0, -6) : '0');

/**
 * One line of a stream as a JSON log line. A JSON line is the log itself, with
 * the stream's labels beside its fields; any other line is its text. This runs
 * for every fetched log.
 */
export function lokiLine(labels: Record<string, string>, ns: string, line: string, metadata?: unknown): RemoteRecord {
  const fields = new LogFields(OWN);
  let parsed: Json | undefined;
  if (line.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Json;
    } catch {
      parsed = undefined;
    }
  }
  const timeMs = milliseconds(ns);
  if (parsed) {
    if (parsed.timestamp === undefined) fields.put('timestamp', new Date(timeMs).toISOString());
    for (const name in parsed) if (Object.hasOwn(parsed, name)) fields.put(name, parsed[name]);
  } else {
    fields.put('timestamp', new Date(timeMs).toISOString());
    fields.message(line);
  }
  // Labels Loki added, such as the service and level it detected, fill in what the line does not say.
  if (labels.service_name && fields.fields.service === undefined) fields.put('service', labels.service_name);
  for (const [name, value] of [...Object.entries(labels), ...Object.entries(object(metadata))])
    if (fields.fields[name] === undefined) fields.put(name, value);
  // The time to the nanosecond keeps two lines of the same text and millisecond apart, as a tail tells new
  // lines from ones it showed.
  fields.put('loki.ns', ns);
  return fields.record(timeMs);
}

function problem(status: number, headers: Headers, text: string): Error {
  const detail = text.trim().slice(0, 300);
  if (status === 401 || status === 403)
    return new Error(`Loki refused the credentials (${status}${detail ? `: ${detail}` : ''}).`);
  if (status === 429) {
    const seconds = Number(headers.get('retry-after'));
    return retryAfter(
      `Loki's query limit was reached${detail ? `: ${detail}` : ''}.`,
      (seconds > 0 ? seconds : 10) * 1000,
    );
  }
  if (status === 400) return new Error(`Loki could not run the query: ${detail}`);
  return new Error(`Loki answered ${status}${detail ? `: ${detail}` : ''}.`);
}

/** A line read from Loki, with what orders and tells it apart. */
type Entry = RemoteRecord & { ns: bigint; key: string };

/**
 * Searches Grafana Loki with LogQL. A search becomes line filters and label
 * filters; terms LogQL cannot express are applied to the fetched logs.
 */
export class LokiConnector implements Connector {
  /** Loki makes lines searchable within seconds of receiving them. */
  readonly tailLagMs = 5000;
  readonly selector: string;

  constructor(
    readonly connection: LokiConnection,
    /** The password or token, kept in secret storage. */
    private readonly secret: string | undefined,
    private readonly timeoutMs: () => number,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {
    this.selector = connection.selector ?? LOKI_SELECTOR;
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Json> {
    const headers: Record<string, string> = {};
    if (this.connection.user)
      headers.authorization = `Basic ${Buffer.from(`${this.connection.user}:${this.secret ?? ''}`).toString('base64')}`;
    else if (this.secret) headers.authorization = `Bearer ${this.secret}`;
    if (this.connection.tenant) headers['X-Scope-OrgID'] = this.connection.tenant;
    const answer = await requestJson({
      service: `Loki at ${this.connection.url}`,
      url: `${this.connection.url}${path}?${new URLSearchParams(params)}`,
      method: 'GET',
      headers,
      timeoutMs: this.timeoutMs(),
      signal,
      fetcher: this.fetcher,
    });
    if (!answer.ok) throw problem(answer.status, answer.headers, answer.text);
    if (!answer.json) throw new Error('Loki returned a response that is not JSON.');
    return answer.json;
  }

  async test(): Promise<string> {
    const now = Date.now();
    const answer = await this.get('/loki/api/v1/labels', { start: `${now - 3600000}000000`, end: `${now}000000` });
    const labels = Array.isArray(answer.data) ? answer.data.length : 0;
    // A query reads the streams a search would, so a selector that Loki refuses fails here.
    await this.get('/loki/api/v1/query_range', {
      query: this.selector,
      start: `${now - 300000}000000`,
      end: `${now}000000`,
      limit: '1',
      direction: 'backward',
    });
    return `Loki · ${labels} label${labels === 1 ? '' : 's'} at ${new URL(this.connection.url).host}`;
  }

  async preview(query: string): Promise<{ statement: string; local: string[] }> {
    const translated = lokiQuery(query, this.selector);
    return { statement: translated.query, local: translated.local };
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    const translated =
      request.native !== undefined
        ? { query: nativeLokiQuery(request.native, this.selector), pushed: [], local: [] }
        : lokiQuery(request.query, this.selector);
    const toMs = request.toMs ?? started;
    const fromMs = request.fromMs ?? toMs - 900000;
    const backward = request.order === 'desc';
    // Pages meet at a time: the next starts at the last one's oldest (or newest) line, so lines at that very
    // nanosecond are read again and dropped.
    const seen = new Set<string>();
    let counting: Promise<number | undefined> | undefined;
    const records = await readPages<bigint>({
      limit: request.limit,
      pageSize: PAGE,
      firstPageSize: FIRST_PAGE,
      ...(request.firstPage ? { firstPage: request.firstPage } : {}),
      onMore: () => {
        if (request.countTotal) counting = this.count(translated.query, fromMs, toMs, signal).catch(() => undefined);
      },
      fetchPage: async (size, cursor) => {
        const start = backward ? BigInt(fromMs) * 1000000n : (cursor ?? BigInt(fromMs) * 1000000n);
        // The end is not included, so a page that ends at a line's time is read to just after it.
        const end = backward ? (cursor ?? BigInt(toMs) * 1000000n + 1n) : BigInt(toMs) * 1000000n + 1n;
        const answer = await this.get(
          '/loki/api/v1/query_range',
          {
            query: translated.query,
            start: String(start),
            end: String(end),
            limit: String(size),
            direction: backward ? 'backward' : 'forward',
          },
          signal,
        );
        const data = object(answer.data);
        if (data.resultType !== undefined && data.resultType !== 'streams')
          throw new Error('That LogQL query returns numbers, not log lines. Search with a log query.');
        const entries: Entry[] = [];
        let returned = 0;
        for (const stream of Array.isArray(data.result) ? data.result : []) {
          const labels = object(object(stream).stream) as Record<string, string>;
          const values = object(stream).values;
          for (const value of Array.isArray(values) ? values : []) {
            if (!Array.isArray(value) || typeof value[0] !== 'string' || typeof value[1] !== 'string') continue;
            returned++;
            const key = `${JSON.stringify(labels)}\n${value[0]}\n${value[1]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({ ...lokiLine(labels, value[0], value[1], value[2]), ns: BigInt(value[0]), key });
          }
        }
        // Each stream is in order; together they are merged by time.
        entries.sort((a, b) =>
          backward ? (a.ns < b.ns ? 1 : a.ns > b.ns ? -1 : 0) : a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0,
        );
        const last = entries.at(-1)?.ns;
        // A page Loki filled to the size has more after its last line, counting lines read again at the edge.
        const full = returned >= size;
        const next = full && last !== undefined ? (backward ? last + 1n : last) : undefined;
        return {
          records: entries.map(({ line, timeMs }) => (timeMs === undefined ? { line } : { line, timeMs })),
          ...(next !== undefined ? { next } : {}),
        };
      },
    });
    const total = records.length >= request.limit ? await counting : undefined;
    return {
      records,
      ...(total !== undefined ? { total } : {}),
      pushed: translated.pushed,
      local: translated.local,
      statement: translated.query,
      elapsedMs: Date.now() - started,
    };
  }

  /** How many lines a query matches in a range, counted by Loki. */
  private async count(query: string, fromMs: number, toMs: number, signal?: AbortSignal): Promise<number | undefined> {
    const seconds = Math.max(1, Math.ceil((toMs - fromMs) / 1000));
    const answer = await this.get(
      '/loki/api/v1/query',
      { query: `sum(count_over_time(${query} [${seconds}s]))`, time: `${toMs}000000` },
      signal,
    );
    const [first] = Array.isArray(object(answer.data).result) ? (object(answer.data).result as unknown[]) : [];
    const value = object(first).value;
    return Array.isArray(value) && Number.isFinite(Number(value[1])) ? Number(value[1]) : undefined;
  }

  /** The services that logged in a window, by how many lines, from Loki's index; names alone from older Lokis. */
  async services(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ name: string; count?: number }[]> {
    const range = { start: `${fromMs}000000`, end: `${toMs}000000` };
    try {
      const answer = await this.get(
        '/loki/api/v1/index/volume',
        { query: '{service_name=~".+"}', ...range, limit: '100' },
        signal,
      );
      const result = object(answer.data).result;
      return (Array.isArray(result) ? result : [])
        .map((item) => ({
          name: String(object(object(item).metric).service_name ?? ''),
          count: Number((object(item).value as unknown[] | undefined)?.[1]) || 0,
        }))
        .filter((service) => service.name)
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      if (signal?.aborted) throw error;
      const answer = await this.get('/loki/api/v1/label/service_name/values', range, signal);
      return (Array.isArray(answer.data) ? answer.data : []).map((name) => ({ name: String(name) }));
    }
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
