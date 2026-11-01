import { cloudwatchEndpoint, type CloudWatchConnection } from '../../core/connections';
import { cloudwatchQuery } from '../../core/cloudwatch-query';
import { resolveCredentials, signRequest, type AwsCredentials } from './aws-auth';
import { object, requestJson, retryAfter, type Fetch, type Json } from './http';
import { readPages } from './paging';
import { LogFields } from './record';
import type { Connector, FetchRequest, FetchResult, RemoteRecord } from './types';

// The most events FilterLogEvents returns in one page.
const PAGE = 10000;
// A search reads at most this many log groups at once: FilterLogEvents allows 5 requests a second for an
// account in a region, a limit AWS does not raise.
const PARALLEL = 2;
// A request over that rate is sent again after these waits before the search gives up.
const THROTTLE_RETRY_MS = [500, 1000, 2000];
// FilterLogEvents searches a log group in parts and may answer a part with no events; it is read on this far.
const MAX_EMPTY_PAGES = 200;
// The most events one window of a search reads from a group; a busier window is read again, shorter.
const WINDOW_CAP = 50000;
// Credentials are read again after this long, so a profile's new SSO session or keys are used.
const CREDENTIALS_MS = 10 * 60000;
// Fields every Logline event has; set from the event when its message does not have them.
const OWN = new Set(['timestamp', 'message', 'service']);

/** An event as FilterLogEvents returns it. */
interface CloudWatchEvent {
  timestamp?: number;
  message?: string;
  logStreamName?: string;
  eventId?: string;
}

/** The service a log group belongs to, by its name: `/aws/lambda/checkout` is `checkout`. */
export function cloudwatchService(group: string): string {
  const name = group.replace(/^arn:[^:]*:logs:[^:]*:\d+:log-group:/, '');
  const parts = name.split('/').filter(Boolean);
  // `/aws/lambda/name`, `/aws/ecs/cluster/name`, `/ecs/name`: the last part names the service.
  return parts.at(-1) ?? name;
}

/**
 * One event as a JSON log line. A JSON message is the log itself, with the
 * event's time, group, stream, and id beside its fields; any other message is
 * its text. This runs for every fetched log.
 */
export function cloudwatchLine(item: unknown, group: string): RemoteRecord {
  const event = item as CloudWatchEvent;
  const fields = new LogFields(OWN);
  const message = typeof event.message === 'string' ? event.message.replace(/\r?\n$/, '') : '';
  let parsed: Json | undefined;
  if (message.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(message);
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Json;
    } catch {
      parsed = undefined;
    }
  }
  const time = typeof event.timestamp === 'number' ? event.timestamp : undefined;
  if (parsed) {
    if (parsed.timestamp === undefined && time !== undefined) fields.put('timestamp', new Date(time).toISOString());
    for (const name in parsed) if (Object.hasOwn(parsed, name)) fields.put(name, parsed[name]);
    if (parsed.service === undefined) fields.put('service', cloudwatchService(group));
  } else {
    if (time !== undefined) fields.put('timestamp', new Date(time).toISOString());
    fields.message(message);
    fields.put('service', cloudwatchService(group));
  }
  fields.put('cloudwatch.logGroup', group);
  fields.put('cloudwatch.logStream', event.logStreamName);
  // The id keeps two events with the same text and time apart, as a tail tells new lines from shown ones.
  fields.put('cloudwatch.eventId', event.eventId);
  return fields.record(time);
}

function problem(status: number, body: Json | undefined, text: string, region: string): Error {
  const type = String(body?.__type ?? '').replace(/^.*#/, '');
  const detail = String(body?.message ?? body?.Message ?? text.slice(0, 300));
  if (type === 'ThrottlingException' || status === 429)
    return retryAfter(`CloudWatch's request rate for the account was reached: ${detail}`, 5000);
  if (type === 'AccessDeniedException' || status === 403)
    return new Error(
      `AWS refused the request (${type || status}: ${detail}). Searches need logs:FilterLogEvents and logs:DescribeLogGroups.`,
    );
  if (type === 'ResourceNotFoundException') return new Error(`CloudWatch in ${region}: ${detail}`);
  if (/ExpiredToken|UnrecognizedClient|InvalidSignature/.test(type))
    return Object.assign(new Error(`AWS did not accept the credentials (${type}: ${detail})`), { expired: true });
  return new Error(`CloudWatch answered ${status}${type ? ` ${type}` : ''}: ${detail}`);
}

/** Whether the earlier of two events comes first: by time, then by id. */
const newerFirst = (a: RemoteRecord & { id: string }, b: RemoteRecord & { id: string }) =>
  (b.timeMs ?? 0) - (a.timeMs ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Searches the log groups of a CloudWatch Logs connection with FilterLogEvents,
 * not Logs Insights, which charges for the data each query scans. A search
 * becomes a filter pattern; terms a pattern cannot express are applied to the
 * fetched logs.
 */
export class CloudWatchConnector implements Connector {
  /** Logs usually become searchable within seconds of their own time. */
  readonly tailLagMs = 15000;
  readonly base: string;
  private credentials?: { value: Promise<AwsCredentials>; at: number };

  private readonly fetcher: Fetch;
  private readonly credentialsOf: (profile: string | undefined, signal?: AbortSignal) => Promise<AwsCredentials>;
  private readonly now: () => number;
  private readonly retryMs: number[];

  constructor(
    readonly connection: CloudWatchConnection,
    private readonly timeoutMs: () => number,
    options: {
      fetcher?: Fetch;
      credentials?: (profile: string | undefined, signal?: AbortSignal) => Promise<AwsCredentials>;
      now?: () => number;
      /** The waits before a throttled request is sent again. */
      retryMs?: number[];
    } = {},
  ) {
    this.base = cloudwatchEndpoint(connection);
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.credentialsOf = options.credentials ?? ((profile, signal) => resolveCredentials(profile, undefined, signal));
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? THROTTLE_RETRY_MS;
  }

  /** Each read of a tail asks once per log group, so groups share the account's request rate. */
  get tailPollMs(): number {
    return Math.max(5000, 1000 * this.connection.logGroups.length);
  }

  private signer(signal?: AbortSignal): Promise<AwsCredentials> {
    if (!this.credentials || this.now() - this.credentials.at > CREDENTIALS_MS) {
      const value = this.credentialsOf(this.connection.profile, signal);
      this.credentials = { value, at: this.now() };
      // A failure is not kept: the next request reads the credentials again.
      value.catch(() => (this.credentials = undefined));
    }
    return this.credentials.value;
  }

  private async request(
    action: string,
    payload: Json,
    signal?: AbortSignal,
    retried = false,
    throttled = 0,
  ): Promise<Json> {
    const body = JSON.stringify(payload);
    const headers = signRequest({
      method: 'POST',
      url: `${this.base}/`,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Logs_20140328.${action}` },
      body,
      region: this.connection.region,
      service: 'logs',
      credentials: await this.signer(signal),
      now: this.now(),
    });
    const answer = await requestJson({
      service: `CloudWatch at ${this.base}`,
      url: `${this.base}/`,
      method: 'POST',
      headers,
      body,
      timeoutMs: this.timeoutMs(),
      signal,
      fetcher: this.fetcher,
    });
    if (!answer.ok) {
      const error = problem(answer.status, answer.json, answer.text, this.connection.region);
      // A burst of requests over the account's rate waits a little and goes again.
      const wait = this.retryMs[throttled];
      if ((error as { retryAfterMs?: number }).retryAfterMs !== undefined && wait !== undefined && !signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        return this.request(action, payload, signal, retried, throttled + 1);
      }
      // Credentials that expired since they were read are read again, once.
      if ((error as { expired?: boolean }).expired && !retried) {
        this.credentials = undefined;
        return this.request(action, payload, signal, true);
      }
      if ((error as { expired?: boolean }).expired && this.connection.profile)
        error.message += ` If the profile signs in with SSO, run "aws sso login --profile ${this.connection.profile}".`;
      throw error;
    }
    if (!answer.json) throw new Error('CloudWatch returned a response that is not JSON.');
    return answer.json;
  }

  /** Log groups whose names start with `prefix`, for checking and suggesting names. */
  async listLogGroups(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const answer = await this.request(
      'DescribeLogGroups',
      { ...(prefix ? { logGroupNamePrefix: prefix } : {}), limit: 50 },
      signal,
    );
    const groups = Array.isArray(answer.logGroups) ? answer.logGroups : [];
    return groups.map((group) => String(object(group).logGroupName ?? '')).filter(Boolean);
  }

  async test(): Promise<string> {
    for (const group of this.connection.logGroups) {
      if (group.startsWith('arn:')) continue;
      const found = await this.listLogGroups(group);
      if (found.includes(group)) continue;
      // Suggest the groups that share the name's first part, such as other /aws/lambda/ groups.
      const near = await this.listLogGroups(group.slice(0, group.indexOf('/', 1) + 1 || group.length)).catch(
        () => [] as string[],
      );
      const hint = near.length ? ` Log groups like it: ${near.slice(0, 5).join(', ')}.` : '';
      throw new Error(`There is no log group ${group} in ${this.connection.region}.${hint}`);
    }
    // Reading one event checks the permission to search, which describing groups does not need.
    const toMs = this.now();
    await this.request('FilterLogEvents', {
      logGroupIdentifier: this.connection.logGroups[0],
      startTime: toMs - 900000,
      endTime: toMs,
      limit: 1,
    });
    const count = this.connection.logGroups.length;
    return `CloudWatch · ${count} log group${count === 1 ? '' : 's'} readable in ${this.connection.region}`;
  }

  async preview(query: string): Promise<{ statement: string; local: string[] }> {
    const translated = cloudwatchQuery(query);
    return { statement: translated.pattern, local: translated.local };
  }

  /** The configured groups a search reads: those of the services it names, else all. */
  private groupsFor(services: string[] | undefined): string[] {
    if (!services) return this.connection.logGroups;
    const patterns = services.map(
      (service) =>
        new RegExp(
          `^${service
            .toLowerCase()
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')}$`,
        ),
    );
    return this.connection.logGroups.filter((group) =>
      patterns.every((pattern) => pattern.test(cloudwatchService(group).toLowerCase())),
    );
  }

  /** Every event of one group in a window, oldest first, or the first `limit` of them. */
  private async read(
    group: string,
    pattern: string,
    fromMs: number,
    toMs: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<(RemoteRecord & { id: string })[]> {
    const records = await readPages<string>({
      limit,
      pageSize: PAGE,
      firstPageSize: PAGE,
      emptyPages: { maxPages: MAX_EMPTY_PAGES },
      fetchPage: async (size, cursor) => {
        const page = await this.request(
          'FilterLogEvents',
          {
            logGroupIdentifier: group,
            startTime: Math.floor(fromMs),
            endTime: Math.floor(toMs),
            limit: size,
            ...(pattern ? { filterPattern: pattern } : {}),
            ...(cursor ? { nextToken: cursor } : {}),
          },
          signal,
        );
        const events = Array.isArray(page.events) ? page.events : [];
        const records = events.map((event) =>
          Object.assign(cloudwatchLine(event, group), { id: `${group}\n${String(object(event).eventId ?? '')}` }),
        );
        const next = page.nextToken;
        return { records, ...(typeof next === 'string' && next ? { next } : {}) };
      },
    });
    return records as (RemoteRecord & { id: string })[];
  }

  /** Read each group, at most PARALLEL at once. */
  private async each<T>(groups: string[], read: (group: string) => Promise<T[]>): Promise<T[]> {
    const results: T[][] = [];
    for (let index = 0; index < groups.length; index += PARALLEL)
      results.push(...(await Promise.all(groups.slice(index, index + PARALLEL).map(read))));
    return results.flat();
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = this.now();
    const translated =
      request.native !== undefined
        ? { pattern: request.native.trim() === '*' ? '' : request.native, pushed: [], local: [] }
        : cloudwatchQuery(request.query);
    const groups = this.groupsFor(request.native === undefined ? cloudwatchQuery(request.query).services : undefined);
    const toMs = request.toMs ?? started;
    const fromMs = request.fromMs ?? toMs - 900000;
    let records: (RemoteRecord & { id: string })[] = [];
    if (request.order === 'asc') {
      // A tail reads forward from where it was: each group's first logs, then the earliest of them all.
      records = (
        await this.each(groups, (group) => this.read(group, translated.pattern, fromMs, toMs, request.limit, signal))
      )
        .sort((a, b) => newerFirst(b, a))
        .slice(0, request.limit);
    } else {
      // FilterLogEvents reads oldest first, so the newest logs are found in windows from the end of the range,
      // each twice as long as the one after it, until the limit is reached.
      let end = toMs;
      let span = Math.max(1000, (toMs - fromMs) / 16);
      let first = true;
      while (records.length < request.limit && end >= fromMs) {
        const start = Math.max(fromMs, end - span);
        const reads = await this.each(groups, async (group) => [
          await this.read(group, translated.pattern, start, end, WINDOW_CAP, signal),
        ]);
        // A group that filled the cap was cut short of its newest logs: the window is read again, shorter.
        if (reads.some((read) => read.length >= WINDOW_CAP) && end - start > 1000) {
          span = Math.max(1000, span / 4);
          continue;
        }
        records.push(
          ...reads
            .flat()
            .sort(newerFirst)
            .slice(0, request.limit - records.length),
        );
        end = start - 1;
        span *= 2;
        // Only a first window with more of the range to read is worth showing early.
        if (first && request.firstPage && records.length && records.length < request.limit && end >= fromMs)
          request.firstPage([...records]);
        first = false;
      }
    }
    return {
      records: records.map(({ line, timeMs }) => (timeMs === undefined ? { line } : { line, timeMs })),
      pushed: translated.pushed,
      local: translated.local,
      statement: translated.pattern,
      elapsedMs: this.now() - started,
    };
  }

  /** The services of the configured log groups; CloudWatch has no free count of their logs. */
  async services(): Promise<{ name: string }[]> {
    return [...new Set(this.connection.logGroups.map(cloudwatchService))].map((name) => ({ name }));
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
