// Turns a Logline search into a MongoDB filter for a mapped log collection.
// Like the SQL translation, the filter may match more documents than the
// search, never fewer: the fetched documents are filtered again with the full
// search, so terms a filter cannot express, such as regular expressions, still apply.
import type { ColumnInfo, LogTableMapping, MappedField } from './connections';
import { parseQuery, type Token } from './query';
import { queryTokens } from './query-tokens';

export type MongoFilter = Record<string, unknown>;

export interface MongoLogRequest {
  mapping: LogTableMapping;
  /** Fields seen in a sample of the collection, with their types, such as `attributes.http.status: number`. */
  fields: ColumnInfo[];
  query: string;
  now?: number;
}

export interface MongoLogQuery {
  /** The filter for the search's terms; the connector adds the time range, which depends on how time is stored. */
  filter: MongoFilter;
  /** A time range from `last:` or `timestamp:` terms, narrowed further by the connector's own range. */
  fromMs?: number;
  toMs?: number;
  pushed: string[];
  local: string[];
}

const NUMERIC = /^(?:number|int|long|double|decimal)$/i;

/** A pattern for a value as text, in any case, anywhere in the field. */
// `*` in a value is a wildcard, as in `service:check*`; as `.*` it also matches a value with a `*` in it.
function pattern(value: string, prefix = false): string {
  return `${prefix ? '^' : ''}${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}`;
}

/**
 * A field whose text contains a pattern. A regex matches strings and arrays of
 * them; the field's other values, such as a number stored where the sample saw
 * text, are compared as text too, so no document the search matches is left out.
 */
function textMatch(name: string, regex: string): MongoFilter {
  const text = { $regex: regex, $options: 'i' };
  if (name.includes('$')) return { [name]: text };
  return {
    $or: [
      { [name]: text },
      {
        $expr: {
          $regexMatch: {
            input: { $convert: { input: `$${name}`, to: 'string', onError: '', onNull: '' } },
            regex,
            options: 'i',
          },
        },
      },
    ],
  };
}

function fieldNamed(fields: ColumnInfo[], name: string): ColumnInfo | undefined {
  const lower = name.toLowerCase();
  return fields.find((field) => field.name === name) ?? fields.find((field) => field.name.toLowerCase() === lower);
}

/** The field a term reads: a mapped role (level, message…), or a field of that name. */
function fieldFor(token: Token, request: MongoLogRequest): ColumnInfo | undefined {
  const role = token.canonical as MappedField | undefined;
  const mapped =
    role && role !== 'timestamp' && Object.hasOwn(request.mapping, role) ? request.mapping[role] : undefined;
  if (mapped) return fieldNamed(request.fields, mapped) ?? { name: mapped, type: 'string' };
  return fieldNamed(request.fields, token.field ?? '');
}

type Time = { fromMs?: number; toMs?: number };

/** A filter that holds for every document the term matches, or undefined when a filter cannot say. */
function condition(token: Token, request: MongoLogRequest, now: number, time: Time): MongoFilter | 'time' | undefined {
  if (token.changed !== undefined || token.regex !== undefined) return undefined;
  if (token.canonical === 'last') {
    if (token.negate || token.relativeMs === undefined) return undefined;
    time.fromMs = Math.max(time.fromMs ?? -Infinity, now - token.relativeMs);
    return 'time';
  }
  if (token.canonical === 'timestamp' || token.canonical === 'time') {
    const range = token.timestampRange;
    if (token.negate || !range || !range.every(Number.isFinite)) return undefined;
    time.fromMs = Math.max(time.fromMs ?? -Infinity, range[0]);
    time.toMs = Math.min(time.toMs ?? Infinity, range[1]);
    return 'time';
  }
  if (token.canonical === 'exists') {
    const field = fieldNamed(request.fields, token.value) ?? { name: token.value, type: 'string' };
    return { [field.name]: { $exists: !token.negate } };
  }
  // Free text matches any value of a document, including fields the sample never saw and
  // values inside arrays, which no filter on known fields can promise; Logline applies it.
  if (token.field === undefined) return undefined;
  const field = fieldFor(token, request);
  if (!field) return undefined;
  const numeric = NUMERIC.test(field.type);
  let filter: MongoFilter | undefined;
  if (token.numericComparison) {
    const operators: Record<string, string> = { '>': '$gt', '>=': '$gte', '<': '$lt', '<=': '$lte' };
    const operator = operators[token.numericComparison.operator];
    if (numeric && operator) filter = { [field.name]: { [operator]: token.numericComparison.target } };
  } else if (token.numericRange) {
    if (numeric) filter = { [field.name]: { $gte: token.numericRange[0], $lte: token.numericRange[1] } };
  } else if (token.compare) {
    filter = undefined;
  } else if (token.canonical === 'level') {
    // Logline reads numeric levels (pino's 50) as names, which a filter on the number cannot match.
    if (!numeric) filter = textMatch(field.name, token.value === 'fatal' ? 'fatal|critical' : pattern(token.value));
  } else if (token.canonical === 'status' && /^\dxx$/.test(token.value)) {
    const hundred = Number(token.value[0]) * 100;
    filter = numeric
      ? { [field.name]: { $gte: hundred, $lte: hundred + 99 } }
      : textMatch(field.name, pattern(token.value[0], true));
  } else if (!numeric) filter = textMatch(field.name, pattern(token.value));
  if (filter === undefined) return undefined;
  // A negated term matches documents without the field too.
  return token.negate ? { $nor: [filter] } : filter;
}

const REGEX_TERM = /^-?(?:@?[A-Za-z_][A-Za-z0-9_.]*:(?!\/\/))?\/.+\/[dgimsuvy]*$/;

/** The query's terms as typed, grouped like parseQuery groups them; regular expressions have no token. */
function termGroups(input: string): { text: string; token?: Token }[][] {
  const groups: { text: string; token?: Token }[][] = [[]];
  for (const text of queryTokens(input)) {
    if (text === 'OR' || text === 'or') groups.push([]);
    else if (REGEX_TERM.test(text)) groups.at(-1)!.push({ text });
    else {
      const token = parseQuery(text)[0]?.[0];
      if (token) groups.at(-1)!.push({ text, token });
    }
  }
  return groups.filter((group) => group.length);
}

/** The filter for the documents of a mapped collection that can match a search. */
export function buildMongoLogQuery(request: MongoLogRequest): MongoLogQuery {
  const now = request.now ?? Date.now();
  const groups = termGroups(request.query.slice(0, 1024));
  const pushed = new Set<string>();
  const local = new Set<string>();
  const alternatives: MongoFilter[][] = [];
  const time: Time = {};
  let unrestricted = false;
  for (const group of groups) {
    const terms: MongoFilter[] = [];
    let narrowed = false;
    for (const { text, token } of group) {
      // Time terms only narrow a search without OR: in an OR branch they would narrow every branch.
      const branchTime: Time = {};
      const result = token && condition(token, request, now, groups.length > 1 ? branchTime : time);
      if (result === 'time' && groups.length === 1) {
        pushed.add(text);
        narrowed = true;
      } else if (result && result !== 'time') {
        terms.push(result);
        pushed.add(text);
        narrowed = true;
      } else local.add(text);
    }
    if (!narrowed) unrestricted = true;
    alternatives.push(terms);
  }
  if (unrestricted && groups.length > 1)
    return { filter: {}, pushed: [], local: groups.flat().map((term) => term.text) };
  const and = (terms: MongoFilter[]): MongoFilter =>
    terms.length === 1 ? terms[0] : terms.length ? { $and: terms } : {};
  const filter =
    alternatives.length === 1 ? and(alternatives[0]) : alternatives.length ? { $or: alternatives.map(and) } : {};
  return {
    filter,
    ...(time.fromMs !== undefined && Number.isFinite(time.fromMs) ? { fromMs: time.fromMs } : {}),
    ...(time.toMs !== undefined && Number.isFinite(time.toMs) ? { toMs: time.toMs } : {}),
    pushed: [...pushed],
    local: [...local],
  };
}

// Stages a typed pipeline may use: they read and reshape documents. $out and $merge write, and
// $function, $accumulator, and $where run JavaScript on the server, so they are refused anywhere.
const READ_STAGES = new Set([
  '$match',
  '$project',
  '$addFields',
  '$set',
  '$unset',
  '$sort',
  '$limit',
  '$skip',
  '$group',
  '$count',
  '$unwind',
  '$lookup',
  '$graphLookup',
  '$facet',
  '$bucket',
  '$bucketAuto',
  '$sortByCount',
  '$replaceRoot',
  '$replaceWith',
  '$sample',
  '$densify',
  '$fill',
  '$setWindowFields',
  '$unionWith',
  '$redact',
  '$documents',
]);
const REFUSED = new Set(['$out', '$merge', '$function', '$accumulator', '$where']);

function refusedOperator(value: unknown, depth = 0): string | undefined {
  // A query nested deeper than this is refused rather than checked only in part.
  if (depth > 64) return 'Nesting this deep';
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (REFUSED.has(key)) return key;
    const found = refusedOperator(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Check a query typed by a person: a filter (an object) or a pipeline (an
 * array of stages) that only reads. Logline never sends a write, and this
 * refuses the operators that would write or run code before the server sees them.
 */
export function checkMongoQuery(
  value: unknown,
): { kind: 'filter'; filter: MongoFilter } | { kind: 'pipeline'; pipeline: MongoFilter[] } | { error: string } {
  const refused = refusedOperator(value);
  if (refused)
    return {
      error: refused.startsWith('$')
        ? `${refused} is not allowed: Logline only reads.`
        : 'The query is nested too deeply to check that it only reads.',
    };
  if (Array.isArray(value)) {
    if (!value.length) return { error: 'Enter a filter, such as { "level": "error" }, or a pipeline of stages.' };
    for (const stage of value) {
      if (!stage || typeof stage !== 'object' || Array.isArray(stage))
        return { error: 'Each stage of a pipeline is an object.' };
      const keys = Object.keys(stage);
      if (keys.length !== 1) return { error: 'Each stage of a pipeline has one operator, such as { "$match": … }.' };
      if (!READ_STAGES.has(keys[0])) return { error: `${keys[0]} is not allowed in a pipeline here.` };
    }
    return { kind: 'pipeline', pipeline: value as MongoFilter[] };
  }
  if (value && typeof value === 'object') return { kind: 'filter', filter: value as MongoFilter };
  return { error: 'Enter a filter, such as { "level": "error" }, or a pipeline of stages.' };
}

/** A filter as the shell would show it, with dates as ISODate(…), for the line under a connection's controls. */
export function filterText(value: unknown): string {
  // JSON.stringify turns a Date into text before the replacer sees it; the holder still has the Date.
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, item: unknown) {
    const original = this[key];
    return original instanceof Date ? `ISODate(${original.toISOString()})` : item;
  }).replace(/"ISODate\(([^)]+)\)"/g, 'ISODate("$1")');
}
