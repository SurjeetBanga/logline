import { startFakeHttp, type FakeAnswer, type FakeRequest } from './fake-http';

/** An event in a log group. */
export interface FakeEvent {
  group: string;
  timestamp: number;
  message: string;
  stream?: string;
  id: string;
}

export interface FakeCloudWatchOptions {
  events?: FakeEvent[];
  /** Log groups that exist without events. */
  groups?: string[];
  /** The access key id requests must be signed with. */
  accessKeyId?: string;
}

type Json = Record<string, unknown>;

// --- A part of CloudWatch's filter pattern syntax, enough to check what Logline sends. ---

function path(value: unknown, selector: string): unknown {
  let current = value;
  for (const part of selector.replace(/^\$\./, '').split('.'))
    current = current && typeof current === 'object' ? (current as Json)[part] : undefined;
  return current;
}

/** A JSON pattern's condition, read from `text` at `at`, as a function of the parsed message. */
function parseJson(text: string): (log: Json) => boolean {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? '')) at++;
  };
  const expression = (): ((log: Json) => boolean) => {
    let left = conjunction();
    space();
    while (text.startsWith('||', at)) {
      at += 2;
      const [a, b] = [left, conjunction()];
      left = (log) => a(log) || b(log);
      space();
    }
    return left;
  };
  const conjunction = (): ((log: Json) => boolean) => {
    let left = primary();
    space();
    while (text.startsWith('&&', at)) {
      at += 2;
      const [a, b] = [left, primary()];
      left = (log) => a(log) && b(log);
      space();
    }
    return left;
  };
  const primary = (): ((log: Json) => boolean) => {
    space();
    if (text[at] === '(') {
      at++;
      const inner = expression();
      space();
      at++; // )
      return inner;
    }
    const match = /^(\$\.[\w.]+)\s*(=|!=|>=|<=|>|<)\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)/.exec(text.slice(at));
    if (!match) throw new Error(`Invalid filter pattern at ${at}: ${text}`);
    at += match[0].length;
    const [, selector, operator, literal] = match;
    const value: unknown = JSON.parse(literal);
    return (log) => {
      const actual = path(log, selector);
      if (typeof value === 'number') {
        if (typeof actual !== 'number') return false;
        return {
          '=': actual === value,
          '!=': actual !== value,
          '>': actual > value,
          '>=': actual >= value,
          '<': actual < value,
          '<=': actual <= value,
        }[operator]!;
      }
      if (typeof actual !== 'string') return false;
      const source = String(value)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const equal = new RegExp(`^${source}$`, 's').test(actual);
      return operator === '!=' ? !equal : operator === '=' && equal;
    };
  };
  const condition = expression();
  return condition;
}

/** Whether an event matches a filter pattern: empty, a JSON pattern in braces, or text terms. */
export function patternMatches(message: string, pattern: string): boolean {
  const text = pattern.trim();
  if (!text) return true;
  if (text.startsWith('{')) {
    let log: unknown;
    try {
      log = JSON.parse(message);
    } catch {
      return false;
    }
    if (!log || typeof log !== 'object') return false;
    return parseJson(text.slice(1, text.lastIndexOf('}')))(log as Json);
  }
  const terms = text.match(/[?-]?"(?:\\.|[^"\\])*"|[?-]?\S+/g) ?? [];
  const word = (term: string) => message.includes(term.startsWith('"') ? (JSON.parse(term) as string) : term);
  const optional = terms.filter((term) => term.startsWith('?')).map((term) => term.slice(1));
  const required = terms.filter((term) => !term.startsWith('?'));
  return (
    (!optional.length || optional.some(word)) &&
    required.every((term) => (term.startsWith('-') ? !word(term.slice(1)) : word(term)))
  );
}

// --- The server. ---

/** A CloudWatch Logs API on 127.0.0.1 for tests and local trials: FilterLogEvents and DescribeLogGroups. */
export async function startFakeCloudWatch(options: FakeCloudWatchOptions = {}) {
  const state = {
    events: options.events ?? [],
    requests: [] as FakeRequest[],
    /** Answer the next requests with a ThrottlingException. */
    throttled: 0,
    /** Answer every other FilterLogEvents page with no events, as CloudWatch does while it searches. */
    emptyPages: false,
    /** Refuse the next requests' credentials as expired. */
    expired: 0,
  };
  const error = (status: number, type: string, message: string): FakeAnswer => ({
    status,
    payload: { __type: `com.amazonaws.logs#${type}`, message },
  });
  const groups = () => [...new Set([...(options.groups ?? []), ...state.events.map((event) => event.group)])].sort();
  const fake = await startFakeHttp((request) => {
    const action = String(request.headers['x-amz-target'] ?? '').replace(/^Logs_20140328\./, '');
    const authorization = String(request.headers.authorization ?? '');
    if (!authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${options.accessKeyId ?? ''}`))
      return error(400, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
    if (state.expired > 0) {
      state.expired--;
      return error(400, 'ExpiredTokenException', 'The security token included in the request is expired');
    }
    if (state.throttled > 0) {
      state.throttled--;
      return error(400, 'ThrottlingException', 'Rate exceeded');
    }
    const body = request.body;
    if (action === 'DescribeLogGroups') {
      const prefix = String(body.logGroupNamePrefix ?? '');
      const names = groups().filter((name) => name.startsWith(prefix));
      return {
        status: 200,
        payload: { logGroups: names.slice(0, Number(body.limit ?? 50)).map((logGroupName) => ({ logGroupName })) },
      };
    }
    if (action === 'FilterLogEvents') {
      const group = String(body.logGroupIdentifier ?? body.logGroupName ?? '');
      if (!groups().includes(group))
        return error(400, 'ResourceNotFoundException', 'The specified log group does not exist.');
      const pattern = String(body.filterPattern ?? '');
      const matching = state.events
        .filter(
          (event) =>
            event.group === group &&
            event.timestamp >= Number(body.startTime ?? 0) &&
            event.timestamp <= Number(body.endTime ?? Infinity) &&
            patternMatches(event.message, pattern),
        )
        .sort((a, b) => a.timestamp - b.timestamp);
      const token = String(body.nextToken ?? '0');
      // A token ending in `e` answers a part of the search with no events.
      if (state.emptyPages && !token.endsWith('e'))
        return { status: 200, payload: { events: [], nextToken: `${token}e` } };
      const start = Number(token.replace(/e$/, ''));
      const limit = Number(body.limit ?? 10000);
      const page = matching.slice(start, start + limit);
      const next = start + limit < matching.length ? String(start + limit) : undefined;
      return {
        status: 200,
        payload: {
          events: page.map((event) => ({
            timestamp: event.timestamp,
            message: event.message,
            logStreamName: event.stream ?? 'stream-1',
            eventId: event.id,
            ingestionTime: event.timestamp + 1000,
          })),
          ...(next ? { nextToken: next } : {}),
        },
      };
    }
    return error(400, 'UnknownOperationException', `Unknown action ${action}`);
  });
  state.requests = fake.requests;
  return { url: fake.url, state, close: fake.close };
}
