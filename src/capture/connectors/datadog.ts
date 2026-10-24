import { datadogApiBase, type DatadogConnection } from '../../core/connections';
import { datadogQuery } from '../../core/datadog-query';
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

const PAGE = 1000;
// Fields every Logline event has; a log attribute with one of these names keeps its value under `attributes.`.
const RESERVED = new Set(['timestamp', 'level', 'message', 'service', 'host', 'traceId', 'tags', 'datadog.id']);

const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

/** One log from the Logs Search API as a JSON log line. */
export function datadogLine(item: unknown): RemoteRecord {
  const log = object(item);
  const attributes = object(log.attributes);
  const custom = object(attributes.attributes);
  const { trace_id: ddTraceId, ...dd } = object(custom.dd);
  const traceId = ddTraceId ?? custom.trace_id ?? custom.traceId;
  const entries: [string, unknown][] = [
    ['timestamp', attributes.timestamp],
    ['level', attributes.status],
    ['message', attributes.message],
    ['service', attributes.service],
    ['host', attributes.host],
    ...(traceId !== undefined ? ([['traceId', String(traceId)]] as [string, unknown][]) : []),
  ];
  for (const [name, value] of Object.entries(custom)) {
    // The trace id is already the event's traceId; keep the rest of `dd`, such as its span id.
    if (name === 'dd' && ddTraceId !== undefined) {
      if (Object.keys(dd).length) entries.push(['dd', dd]);
      continue;
    }
    entries.push([RESERVED.has(name) ? `attributes.${name}` : name, value]);
  }
  if (Array.isArray(attributes.tags) && attributes.tags.length) entries.push(['tags', attributes.tags.join(',')]);
  if (typeof log.id === 'string') entries.push(['datadog.id', log.id]);
  const time = typeof attributes.timestamp === 'string' ? Date.parse(attributes.timestamp) : NaN;
  return {
    line: JSON.stringify(Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== null))),
    ...(Number.isFinite(time) ? { timeMs: time } : {}),
  };
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
  /** Datadog limits how often an organization can search logs; tails read at most every 15 s. */
  readonly tailPollMs = 15000;
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
    if (!response.ok) throw problem(response.status, response.headers, json, text, !!this.keys.token);
    if (!json) throw new Error('Datadog returned a response that is not JSON.');
    return json;
  }

  async test(): Promise<string> {
    // A search of one log checks the keys and the permission to read logs together.
    const now = Date.now();
    await this.request('POST', '/api/v2/logs/events/search', {
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
    const records: RemoteRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request(
        'POST',
        '/api/v2/logs/events/search',
        {
          filter,
          sort: request.order === 'desc' ? '-timestamp' : 'timestamp',
          page: { limit: Math.min(PAGE, request.limit - records.length), ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      const data = Array.isArray(page.data) ? page.data : [];
      records.push(...data.map(datadogLine));
      const after = object(object(page.meta).page).after;
      cursor = typeof after === 'string' && after && data.length ? after : undefined;
    } while (cursor && records.length < request.limit);
    let total: number | undefined;
    if (request.countTotal && records.length >= request.limit) {
      const counted = await this.request(
        'POST',
        '/api/v2/logs/analytics/aggregate',
        { compute: [{ aggregation: 'count', type: 'total' }], filter },
        signal,
      );
      const [bucket] = Array.isArray(object(counted.data).buckets) ? (object(counted.data).buckets as unknown[]) : [];
      // The count is the one value in the bucket's computes.
      const [value] = Object.values(object(object(bucket).computes));
      if (Number.isFinite(Number(value))) total = Number(value);
    }
    return {
      records,
      ...(total !== undefined ? { total } : {}),
      pushed: translated.pushed,
      local: translated.local,
      statement: translated.query,
      elapsedMs: Date.now() - started,
    };
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
