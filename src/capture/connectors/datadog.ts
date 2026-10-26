import { datadogApiBase, type DatadogConnection } from '../../core/connections';
import { datadogQuery } from '../../core/datadog-query';
import { stripAnsi } from '../../core/log-event';
import { boundSeries, datadogSeries } from '../../core/metric-query';
import {
  errorText,
  timedOut,
  type Connector,
  type FetchRequest,
  type FetchResult,
  type MetricResult,
  type RemoteRecord,
} from './types';

/** API and application keys, or an access token, kept in secret storage. */
export interface DatadogKeys {
  apiKey?: string;
  appKey?: string;
  token?: string;
}

type Json = Record<string, unknown>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The most the Logs Search API returns in one page: a default fetch is one request.
const PAGE = 5000;
// A first page this small comes back sooner, to show while the rest is read.
const FIRST_PAGE = 200;
// Fields every Logline event has; a log attribute with one of these names keeps its value under `attributes.`.
const RESERVED = new Set(['timestamp', 'level', 'message', 'service', 'host', 'traceId', 'tags', 'datadog.id']);

const SEARCH = '/api/v2/logs/events/search';
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

/** One log from the Logs Search API as a JSON log line. This runs for every fetched log. */
export function datadogLine(item: unknown): RemoteRecord {
  const log = object(item);
  const attributes = object(log.attributes);
  const custom = object(attributes.attributes);
  const dd = object(custom.dd);
  const ddTraceId = dd.trace_id;
  const traceId = ddTraceId ?? custom.trace_id ?? custom.traceId;
  const fields: Json = {};
  const put = (name: string, value: unknown) => {
    if (value !== undefined && value !== null) fields[name] = value;
  };
  put('timestamp', attributes.timestamp);
  put('level', attributes.status);
  // Colors a service printed reach Datadog as escape codes; the message keeps its text.
  put('message', typeof attributes.message === 'string' ? stripAnsi(attributes.message) : attributes.message);
  put('service', attributes.service);
  put('host', attributes.host);
  if (traceId !== undefined) put('traceId', String(traceId));
  for (const name in custom) {
    if (!Object.hasOwn(custom, name)) continue;
    // The trace id is already the event's traceId; keep the rest of `dd`, such as its span id.
    if (name === 'dd' && ddTraceId !== undefined) {
      const { trace_id: _, ...rest } = dd;
      if (Object.keys(rest).length) fields.dd = rest;
      continue;
    }
    put(RESERVED.has(name) ? `attributes.${name}` : name, custom[name]);
  }
  // A filter finds a tag such as `env:prod` here as the field `env`.
  if (Array.isArray(attributes.tags) && attributes.tags.length) fields.tags = attributes.tags.join(',');
  if (typeof log.id === 'string') fields['datadog.id'] = log.id;
  const time = typeof attributes.timestamp === 'string' ? Date.parse(attributes.timestamp) : NaN;
  const record: RemoteRecord = { line: JSON.stringify(fields) };
  if (Number.isFinite(time)) record.timeMs = time;
  return record;
}

function problem(status: number, headers: Headers, body: Json | undefined, text: string, token: boolean): Error {
  const errors = Array.isArray(body?.errors) ? body.errors.map(String).join('; ') : text.slice(0, 300);
  if (status === 401 || status === 403)
    return new Error(
      `Datadog refused the ${token ? 'access token' : 'API or application key'} (${status}${errors ? `: ${errors}` : ''}). Logs need the logs_read_data permission; metrics need timeseries_query and metrics_read.`,
    );
  if (status === 429) {
    const reset = Number(headers.get('x-ratelimit-reset'));
    const known = Number.isFinite(reset) && reset > 0;
    // Tails wait this long before reading again.
    return Object.assign(new Error(`Datadog's rate limit was reached${known ? `; try again in ${reset} s` : ''}.`), {
      retryAfterMs: (known ? reset : 60) * 1000,
    });
  }
  return new Error(`Datadog answered ${status}${errors ? `: ${errors}` : ''}.`);
}

/**
 * Searches logs in Datadog with the Logs Search API. A search becomes Datadog
 * syntax; terms Datadog cannot express are applied to the fetched logs.
 */
export class DatadogConnector implements Connector {
  /** Logs can take a minute or so to become searchable after their own time. */
  readonly tailLagMs = 60000;
  /**
   * Datadog limits how often an organization can search logs. Tails read as often as the limit its last
   * answer reported allows, and every 15 s until one has.
   */
  tailPollMs = 15000;
  readonly base: string;

  constructor(
    readonly connection: DatadogConnection,
    private readonly keys: DatadogKeys,
    private readonly timeoutMs: () => number,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {
    this.base = datadogApiBase(connection.site) ?? '';
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<Json> {
    if (!this.base) throw new Error(`${this.connection.site} is not a Datadog site.`);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.keys.token) headers.authorization = `Bearer ${this.keys.token}`;
    else {
      if (this.keys.apiKey) headers['DD-API-KEY'] = this.keys.apiKey;
      if (this.keys.appKey) headers['DD-APPLICATION-KEY'] = this.keys.appKey;
    }
    const limit = this.timeoutMs();
    const timeout = AbortSignal.timeout(limit);
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('The query was cancelled.');
      if (timeout.aborted) throw timedOut(limit);
      throw new Error(`Could not reach Datadog at ${this.base}: ${errorText(error)}`);
    }
    const text = await response.text();
    let json: Json | undefined;
    try {
      json = text ? object(JSON.parse(text)) : {};
    } catch {
      json = undefined;
    }
    if (path === SEARCH) this.pace(response.headers);
    if (!response.ok) throw problem(response.status, response.headers, json, text, !!this.keys.token);
    if (!json) throw new Error('Datadog returned a response that is not JSON.');
    return json;
  }

  /**
   * Spread searches evenly over the rate limit's period, or, when the organization has used most of it, over
   * the time until it resets.
   */
  private pace(headers: Headers): void {
    const header = (name: string) => Number(headers.get(name) ?? NaN);
    const limit = header('x-ratelimit-limit');
    const period = header('x-ratelimit-period');
    if (!(limit > 0 && period > 0)) return;
    let ms = (period * 1000) / limit;
    const remaining = header('x-ratelimit-remaining');
    const reset = header('x-ratelimit-reset');
    if (remaining >= 0 && reset > 0) ms = Math.max(ms, (reset * 1000) / Math.max(remaining, 1));
    this.tailPollMs = Math.min(Math.ceil(ms), 60000);
  }

  async test(): Promise<string> {
    // A search of one log checks the keys and the permission to read logs together.
    const now = Date.now();
    await this.request('POST', SEARCH, {
      filter: { query: '*', from: String(now - 900000), to: String(now) },
      page: { limit: 1 },
    });
    return `Datadog · logs readable at ${this.base.replace(/^https?:\/\//, '')}`;
  }

  async preview(query: string): Promise<{ statement: string; local: string[] }> {
    const translated = datadogQuery(query);
    return { statement: translated.query, local: translated.local };
  }

  private filter(query: string, fromMs: number, toMs: number) {
    return {
      query,
      from: String(fromMs),
      to: String(toMs),
      ...(this.connection.indexes?.length ? { indexes: this.connection.indexes } : {}),
    };
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    // Typed Datadog syntax, such as from a Log Explorer link, is sent as it is.
    const translated =
      request.native !== undefined ? { query: request.native, pushed: [], local: [] } : datadogQuery(request.query);
    const toMs = request.toMs ?? started;
    const fromMs = request.fromMs ?? toMs - 900000;
    const filter = this.filter(translated.query, fromMs, toMs);
    // The total is counted once the first page shows there are more logs than it held, while the rest are read;
    // a failed count leaves it unknown.
    let counting: Promise<number | undefined> | undefined;
    const records: RemoteRecord[] = [];
    let cursor: string | undefined;
    let early = request.firstPage !== undefined && request.limit > FIRST_PAGE;
    do {
      const page = await this.request(
        'POST',
        SEARCH,
        {
          filter,
          sort: request.order === 'desc' ? '-timestamp' : 'timestamp',
          page: {
            limit: Math.min(early ? FIRST_PAGE : PAGE, request.limit - records.length),
            ...(cursor ? { cursor } : {}),
          },
        },
        signal,
      );
      const data = Array.isArray(page.data) ? page.data : [];
      records.push(...data.map(datadogLine));
      const after = object(object(page.meta).page).after;
      cursor = typeof after === 'string' && after && data.length ? after : undefined;
      if (request.countTotal && cursor && !counting) counting = this.count(filter, signal).catch(() => undefined);
      // Only a first page with more to follow is worth showing early.
      if (early && cursor) request.firstPage!([...records]);
      early = false;
    } while (cursor && records.length < request.limit);
    // Every match was read when the limit did not cut the result short: the count is not waited for.
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

  private async count(
    filter: ReturnType<DatadogConnector['filter']>,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const counted = await this.request(
      'POST',
      '/api/v2/logs/analytics/aggregate',
      { compute: [{ aggregation: 'count', type: 'total' }], filter },
      signal,
    );
    const [bucket] = Array.isArray(object(counted.data).buckets) ? (object(counted.data).buckets as unknown[]) : [];
    // The count is the one value in the bucket's computes.
    const [value] = Object.values(object(object(bucket).computes));
    return Number.isFinite(Number(value)) ? Number(value) : undefined;
  }

  /** The services with the most logs in a window, to choose one to search or tail. */
  async services(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ name: string; count: number }[]> {
    const answer = await this.request(
      'POST',
      '/api/v2/logs/analytics/aggregate',
      {
        compute: [{ aggregation: 'count', type: 'total' }],
        filter: this.filter('*', fromMs, toMs),
        group_by: [{ facet: 'service', limit: 100, sort: { aggregation: 'count', order: 'desc', type: 'measure' } }],
      },
      signal,
    );
    const buckets = object(answer.data).buckets;
    return (Array.isArray(buckets) ? buckets : [])
      .map((bucket) => {
        const name = object(object(bucket).by).service;
        const [count] = Object.values(object(object(bucket).computes));
        return { name: typeof name === 'string' ? name : '', count: Number(count) || 0 };
      })
      .filter((service) => service.name)
      .sort((a, b) => b.count - a.count);
  }

  /** A metric query in Datadog syntax, such as `avg:trace.http.request.duration{service:checkout} by {env}`. */
  async queryMetrics(query: string, fromMs: number, toMs: number, signal?: AbortSignal): Promise<MetricResult> {
    const started = Date.now();
    const params = new URLSearchParams({
      from: String(Math.floor(fromMs / 1000)),
      to: String(Math.ceil(toMs / 1000)),
      query,
    });
    const response = await this.request('GET', `/api/v1/query?${params}`, undefined, signal);
    if (response.status === 'error')
      throw new Error(`Datadog could not run the query: ${String(response.error ?? 'error')}`);
    return { series: boundSeries(datadogSeries(response)), statement: query, elapsedMs: Date.now() - started };
  }

  /** Metrics that reported in the last day, filtered by name. */
  async listMetrics(search: string, signal?: AbortSignal): Promise<string[]> {
    const from = Math.floor(Date.now() / 1000) - 86400;
    const response = await this.request('GET', `/api/v1/metrics?from=${from}`, undefined, signal);
    const names = Array.isArray(response.metrics) ? response.metrics.map(String) : [];
    const term = search.toLowerCase();
    return names.filter((name) => name.toLowerCase().includes(term)).slice(0, 200);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
