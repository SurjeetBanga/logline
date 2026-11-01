import type { GcpConnection } from '../../core/connections';
import { gcpFilter, gcpQuery } from '../../core/gcp-query';
import { googleToken, type GoogleToken } from './gcp-auth';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';
import { readPages } from './paging';
import { LogFields } from './record';
import type { Connector, FetchRequest, FetchResult, RemoteRecord } from './types';

// The most entries entries.list returns in one page.
const PAGE = 1000;
// A first page this small comes back sooner, to show while the rest is read.
const FIRST_PAGE = 200;
// entries.list may answer a part of a search with no entries; it is read on this far.
const MAX_EMPTY_PAGES = 20;
const API = 'https://logging.googleapis.com';
const SERVICE_FIELD = 'resource.labels.service_name';
// Fields every Logline event has; a payload field of the same name is kept apart.
const OWN = new Set(['timestamp', 'level', 'message', 'service', 'traceId', 'spanId', 'status', 'durationMs']);
/** Cloud Logging's severities as Logline's levels. */
const LEVELS: Record<string, string> = {
  DEFAULT: 'info',
  DEBUG: 'debug',
  INFO: 'info',
  NOTICE: 'info',
  WARNING: 'warn',
  ERROR: 'error',
  CRITICAL: 'fatal',
  ALERT: 'fatal',
  EMERGENCY: 'fatal',
};

/** A value at a dotted path of an entry, such as `resource.labels.service_name`. */
function at(entry: Json, path: string): unknown {
  let value: unknown = entry;
  for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Json)[part] : undefined;
  return value;
}

/**
 * One log entry as a JSON log line: its severity, payload, resource, labels,
 * trace, and HTTP request, with the fields of a JSON payload beside the
 * entry's own. This runs for every fetched log.
 */
export function gcpLine(item: unknown, serviceField = SERVICE_FIELD): RemoteRecord {
  const entry = object(item);
  const payload = object(entry.jsonPayload);
  const resource = object(entry.resource);
  const labels = object(resource.labels);
  const request = object(entry.httpRequest);
  const fields = new LogFields(OWN);
  fields.put('timestamp', entry.timestamp);
  const severity = typeof entry.severity === 'string' ? entry.severity : 'DEFAULT';
  // A payload that names its own level is believed over the default severity.
  fields.put(
    'level',
    severity === 'DEFAULT' && payload.level !== undefined ? payload.level : (LEVELS[severity] ?? severity),
  );
  fields.message(typeof entry.textPayload === 'string' ? entry.textPayload : (payload.message ?? payload.msg));
  fields.put(
    'service',
    at(entry, serviceField) ??
      labels.service_name ??
      labels.container_name ??
      labels.function_name ??
      labels.module_id ??
      payload.service,
  );
  // `projects/<project>/traces/<id>` is the trace's id.
  if (typeof entry.trace === 'string') fields.put('traceId', entry.trace.replace(/^.*\/traces\//, ''));
  fields.put('spanId', entry.spanId);
  fields.put('status', request.status);
  // A latency such as `0.250s`.
  if (typeof request.latency === 'string' && /^\d+(?:\.\d+)?s$/.test(request.latency))
    fields.put('durationMs', Math.round(Number(request.latency.slice(0, -1)) * 1000 * 1000) / 1000);
  for (const name in payload)
    if (Object.hasOwn(payload, name) && name !== 'message' && name !== 'msg' && name !== 'level')
      fields.attribute(name, payload[name]);
  if (Object.keys(request).length) fields.put('httpRequest', request);
  if (resource.type !== undefined) fields.put('resource', resource);
  fields.put('labels', entry.labels);
  fields.put('protoPayload', entry.protoPayload);
  fields.put('gcp.logName', entry.logName);
  // The id keeps two entries of the same text and time apart, as a tail tells new lines from shown ones.
  fields.put('gcp.insertId', entry.insertId);
  return fields.record(typeof entry.timestamp === 'string' ? entry.timestamp : undefined);
}

function problem(status: number, headers: Headers, body: Json | undefined, text: string, project: string): Error {
  const error = object(body?.error);
  const reason = String(error.message ?? text.slice(0, 300));
  if (status === 429 || error.status === 'RESOURCE_EXHAUSTED') {
    const seconds = Number(headers.get('retry-after'));
    // Reading logs is limited to 60 requests a minute for a project.
    return retryAfter(
      `Cloud Logging's read quota for ${project} was reached: ${reason}`,
      (seconds > 0 ? seconds : 15) * 1000,
    );
  }
  if (status === 401)
    return Object.assign(new Error(`Google did not accept the credentials: ${reason}`), { expired: true });
  if (status === 403)
    return new Error(
      `Google refused to read the logs of ${project} (${reason}). Reading them needs the Logs Viewer role (roles/logging.viewer).`,
    );
  if (status === 400) return new Error(`Cloud Logging could not run the query: ${reason}`);
  return new Error(`Cloud Logging answered ${status}: ${reason}`);
}

/**
 * Searches the logs of a Google Cloud project with entries.list. A search
 * becomes the Logging query language; terms it cannot express are applied to
 * the fetched logs.
 */
export class GcpConnector implements Connector {
  /** Entries are usually readable within seconds of their time. */
  readonly tailLagMs = 10000;
  /** Reading logs is limited to 60 requests a minute for a project, shared with the console and others. */
  readonly tailPollMs = 5000;
  readonly base: string;
  private token?: Promise<GoogleToken>;
  private readonly fetcher: Fetch;
  private readonly tokenOf: (signal?: AbortSignal) => Promise<GoogleToken>;
  private readonly now: () => number;

  constructor(
    readonly connection: GcpConnection,
    private readonly timeoutMs: () => number,
    options: { fetcher?: Fetch; token?: (signal?: AbortSignal) => Promise<GoogleToken>; now?: () => number } = {},
  ) {
    this.base = connection.endpoint ?? API;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.tokenOf = options.token ?? ((signal) => googleToken(undefined, signal));
    this.now = options.now ?? Date.now;
  }

  private async credentials(signal?: AbortSignal): Promise<GoogleToken> {
    const current = this.token && (await this.token.catch(() => undefined));
    // A token is asked for again a minute before it stops working.
    if (!current || current.expiresAtMs - 60000 <= this.now()) {
      this.token = this.tokenOf(signal);
      this.token.catch(() => (this.token = undefined));
    }
    return this.token!;
  }

  private async list(payload: Json, signal?: AbortSignal, retried = false): Promise<Json> {
    const token = await this.credentials(signal);
    const answer = await requestJson({
      service: 'Cloud Logging',
      url: `${this.base}/v2/entries:list`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.token}`,
        ...(token.quotaProject ? { 'x-goog-user-project': token.quotaProject } : {}),
      },
      body: { resourceNames: [`projects/${this.connection.project}`], ...payload },
      timeoutMs: this.timeoutMs(),
      signal,
      fetcher: this.fetcher,
    });
    if (!answer.ok) {
      const error = problem(answer.status, answer.headers, answer.json, answer.text, this.connection.project);
      // A token that stopped working early is asked for again, once.
      if ((error as { expired?: boolean }).expired && !retried) {
        this.token = undefined;
        return this.list(payload, signal, true);
      }
      throw error;
    }
    if (!answer.json) throw new Error('Cloud Logging returned a response that is not JSON.');
    return answer.json;
  }

  async test(): Promise<string> {
    const toMs = this.now();
    await this.list({
      filter: gcpFilter({ base: this.connection.filter, fromMs: toMs - 3600000, toMs, query: '' }),
      orderBy: 'timestamp desc',
      pageSize: 1,
    });
    return `Cloud Logging · ${this.connection.project} readable`;
  }

  async preview(query: string): Promise<{ statement: string; local: string[] }> {
    const translated = gcpQuery(query, this.connection.serviceField);
    return { statement: translated.filter, local: translated.local };
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = this.now();
    const translated =
      request.native !== undefined
        ? { filter: request.native.trim() === '*' ? '' : request.native.trim(), pushed: [], local: [] }
        : gcpQuery(request.query, this.connection.serviceField);
    const toMs = request.toMs ?? started;
    const fromMs = request.fromMs ?? toMs - 900000;
    const filter = gcpFilter({ base: this.connection.filter, fromMs, toMs, query: translated.filter });
    const records = await readPages<string>({
      limit: request.limit,
      pageSize: PAGE,
      firstPageSize: FIRST_PAGE,
      emptyPages: { maxPages: MAX_EMPTY_PAGES },
      ...(request.firstPage ? { firstPage: request.firstPage } : {}),
      fetchPage: async (size, cursor) => {
        const page = await this.list(
          {
            filter,
            orderBy: request.order === 'desc' ? 'timestamp desc' : 'timestamp asc',
            pageSize: size,
            ...(cursor ? { pageToken: cursor } : {}),
          },
          signal,
        );
        const entries = Array.isArray(page.entries) ? page.entries : [];
        const next = page.nextPageToken;
        return {
          records: entries.map((entry) => gcpLine(entry, this.connection.serviceField)),
          ...(typeof next === 'string' && next ? { next } : {}),
        };
      },
    });
    return {
      records,
      pushed: translated.pushed,
      local: translated.local,
      statement: translated.filter,
      elapsedMs: this.now() - started,
    };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
