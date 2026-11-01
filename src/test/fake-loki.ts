import { startFakeHttp, type FakeAnswer, type FakeRequest } from './fake-http';

/** A line in a stream. */
export interface FakeLine {
  labels: Record<string, string>;
  /** Milliseconds since 1970; Loki's nanoseconds are this with six zeros. */
  timeMs: number;
  line: string;
}

export interface FakeLokiOptions {
  lines?: FakeLine[];
  /** Basic auth's user and password, or a bearer token alone. */
  user?: string;
  password?: string;
}

type Labels = Record<string, string>;
type Filter = (line: string, labels: Labels) => boolean;

// --- A part of LogQL, enough to check what Logline sends. ---

/** A Go regular expression as JavaScript reads it: a leading (?i) becomes the i flag. */
function regex(source: string, anchored: boolean): RegExp {
  const insensitive = source.startsWith('(?i)');
  const body = insensitive ? source.slice(4) : source;
  return new RegExp(anchored ? `^(?:${body})$` : body, insensitive ? 'is' : 's');
}

function compare(actual: string | undefined, operator: string, value: string | number): boolean {
  const text = actual ?? '';
  if (typeof value === 'number') {
    if (actual === undefined || actual === '' || !Number.isFinite(Number(actual))) return false;
    const number = Number(actual);
    return (
      {
        '>': number > value,
        '>=': number >= value,
        '<': number < value,
        '<=': number <= value,
        '=': number === value,
        '!=': number !== value,
      }[operator] ?? false
    );
  }
  if (operator === '=') return text === value;
  if (operator === '!=') return text !== value;
  if (operator === '=~') return regex(value, true).test(text);
  if (operator === '!~') return !regex(value, true).test(text);
  return false;
}

/** JSON's fields as labels, nested names joined with `_`, as `| json` makes them. */
function flatten(value: unknown, prefix = '', into: Labels = {}): Labels {
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [name, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}_${name}` : name, into);
  else if (prefix) into[prefix] = typeof value === 'string' ? value : JSON.stringify(value);
  return into;
}

/** A log query: which streams it reads, and what each of their lines must pass. */
export function parseLogQL(query: string): { streams: Filter; lines: Filter } {
  let at = 0;
  const space = () => {
    while (/\s/.test(query[at] ?? '')) at++;
  };
  const string = (): string => {
    space();
    const match = /^"(?:\\.|[^"\\])*"/.exec(query.slice(at));
    if (!match) throw new Error(`parse error at ${at}: expected a string`);
    at += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const name = (): string => {
    space();
    const match = /^[A-Za-z_]\w*/.exec(query.slice(at));
    if (!match) throw new Error(`parse error at ${at}: expected a label`);
    at += match[0].length;
    return match[0];
  };
  const operator = (): string => {
    space();
    const match = /^(=~|!~|!=|>=|<=|=|>|<)/.exec(query.slice(at));
    if (!match) throw new Error(`parse error at ${at}: expected an operator`);
    at += match[0].length;
    return match[0];
  };
  // The stream selector.
  space();
  if (query[at] !== '{') throw new Error('parse error: a query starts with a stream selector');
  at++;
  const matchers: Filter[] = [];
  for (;;) {
    space();
    if (query[at] === '}') break;
    const label = name();
    const op = operator();
    const value = string();
    matchers.push((_, labels) => compare(labels[label], op, value));
    space();
    if (query[at] === ',') at++;
  }
  at++;
  // A label filter expression: comparisons joined by `and` and `or`, in parentheses or not.
  const expression = (): Filter => {
    let left = conjunction();
    space();
    while (query.startsWith('or ', at)) {
      at += 3;
      const [a, b] = [left, conjunction()];
      left = (line, labels) => a(line, labels) || b(line, labels);
      space();
    }
    return left;
  };
  const conjunction = (): Filter => {
    let left = primary();
    space();
    while (query.startsWith('and ', at)) {
      at += 4;
      const [a, b] = [left, primary()];
      left = (line, labels) => a(line, labels) && b(line, labels);
      space();
    }
    return left;
  };
  const primary = (): Filter => {
    space();
    if (query[at] === '(') {
      at++;
      const inner = expression();
      space();
      at++;
      return inner;
    }
    const label = name();
    const op = operator();
    space();
    const number = /^-?\d+(?:\.\d+)?/.exec(query.slice(at));
    if (number && query[at] !== '"') {
      at += number[0].length;
      return (_, labels) => compare(labels[label], op, Number(number[0]));
    }
    const value = string();
    return (_, labels) => compare(labels[label], op, value);
  };
  // The pipeline: line filters, `| json`, and label filters, in order.
  const stages: ((line: string, labels: Labels) => Labels | undefined)[] = [];
  for (;;) {
    space();
    if (at >= query.length) break;
    const filter = /^(\|=|!=|\|~|!~)/.exec(query.slice(at));
    if (filter) {
      at += filter[0].length;
      const value = string();
      const op = filter[0];
      stages.push((line, labels) => {
        const found = op.endsWith('~') ? regex(value, false).test(line) : line.includes(value);
        return found === op.startsWith('|') ? labels : undefined;
      });
      continue;
    }
    if (query[at] !== '|') throw new Error(`parse error at ${at}`);
    at++;
    space();
    if (query.startsWith('json', at)) {
      at += 4;
      stages.push((line, labels) => {
        try {
          return { ...labels, ...flatten(JSON.parse(line)) };
        } catch {
          return { ...labels, __error__: 'JSONParserErr' };
        }
      });
      continue;
    }
    const condition = expression();
    stages.push((line, labels) => (condition(line, labels) ? labels : undefined));
  }
  return {
    streams: (line, labels) => matchers.every((matcher) => matcher(line, labels)),
    lines: (line, labels) => {
      let current: Labels | undefined = labels;
      for (const stage of stages) if (current) current = stage(line, current);
      return current !== undefined;
    },
  };
}

// --- The server. ---

/** A Loki API on 127.0.0.1 for tests and local trials: range and count queries, labels, and volumes. */
export async function startFakeLoki(options: FakeLokiOptions = {}) {
  const state = {
    lines: options.lines ?? [],
    requests: [] as FakeRequest[],
    /** Answer the next requests with 429. */
    rateLimited: 0,
  };
  const authorized = (request: FakeRequest) => {
    const header = String(request.headers.authorization ?? '');
    if (options.user)
      return header === `Basic ${Buffer.from(`${options.user}:${options.password ?? ''}`).toString('base64')}`;
    if (options.password) return header === `Bearer ${options.password}`;
    return true;
  };
  const text = (status: number, message: string): FakeAnswer => ({ status, payload: message });
  const matching = (query: string, fromMs: number, toMs: number) => {
    const { streams, lines } = parseLogQL(query);
    return state.lines.filter(
      (line) =>
        line.timeMs >= fromMs && line.timeMs < toMs && streams(line.line, line.labels) && lines(line.line, line.labels),
    );
  };
  const fake = await startFakeHttp((request) => {
    const params = request.url.searchParams;
    if (state.rateLimited > 0) {
      state.rateLimited--;
      return { status: 429, payload: 'too many outstanding requests', headers: { 'retry-after': '3' } };
    }
    if (!authorized(request)) return text(401, 'no org id or invalid credentials');
    const ms = (name: string, fallback: number) =>
      params.get(name) ? Number(BigInt(params.get(name)!) / 1000000n) : fallback;
    try {
      if (request.path === '/loki/api/v1/query_range') {
        const backward = params.get('direction') !== 'forward';
        const found = matching(params.get('query') ?? '', ms('start', 0), ms('end', Infinity))
          .sort((a, b) => (backward ? b.timeMs - a.timeMs : a.timeMs - b.timeMs))
          .slice(0, Number(params.get('limit') ?? 100));
        const streams = new Map<string, { stream: Labels; values: [string, string][] }>();
        for (const line of found) {
          const key = JSON.stringify(line.labels);
          if (!streams.has(key)) streams.set(key, { stream: line.labels, values: [] });
          streams.get(key)!.values.push([`${line.timeMs}000000`, line.line]);
        }
        return {
          status: 200,
          payload: { status: 'success', data: { resultType: 'streams', result: [...streams.values()] } },
        };
      }
      if (request.path === '/loki/api/v1/query') {
        const count = /^sum\(count_over_time\((.*) \[(\d+)s\]\)\)$/s.exec(params.get('query') ?? '');
        if (!count) return text(400, 'parse error: only sum(count_over_time(…)) is understood here');
        const time = ms('time', Date.now());
        const n = matching(count[1], time - Number(count[2]) * 1000, time + 1).length;
        return {
          status: 200,
          payload: {
            status: 'success',
            data: { resultType: 'vector', result: [{ metric: {}, value: [time / 1000, String(n)] }] },
          },
        };
      }
      if (request.path === '/loki/api/v1/labels')
        return {
          status: 200,
          payload: {
            status: 'success',
            data: [...new Set(state.lines.flatMap((line) => Object.keys(line.labels)))].sort(),
          },
        };
      if (request.path === '/loki/api/v1/index/volume') {
        const counts = new Map<string, number>();
        for (const line of matching(params.get('query') ?? '{service_name=~".+"}', ms('start', 0), ms('end', Infinity)))
          counts.set(line.labels.service_name, (counts.get(line.labels.service_name) ?? 0) + 1);
        return {
          status: 200,
          payload: {
            status: 'success',
            data: {
              resultType: 'vector',
              result: [...counts].map(([name, n]) => ({ metric: { service_name: name }, value: [0, String(n)] })),
            },
          },
        };
      }
      return text(404, '404 page not found');
    } catch (error) {
      return text(400, (error as Error).message);
    }
  });
  state.requests = fake.requests;
  return { url: fake.url, state, close: fake.close };
}
