import { createHash } from 'node:crypto';
import {
  openSearchService,
  type ColumnInfo,
  type ElasticConnection,
  type LogTableMapping,
} from '../../core/connections';
import { buildElasticQuery, serviceField } from '../../core/elastic-query';
import { profileRegion, resolveCredentials, signRequest, type AwsCredentials } from './aws-auth';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';
import { readPages } from './paging';
import { LogFields } from './record';
import type { Connector, FetchRequest, FetchResult, RemoteRecord } from './types';

// A page of hits; search_after reads past the 10,000 a search can page through with from and size.
const PAGE = 5000;
// A first page this small comes back sooner, to show while the rest is read.
const FIRST_PAGE = 200;
// The fields of an index are read again after this long, so new fields can be searched.
const FIELDS_MS = 5 * 60000;
// Credentials are read again after this long, so a profile's new SSO session or keys are used.
const CREDENTIALS_MS = 10 * 60000;
const ROLES = ['timestamp', 'level', 'message', 'service', 'traceId'] as const;

/** A value at a dotted path of a document, such as `log.level`, or a field named with dots. */
function at(source: Json, path: string): unknown {
  if (Object.hasOwn(source, path)) return source[path];
  let value: unknown = source;
  for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Json)[part] : undefined;
  return value;
}

/** A document's fields by their dotted names, as `_field_caps` names them, for the form's preview. */
function flatten(value: unknown, prefix = '', into: Json = {}): Json {
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [name, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${name}` : name, into);
  else if (prefix) into[prefix] = value;
  return into;
}

/**
 * One hit as a JSON log line: the fields the mapping names as the event's
 * time, level, message, service, and trace id, then the rest of the document.
 * This runs for every fetched log.
 */
export function elasticLine(item: unknown, mapping: LogTableMapping): RemoteRecord {
  const hit = object(item);
  const source = object(hit._source);
  const mapped = new Set<string>();
  for (const role of ROLES) if (mapping[role]) mapped.add(role);
  const fields = new LogFields(mapped);
  for (const role of ROLES) {
    const path = mapping[role];
    if (!path) continue;
    const value = at(source, path);
    if (role === 'message') fields.message(value);
    else fields.put(role, value);
  }
  for (const name in source) {
    if (!Object.hasOwn(source, name)) continue;
    // A field the mapping already took as one of the event's own is not repeated.
    if (mapped.has(name) && mapping[name as (typeof ROLES)[number]] === name) continue;
    fields.attribute(name, source[name]);
  }
  fields.put('elasticsearch.index', hit._index);
  // The id keeps two documents of the same text and time apart, as a tail tells new lines from shown ones.
  fields.put('elasticsearch.id', hit._id);
  return fields.record(at(source, mapping.timestamp));
}

function problem(status: number, headers: Headers, body: Json | undefined, text: string): Error {
  const error = object(body?.error);
  const cause = object((Array.isArray(error.root_cause) ? error.root_cause : [])[0]);
  const type = String(cause.type ?? error.type ?? '');
  const reason = String(cause.reason ?? error.reason ?? body?.message ?? text.slice(0, 300));
  if (status === 401 || status === 403)
    return new Error(
      `The cluster refused the request (${status}${reason ? `: ${reason}` : ''}). Searches need the read privilege on the index.`,
    );
  if (status === 429) {
    const seconds = Number(headers.get('retry-after'));
    return retryAfter(`The cluster is busy: ${reason}`, (seconds > 0 ? seconds : 5) * 1000);
  }
  if (type === 'index_not_found_exception')
    return new Error(`No index matches ${String(cause['resource.id'] ?? cause.index ?? '')}.`);
  return new Error(`The cluster answered ${status}${type ? ` ${type}` : ''}: ${reason}`);
}

/**
 * Searches an Elasticsearch or OpenSearch index pattern with the Query DSL. A
 * search becomes a query by the types of the fields it names; terms a query
 * cannot express are applied to the fetched logs. Only reads: the root, the
 * indices and their fields, and searches.
 */
export class ElasticConnector implements Connector {
  /** Documents become searchable within a refresh, a second by default. */
  readonly tailLagMs = 5000;
  private fields?: { table: string; value: Promise<ColumnInfo[]>; at: number };
  private credentials?: { value: Promise<AwsCredentials>; at: number };
  private readonly fetcher: Fetch;
  private readonly credentialsOf: (profile: string | undefined, signal?: AbortSignal) => Promise<AwsCredentials>;
  private readonly now: () => number;

  constructor(
    readonly connection: ElasticConnection,
    /** The password, or an API key without a user, kept in secret storage. */
    private readonly secret: string | undefined,
    private readonly timeoutMs: () => number,
    options: {
      fetcher?: Fetch;
      credentials?: (profile: string | undefined, signal?: AbortSignal) => Promise<AwsCredentials>;
      now?: () => number;
    } = {},
  ) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.credentialsOf = options.credentials ?? ((profile, signal) => resolveCredentials(profile, undefined, signal));
    this.now = options.now ?? Date.now;
  }

  private signer(signal?: AbortSignal): Promise<AwsCredentials> {
    if (!this.credentials || this.now() - this.credentials.at > CREDENTIALS_MS) {
      const value = this.credentialsOf(this.connection.auth?.profile, signal);
      this.credentials = { value, at: this.now() };
      value.catch(() => (this.credentials = undefined));
    }
    return this.credentials.value;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<Json> {
    const url = `${this.connection.url}${path}`;
    const text = body === undefined ? '' : JSON.stringify(body);
    let headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
    const auth = this.connection.auth;
    if (auth) {
      const service = openSearchService(this.connection.url);
      const region = auth.region ?? service.region ?? profileRegion(auth.profile);
      if (!region)
        throw new Error(
          `The region of ${new URL(url).host} is not in its name: set "region" in the connection's "auth".`,
        );
      // OpenSearch Serverless also checks the body's hash.
      if (service.service === 'aoss') headers['x-amz-content-sha256'] = createHash('sha256').update(text).digest('hex');
      headers = signRequest({
        method,
        url,
        headers,
        body: text,
        region,
        service: service.service,
        credentials: await this.signer(signal),
        now: this.now(),
      });
    } else if (this.connection.user)
      headers.authorization = `Basic ${Buffer.from(`${this.connection.user}:${this.secret ?? ''}`).toString('base64')}`;
    else if (this.secret) headers.authorization = `ApiKey ${this.secret}`;
    const answer = await requestJson({
      service: `the cluster at ${this.connection.url}`,
      url,
      method,
      headers,
      ...(body === undefined ? {} : { body: text }),
      timeoutMs: this.timeoutMs(),
      signal,
      fetcher: this.fetcher,
    });
    if (!answer.ok) throw problem(answer.status, answer.headers, answer.json, answer.text);
    if (!answer.json) throw new Error('The cluster returned a response that is not JSON.');
    return answer.json;
  }

  async test(): Promise<string> {
    const host = new URL(this.connection.url).host;
    // OpenSearch Serverless has no root to read; listing indices checks the connection there.
    if (openSearchService(this.connection.url).service === 'aoss') {
      const indices = await this.tables();
      return `OpenSearch Serverless · ${indices.length} indices at ${host}`;
    }
    // A user who may read logs may not be allowed the cluster's name and version; listing indices checks them.
    let root: Json;
    try {
      root = await this.request('GET', '/');
    } catch (error) {
      if (!/\(403/.test((error as Error).message)) throw error;
      return `Elasticsearch · ${(await this.tables()).length} indices at ${host}`;
    }
    const version = object(root.version);
    const name = version.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch';
    return `${name} ${String(version.number ?? '')} at ${host}`.replace('  ', ' ');
  }

  /** Data streams, index patterns that cover dated or numbered indices, then the indices themselves. */
  async tables(): Promise<string[]> {
    // Every index by name, with its aliases, which are searched like indices.
    const answer = await this.request('GET', '/_alias').catch((error: Error) => {
      if (/\(403/.test(error.message))
        error.message += ' Listing indices needs view_index_metadata on them, beside read.';
      throw error;
    });
    const aliases = Object.values(answer).flatMap((index) => Object.keys(object(object(index).aliases)));
    const names = [...Object.keys(answer), ...aliases].filter((name) => !name.startsWith('.')).sort();
    let streams: string[] = [];
    try {
      const answer = await this.request('GET', '/_data_stream');
      streams = (Array.isArray(answer.data_streams) ? answer.data_streams : []).map((stream) =>
        String(object(stream).name),
      );
    } catch {
      streams = [];
    }
    // `app-logs-2026.10.30` and `app-logs-000001` are read together as `app-logs-*`.
    const patterns = [
      ...new Set(
        names.flatMap((name) => {
          const match = /^(.+?[-_.])(?:\d{4}[.-]\d{2}[.-]\d{2}|\d{6})$/.exec(name);
          return match ? [`${match[1]}*`] : [];
        }),
      ),
    ];
    return [...new Set([...streams, ...patterns, ...names])];
  }

  /** The fields of an index pattern, by their dotted names, and each one's type. */
  async columns(table: string): Promise<ColumnInfo[]> {
    const answer = await this.request('GET', `/${encodeURIComponent(table)}/_field_caps?fields=*`);
    return Object.entries(object(answer.fields))
      .map(([name, types]) => ({ name, type: Object.keys(object(types))[0] ?? '' }))
      .filter((field) => !field.name.startsWith('_') && !['object', 'nested', 'unmapped'].includes(field.type))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The newest documents of an index pattern, by their dotted field names, for the form's preview. */
  async sample(table: string, limit = 5): Promise<Record<string, unknown>[]> {
    const answer = await this.request('POST', `/${encodeURIComponent(table)}/_search`, { size: limit });
    const hits = object(answer.hits).hits;
    return (Array.isArray(hits) ? hits : []).map((hit) => flatten(object(hit)._source));
  }

  private mapping(): LogTableMapping {
    const mapping = this.connection.logs;
    if (!mapping) throw new Error('Choose the log index pattern and its time field: Edit the connection.');
    return mapping;
  }

  /** The mapped index pattern's fields, read again now and then. */
  private fieldsOf(table: string): Promise<ColumnInfo[]> {
    if (!this.fields || this.fields.table !== table || this.now() - this.fields.at > FIELDS_MS) {
      const value = this.columns(table);
      this.fields = { table, value, at: this.now() };
      value.catch(() => (this.fields = undefined));
    }
    return this.fields.value;
  }

  async preview(query: string, fromMs?: number, toMs?: number): Promise<{ statement: string; local: string[] }> {
    const mapping = this.mapping();
    const built = buildElasticQuery({ mapping, fields: await this.fieldsOf(mapping.table), query, fromMs, toMs });
    return { statement: JSON.stringify(built.statement), local: built.local };
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = this.now();
    const mapping = this.mapping();
    const toMs = request.toMs ?? started;
    const fromMs = request.fromMs ?? toMs - 900000;
    const built = buildElasticQuery({
      mapping,
      fields: await this.fieldsOf(mapping.table),
      query: request.query,
      ...(request.native !== undefined ? { native: request.native } : {}),
      fromMs,
      toMs,
    });
    const order = request.order === 'desc' ? 'desc' : 'asc';
    let total: number | undefined;
    // Hits that meet at a page's edge with the same time can come again; each document is kept once.
    const seen = new Set<string>();
    const records = await readPages<unknown[]>({
      limit: request.limit,
      pageSize: PAGE,
      firstPageSize: FIRST_PAGE,
      ...(request.firstPage ? { firstPage: request.firstPage } : {}),
      fetchPage: async (size, cursor) => {
        const answer = await this.request(
          'POST',
          `/${encodeURIComponent(mapping.table)}/_search`,
          {
            size,
            query: built.query,
            sort: [{ [mapping.timestamp]: { order, unmapped_type: 'date' } }, { _doc: order }],
            ...(cursor ? { search_after: cursor } : {}),
            ...(request.countTotal && !cursor ? { track_total_hits: true } : { track_total_hits: false }),
          },
          signal,
        );
        const hits = object(answer.hits);
        if (!cursor && request.countTotal) {
          const counted = object(hits.total).value;
          if (typeof counted === 'number') total = counted;
        }
        const list = Array.isArray(hits.hits) ? hits.hits : [];
        const page: RemoteRecord[] = [];
        for (const hit of list) {
          const key = `${String(object(hit)._index)}\n${String(object(hit)._id)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          page.push(elasticLine(hit, mapping));
        }
        const last = object(list.at(-1)).sort;
        return { records: page, ...(list.length >= size && Array.isArray(last) ? { next: last } : {}) };
      },
    });
    return {
      records,
      ...(total !== undefined && total > records.length ? { total } : {}),
      pushed: built.pushed,
      local: built.local,
      statement: JSON.stringify(built.statement),
      elapsedMs: this.now() - started,
    };
  }

  /** The services with the most documents in a window, from the mapped service field's values. */
  async services(fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ name: string; count: number }[]> {
    const mapping = this.mapping();
    const field = serviceField(mapping, await this.fieldsOf(mapping.table));
    if (!field) return [];
    const answer = await this.request(
      'POST',
      `/${encodeURIComponent(mapping.table)}/_search`,
      {
        size: 0,
        query: buildElasticQuery({ mapping, fields: [], query: '', fromMs, toMs }).query,
        aggs: { services: { terms: { field, size: 100 } } },
      },
      signal,
    );
    const buckets = object(object(answer.aggregations).services).buckets;
    return (Array.isArray(buckets) ? buckets : []).map((bucket) => ({
      name: String(object(bucket).key),
      count: Number(object(bucket).doc_count) || 0,
    }));
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
