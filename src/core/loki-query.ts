// Turns a Logline search into LogQL. Words become line filters, matched
// without case as Logline matches them; fields become label filters after a
// JSON parser, matching any part of the value as Logline does, so LogQL never
// matches fewer logs than the search. Fetched logs are filtered again with the
// whole search, so what LogQL cannot express still applies.
import { LOKI_SELECTOR } from './connections';
import { pushDown, termGroups, typedValue } from './pushdown';
import { canonicalField, type Token } from './query';

export interface LokiQuery {
  /** The whole LogQL query: a stream selector and its pipeline. */
  query: string;
  pushed: string[];
  local: string[];
}

// The names a field goes by across logging libraries, as Logline reads them, for fields a filter names.
const NAMES: Record<string, string[]> = {
  level: ['level', 'severity', 'detected_level'],
  message: ['message', 'msg'],
  status: ['status', 'statusCode', 'status_code', 'http_status_code', 'http_response_status_code'],
  traceId: ['traceId', 'trace_id', 'traceID'],
  durationMs: ['durationMs', 'duration', 'duration_ms', 'responseTime'],
};
// pino and bunyan write levels as numbers.
const LEVEL_CODES: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

type Term = { kind: 'line'; filter: string } | { kind: 'label'; filter: string } | { kind: 'service'; matcher: string };

/** A Go string literal, as LogQL reads one. */
const quote = (value: string) => JSON.stringify(value);
/** RE2 for text that matches itself, `*` standing for any text. */
const literal = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
/** Text anywhere in a value, without case, unless it has `*`: then the whole value. */
const valuePattern = (value: string) => (value.includes('*') ? `(?i)${literal(value)}` : `(?i).*${literal(value)}.*`);
const any = (filters: string[]) => (filters.length === 1 ? filters[0] : `(${filters.join(' or ')})`);
const all = (filters: string[]) => (filters.length === 1 ? filters[0] : `(${filters.join(' and ')})`);

/**
 * The labels a field may be after `| json`, which joins the names of nested
 * fields with `_`, or undefined for a name a label cannot be.
 */
function labels(token: Token): string[] | undefined {
  const name = token.field!.replace(/^@/, '').replace(/\./g, '_');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  const known = NAMES[token.canonical ?? canonicalField(token.field!)];
  return known ? [...new Set([name, ...known])] : [name];
}

function term(token: Token, text: string): Term | undefined {
  if (token.changed !== undefined) return undefined;
  if (['last', 'timestamp', 'time'].includes(token.canonical ?? '')) return undefined;
  if (token.field === undefined) {
    if (!token.value || token.regex !== undefined) return undefined;
    return {
      kind: 'line',
      filter: `${token.negate ? '!~' : '|~'} ${quote(`(?i)${literal(typedValue(text, token))}`)}`,
    };
  }
  if (token.regex !== undefined) return undefined;
  if (token.canonical === 'exists') {
    const names = labels({ ...token, field: token.value, canonical: canonicalField(token.value) });
    if (!names) return undefined;
    const present = any(names.map((name) => `${name}!=""`));
    return { kind: 'label', filter: token.negate ? all(names.map((name) => `${name}=""`)) : present };
  }
  // A service names the streams read, when the search says nothing else that could.
  if (token.canonical === 'service' && !token.negate && !token.numericComparison)
    return { kind: 'service', matcher: `service_name=~${quote(valuePattern(typedValue(text, token)))}` };
  const names = labels(token);
  if (!names) return undefined;
  let filters: string[];
  if (token.numericComparison) {
    const { operator, target } = token.numericComparison;
    if (!['>', '>=', '<', '<='].includes(operator)) return undefined;
    filters = names.map((name) => `${name}${operator}${target}`);
  } else if (token.numericRange) {
    const [low, high] = token.numericRange;
    filters = names.map((name) => `(${name}>=${low} and ${name}<=${high})`);
  } else if (token.compare) {
    return undefined;
  } else if (token.canonical === 'status' && /^\dxx$/.test(token.value)) {
    const low = Number(token.value[0]) * 100;
    filters = names.map((name) => `(${name}>=${low} and ${name}<=${low + 99})`);
  } else if (token.canonical === 'level') {
    const code = LEVEL_CODES[token.value];
    const pattern = `(?i).*${literal(token.value)}.*${code ? `|${code}` : ''}`;
    filters = names.map((name) => `${name}${token.negate ? '!~' : '=~'}${quote(pattern)}`);
    return { kind: 'label', filter: token.negate ? all(filters) : any(filters) };
  } else {
    const pattern = valuePattern(typedValue(text, token));
    filters = names.map((name) => `${name}${token.negate ? '!~' : '=~'}${quote(pattern)}`);
    // A negated value must be in none of the names; a missing label is empty, so it matches.
    return { kind: 'label', filter: token.negate ? all(filters) : any(filters) };
  }
  // Numbers negated are left to Logline, which also matches logs without the field.
  return token.negate ? undefined : { kind: 'label', filter: any(filters) };
}

/**
 * A regular expression typed without a field, as a line filter: Logline's are RE2, as LogQL's are, and only
 * the case flag carries over.
 */
function regexFilter(text: string): string | undefined {
  const match = /^(-?)\/(.+)\/([a-z]*)$/.exec(text);
  if (!match || /[^i]/.test(match[3])) return undefined;
  return `${match[1] ? '!~' : '|~'} ${quote(`${match[3] ? '(?i)' : ''}${match[2]}`)}`;
}

/**
 * Translate a search into LogQL over `selector`, the connection's streams. A
 * search with OR is read whole and left to Logline, since one LogQL query reads
 * one set of streams through one pipeline.
 */
export function lokiQuery(input: string, selector = LOKI_SELECTOR): LokiQuery {
  const groups = termGroups(input);
  if (groups.length > 1) return { query: selector, pushed: [], local: groups.flat().map((term) => term.text) };
  const { branches, pushed, local } = pushDown(groups, (token, text) => term(token, text));
  const terms = branches[0] ?? [];
  const services = terms.flatMap((term) => (term.kind === 'service' ? [term.matcher] : []));
  const lines = terms.flatMap((term) => (term.kind === 'line' ? [term.filter] : []));
  // Regular expressions have no token for the shared translation; they become line filters here.
  for (const text of [...local]) {
    const filter =
      groups.length === 1 && groups[0].some((term) => term.text === text && !term.token) && regexFilter(text);
    if (!filter) continue;
    lines.push(filter);
    pushed.push(text);
    local.splice(local.indexOf(text), 1);
  }
  const filters = terms.flatMap((term) => (term.kind === 'label' ? [`| ${term.filter}`] : []));
  // Line filters come before the parser, so Loki reads only the lines that can match.
  const streams = services.length ? `{${services.join(', ')}}` : selector;
  const query = [streams, ...lines, ...(filters.length ? ['| json', ...filters] : [])].join(' ');
  return { query, pushed, local };
}

/** A query typed in LogQL: one that starts with `|` reads the connection's streams. */
export function nativeLokiQuery(input: string, selector = LOKI_SELECTOR): string {
  const text = input.trim();
  if (!text || text === '*') return selector;
  return text.startsWith('|') ? `${selector} ${text}` : text;
}
