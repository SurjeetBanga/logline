// Turns a Logline search into an Elasticsearch query for a mapped index
// pattern. Fields are matched by their type, read from the index: a keyword
// field matches any part of its value without case, as Logline matches it; a
// text field matches its words, as Elasticsearch does; numbers are compared
// as numbers. Free text matches as Elasticsearch matches it, a word of any
// text field or a whole keyword value. Fetched logs are filtered again with
// the whole search, so what a query cannot express still applies.
import type { ColumnInfo, LogTableMapping, MappedField } from './connections';
import { pushDown, termGroups, typedValue } from './pushdown';
import { canonicalField, type Token } from './query';

type Clause = Record<string, unknown>;

export interface ElasticRequest {
  mapping: LogTableMapping;
  /** The index's fields and their types, from `_field_caps`. */
  fields: ColumnInfo[];
  query: string;
  /** A query in Lucene syntax, sent as typed instead of `query`. */
  native?: string;
  fromMs?: number;
  toMs?: number;
}

export interface ElasticQuery {
  /** The `query` of a search request. */
  query: Clause;
  /** The query without its time range, as the panel shows what a search sends. */
  statement: Clause;
  pushed: string[];
  local: string[];
}

const NUMERIC = /^(?:long|integer|short|byte|double|float|half_float|scaled_float|unsigned_long)$/;
const KEYWORD = /^(?:keyword|constant_keyword|wildcard|version)$/;
const TEXT = /^(?:text|match_only_text)$/;
// Elasticsearch refuses a query that names more fields than this, by default.
const MAX_TEXT_FIELDS = 1000;
const ROLES: MappedField[] = ['level', 'message', 'service', 'traceId'];
// The names a field goes by across logging libraries and the Elastic Common Schema.
const NAMES: Record<string, string[]> = {
  level: ['level', 'severity', 'log.level'],
  message: ['message', 'msg'],
  status: ['status', 'statusCode', 'status_code', 'http.response.status_code', 'http.status_code'],
  service: ['service', 'service.name', 'service_name'],
  traceId: ['traceId', 'trace_id', 'trace.id'],
  durationMs: ['durationMs', 'duration', 'duration_ms', 'event.duration'],
};
// pino and bunyan write levels as numbers.
const LEVEL_CODES: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

const one = (clauses: Clause[]): Clause =>
  clauses.length === 1 ? clauses[0] : { bool: { should: clauses, minimum_should_match: 1 } };
/** A wildcard value: `*` and `?` stand for themselves unless typed as `*`. */
const wildcard = (value: string) => value.replace(/[?\\]/g, (character) => `\\${character}`);

/** The fields of the index a term may be in: the name typed, its other names, and the mapped field for its role. */
function fieldsFor(token: Token, request: ElasticRequest): ColumnInfo[] {
  const name = token.field!.replace(/^@/, '');
  const canonical = token.canonical ?? canonicalField(name);
  const names = new Set([name, ...(NAMES[canonical] ?? [])]);
  const role = ROLES.find((candidate) => candidate === canonical);
  if (role && request.mapping[role]) names.add(request.mapping[role]!);
  return request.fields.filter((field) => names.has(field.name));
}

/** The keyword field that holds a text field's whole value, such as `message.keyword`. */
const keywordOf = (field: ColumnInfo, request: ElasticRequest) =>
  request.fields.find((candidate) => candidate.name.startsWith(`${field.name}.`) && KEYWORD.test(candidate.type));

/** A keyword field kept beside a text field, such as `message.keyword`, which holds the same value. */
const subfieldOfText = (field: ColumnInfo, request: ElasticRequest) =>
  request.fields.some((parent) => TEXT.test(parent.type) && field.name.startsWith(`${parent.name}.`));

/** A value somewhere in a field, as Logline matches it, or undefined when the field cannot say. */
function contains(field: ColumnInfo, value: string, request: ElasticRequest): Clause | undefined {
  const pattern = value.includes('*') ? wildcard(value) : `*${wildcard(value)}*`;
  if (KEYWORD.test(field.type)) return { wildcard: { [field.name]: { value: pattern, case_insensitive: true } } };
  if (TEXT.test(field.type)) {
    // A text field's words, or any part of its whole value when a keyword field keeps that.
    const keyword = keywordOf(field, request);
    const words: Clause = { match_phrase: { [field.name]: value.replace(/\*/g, ' ').trim() } };
    return keyword ? one([{ wildcard: { [keyword.name]: { value: pattern, case_insensitive: true } } }, words]) : words;
  }
  if (NUMERIC.test(field.type) && /^-?\d+(?:\.\d+)?$/.test(value)) return { term: { [field.name]: Number(value) } };
  if (field.type === 'boolean' && /^(?:true|false)$/i.test(value))
    return { term: { [field.name]: /^true$/i.test(value) } };
  if (field.type === 'ip' && !value.includes('*')) return { term: { [field.name]: value } };
  return undefined;
}

function clause(token: Token, text: string, request: ElasticRequest): Clause | undefined {
  if (token.changed !== undefined || token.regex !== undefined) return undefined;
  if (['last', 'timestamp', 'time'].includes(token.canonical ?? '')) return undefined;
  let condition: Clause | undefined;
  if (token.field === undefined) {
    if (!token.value) return undefined;
    // Words as Elasticsearch finds them in the index's text and keyword fields. An index with more fields than
    // one query may name leaves them to Logline, since searching some of the fields could miss logs.
    const fields = request.fields.filter(
      (field) => (TEXT.test(field.type) || KEYWORD.test(field.type)) && !subfieldOfText(field, request),
    );
    if (!fields.length || fields.length > MAX_TEXT_FIELDS) return undefined;
    condition = {
      simple_query_string: {
        query: JSON.stringify(typedValue(text, token)),
        fields: fields.map((field) => field.name),
        lenient: true,
      },
    };
  } else if (token.canonical === 'exists') {
    const fields = request.fields.filter(
      (field) => field.name === token.value || field.name.startsWith(`${token.value}.`),
    );
    if (!fields.length) return undefined;
    condition = one(fields.map((field) => ({ exists: { field: field.name } })));
  } else {
    const fields = fieldsFor(token, request);
    const numeric = fields.filter((field) => NUMERIC.test(field.type));
    const clauses: Clause[] = [];
    if (token.numericComparison) {
      const operators: Record<string, string> = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };
      const operator = operators[token.numericComparison.operator];
      if (!operator) return undefined;
      clauses.push(
        ...numeric.map((field) => ({ range: { [field.name]: { [operator]: token.numericComparison!.target } } })),
      );
    } else if (token.numericRange) {
      const [gte, lte] = token.numericRange;
      clauses.push(...numeric.map((field) => ({ range: { [field.name]: { gte, lte } } })));
    } else if (token.compare) {
      return undefined;
    } else if (token.canonical === 'status' && /^\dxx$/.test(token.value)) {
      const low = Number(token.value[0]) * 100;
      clauses.push(...numeric.map((field) => ({ range: { [field.name]: { gte: low, lte: low + 99 } } })));
    } else {
      const value = typedValue(text, token);
      for (const field of fields) {
        const found = contains(field, value, request);
        if (found) clauses.push(found);
        // pino's numeric levels.
        if (token.canonical === 'level' && NUMERIC.test(field.type) && LEVEL_CODES[token.value])
          clauses.push({ term: { [field.name]: LEVEL_CODES[token.value] } });
      }
    }
    // A field the index does not have, or whose type cannot say the term, is left to Logline.
    if (!clauses.length) return undefined;
    condition = one(clauses);
  }
  // A negated term also matches logs without the field, as must_not does.
  return token.negate ? { bool: { must_not: [condition] } } : condition;
}

/** The query for the logs of a mapped index pattern that can match a search, within the range. */
export function buildElasticQuery(request: ElasticRequest): ElasticQuery {
  const range: Clause[] =
    request.fromMs !== undefined || request.toMs !== undefined
      ? [
          {
            range: {
              [request.mapping.timestamp]: {
                ...(request.fromMs !== undefined ? { gte: request.fromMs } : {}),
                ...(request.toMs !== undefined ? { lte: request.toMs } : {}),
                format: 'epoch_millis',
              },
            },
          },
        ]
      : [];
  if (request.native !== undefined) {
    const text = request.native.trim();
    const typed = text && text !== '*' ? [{ query_string: { query: text, lenient: true } }] : [];
    return {
      query: { bool: { filter: [...range, ...typed] } },
      statement: { bool: { filter: typed } },
      pushed: [],
      local: [],
    };
  }
  const { branches, pushed, local, unrestricted } = pushDown(termGroups(request.query), (token, text) =>
    clause(token, text, request),
  );
  const and = (clauses: Clause[]): Clause => (clauses.length === 1 ? clauses[0] : { bool: { filter: clauses } });
  const terms =
    unrestricted || !branches.length
      ? []
      : branches.length === 1
        ? branches[0]
        : [{ bool: { should: branches.map(and), minimum_should_match: 1 } }];
  return { query: { bool: { filter: [...range, ...terms] } }, statement: { bool: { filter: terms } }, pushed, local };
}

/** The keyword field to list a mapped service's values from, or undefined when there is none. */
export function serviceField(mapping: LogTableMapping, fields: ColumnInfo[]): string | undefined {
  const field = fields.find((candidate) => candidate.name === mapping.service);
  if (!field) return undefined;
  if (KEYWORD.test(field.type)) return field.name;
  return fields.find((candidate) => candidate.name.startsWith(`${field.name}.`) && KEYWORD.test(candidate.type))?.name;
}
