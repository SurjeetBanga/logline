import { startFakeHttp, type FakeRequest } from './fake-http';

/** A document in an index. */
export interface FakeDocument {
  index: string;
  id: string;
  source: Record<string, unknown>;
}

export interface FakeElasticOptions {
  documents?: FakeDocument[];
  /** Fields mapped as text, with a `.keyword` beside each; other strings are keywords. */
  textFields?: string[];
  /** Fields mapped as dates. */
  dateFields?: string[];
  /** Basic auth's user and password, or an API key alone. */
  user?: string;
  password?: string;
  distribution?: 'opensearch';
}

type Json = Record<string, unknown>;
type Clause = Record<string, unknown>;

// --- A part of the Query DSL, enough to check what Logline sends. ---

function flatten(value: unknown, prefix = '', into: Json = {}): Json {
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [name, inner] of Object.entries(value)) flatten(inner, prefix ? `${prefix}.${name}` : name, into);
  else if (prefix) into[prefix] = value;
  return into;
}

const words = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);
const phrase = (field: unknown, text: string) => {
  const have = words(field).join(' ');
  const want = words(text).join(' ');
  return want !== '' && ` ${have} `.includes(` ${want} `);
};

function matches(document: Json, clause: Clause, options: FakeElasticOptions): boolean {
  const field = (name: string) => document[name.replace(/\.keyword$/, '')];
  const [kind, body] = Object.entries(clause)[0] as [string, Json];
  switch (kind) {
    case 'bool': {
      const all = (list: unknown) => (Array.isArray(list) ? (list as Clause[]) : []);
      const should = all(body.should);
      return (
        all(body.filter).every((inner) => matches(document, inner, options)) &&
        all(body.must).every((inner) => matches(document, inner, options)) &&
        !all(body.must_not).some((inner) => matches(document, inner, options)) &&
        (!should.length || should.some((inner) => matches(document, inner, options)))
      );
    }
    case 'range': {
      const [name, limits] = Object.entries(body)[0] as [string, Json];
      const raw = field(name);
      if (raw === undefined) return false;
      const value = options.dateFields?.includes(name) ? Date.parse(String(raw)) : Number(raw);
      return (
        (limits.gt === undefined || value > Number(limits.gt)) &&
        (limits.gte === undefined || value >= Number(limits.gte)) &&
        (limits.lt === undefined || value < Number(limits.lt)) &&
        (limits.lte === undefined || value <= Number(limits.lte))
      );
    }
    case 'wildcard': {
      const [name, spec] = Object.entries(body)[0] as [string, Json];
      const source = String(spec.value).replace(
        /\\(.)|([*?])|([^\\*?])/g,
        (_, escaped: string, special: string, plain: string) =>
          special === '*' ? '.*' : special === '?' ? '.' : (escaped ?? plain).replace(/[.+^${}()|[\]\\]/g, '\\$&'),
      );
      const value = field(name);
      return value !== undefined && new RegExp(`^${source}$`, spec.case_insensitive ? 'is' : 's').test(String(value));
    }
    case 'match_phrase': {
      const [name, text] = Object.entries(body)[0] as [string, string];
      return phrase(field(name), text);
    }
    case 'term': {
      const [name, value] = Object.entries(body)[0];
      return field(name) === value;
    }
    case 'exists':
      return field(String(body.field)) !== undefined;
    case 'simple_query_string': {
      const text = String(body.query).replace(/^"|"$/g, '');
      return (body.fields as string[]).some((name) =>
        options.textFields?.includes(name) ? phrase(field(name), text) : String(field(name) ?? '') === text,
      );
    }
    case 'query_string': {
      // `field:value` terms joined by AND, enough for a typed query.
      return String(body.query)
        .split(/\s+AND\s+/)
        .every((term) => {
          const [name, value] = term.split(':');
          return String(field(name) ?? '').toLowerCase() === value.toLowerCase();
        });
    }
    default:
      throw new Error(`unsupported query ${kind}`);
  }
}

// --- The server. ---

/** An Elasticsearch API on 127.0.0.1 for tests and local trials: indices, fields, searches, and terms. */
export async function startFakeElastic(options: FakeElasticOptions = {}) {
  const state = {
    documents: options.documents ?? [],
    requests: [] as FakeRequest[],
    /** Answer the next requests with 429. */
    rateLimited: 0,
  };
  const authorized = (request: FakeRequest) => {
    const header = String(request.headers.authorization ?? '');
    if (options.user)
      return header === `Basic ${Buffer.from(`${options.user}:${options.password ?? ''}`).toString('base64')}`;
    if (options.password) return header === `ApiKey ${options.password}`;
    return true;
  };
  const error = (status: number, type: string, reason: string, extra: Json = {}) => ({
    status,
    payload: { error: { root_cause: [{ type, reason, ...extra }], type, reason }, status },
  });
  const inPattern = (pattern: string) => {
    const patterns = decodeURIComponent(pattern)
      .split(',')
      .map((part) => new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
    return state.documents.filter((document) => patterns.some((regex) => regex.test(document.index)));
  };
  const fieldTypes = (documents: FakeDocument[]) => {
    const types = new Map<string, string>();
    for (const document of documents)
      for (const [name, value] of Object.entries(flatten(document.source))) {
        if (options.dateFields?.includes(name)) types.set(name, 'date');
        else if (options.textFields?.includes(name)) {
          types.set(name, 'text');
          types.set(`${name}.keyword`, 'keyword');
        } else if (typeof value === 'number') types.set(name, Number.isInteger(value) ? 'long' : 'float');
        else if (typeof value === 'boolean') types.set(name, 'boolean');
        else types.set(name, 'keyword');
      }
    return types;
  };
  const fake = await startFakeHttp((request) => {
    if (state.rateLimited > 0) {
      state.rateLimited--;
      return {
        ...error(429, 'es_rejected_execution_exception', 'rejected execution'),
        headers: { 'retry-after': '2' },
      };
    }
    if (!authorized(request)) return error(401, 'security_exception', 'unable to authenticate user');
    const parts = request.path.split('/').filter(Boolean);
    if (!parts.length)
      return {
        status: 200,
        payload: {
          version: {
            number: options.distribution ? '2.17.0' : '8.15.0',
            ...(options.distribution ? { distribution: options.distribution } : {}),
          },
        },
      };
    if (parts[0] === '_alias')
      return {
        status: 200,
        payload: Object.fromEntries(
          [...new Set(state.documents.map((document) => document.index))].map((index) => [index, { aliases: {} }]),
        ),
      };
    if (parts[0] === '_data_stream') return { status: 200, payload: { data_streams: [] } };
    const documents = inPattern(parts[0]);
    if (!documents.length && !parts[0].includes('*'))
      return error(404, 'index_not_found_exception', `no such index [${decodeURIComponent(parts[0])}]`, {
        'resource.id': decodeURIComponent(parts[0]),
      });
    if (parts[1] === '_field_caps')
      return {
        status: 200,
        payload: {
          fields: Object.fromEntries([...fieldTypes(documents)].map(([name, type]) => [name, { [type]: { type } }])),
        },
      };
    if (parts[1] === '_search') {
      const body = request.body;
      const flat = documents.map((document) => ({ document, fields: flatten(document.source) }));
      const found = flat.filter(({ fields }) => !body.query || matches(fields, body.query as Clause, options));
      if (body.aggs) {
        const terms = object(object(object(body.aggs).services).terms);
        const counts = new Map<string, number>();
        for (const { fields } of found) {
          const value = fields[String(terms.field).replace(/\.keyword$/, '')];
          if (value !== undefined) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
        }
        return {
          status: 200,
          payload: {
            hits: { hits: [] },
            aggregations: {
              services: { buckets: [...counts].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, doc_count: n })) },
            },
          },
        };
      }
      const [sort] = Array.isArray(body.sort) ? (body.sort as Json[]) : [];
      const [time, spec] = sort ? (Object.entries(sort)[0] as [string, Json]) : ['', {}];
      const key = (fields: Json) => (time ? Date.parse(String(fields[time])) : 0);
      const descending = spec.order === 'desc';
      const ordered = found
        .map((item) => ({ ...item, sort: [key(item.fields), documents.indexOf(item.document)] }))
        .sort((a, b) =>
          descending ? b.sort[0] - a.sort[0] || b.sort[1] - a.sort[1] : a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1],
        );
      const after = body.search_after as number[] | undefined;
      const rest = after
        ? ordered.filter(({ sort: [t, d] }) =>
            descending
              ? t < after[0] || (t === after[0] && d < after[1])
              : t > after[0] || (t === after[0] && d > after[1]),
          )
        : ordered;
      const size = Number(body.size ?? 10);
      return {
        status: 200,
        payload: {
          hits: {
            ...(body.track_total_hits ? { total: { value: found.length, relation: 'eq' } } : {}),
            hits: rest.slice(0, size).map(({ document, sort: values }) => ({
              _index: document.index,
              _id: document.id,
              _source: document.source,
              sort: values,
            })),
          },
        },
      };
    }
    return error(400, 'illegal_argument_exception', `unknown path ${request.path}`);
  });
  state.requests = fake.requests;
  return { url: fake.url, state, close: fake.close };
}

const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
