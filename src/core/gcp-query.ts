// Turns a Logline search into the Logging query language of Google Cloud.
// Fields of a JSON payload, and the entry's own fields, match any part of a
// value without case, through RE2 regular expressions as Logline matches
// them; `level:` is the entry's severity; words are searched as Cloud Logging
// searches them. In this language OR binds tighter than AND, so every group
// is in parentheses. Fetched logs are filtered again with the whole search.
import { pushDown, termGroups, typedValue } from './pushdown';
import { canonicalField, type Token } from './query';

export interface GcpQuery {
  /** The query; empty matches every entry. */
  filter: string;
  pushed: string[];
  local: string[];
}

/** The fields at the top of a log entry; any other field is one of its JSON payload's. */
const ENTRY_FIELDS = new Set([
  'timestamp',
  'receiveTimestamp',
  'severity',
  'logName',
  'resource',
  'labels',
  'httpRequest',
  'jsonPayload',
  'textPayload',
  'protoPayload',
  'trace',
  'spanId',
  'insertId',
  'operation',
  'sourceLocation',
]);
// The names a field goes by across logging libraries, in a JSON payload.
const NAMES: Record<string, string[]> = {
  message: ['textPayload', 'jsonPayload.message', 'jsonPayload.msg'],
  status: ['httpRequest.status', 'jsonPayload.status', 'jsonPayload.statusCode', 'jsonPayload.status_code'],
  traceId: ['trace', 'jsonPayload.traceId', 'jsonPayload.trace_id'],
  durationMs: ['jsonPayload.durationMs', 'jsonPayload.duration', 'jsonPayload.duration_ms', 'jsonPayload.responseTime'],
};
/** Logline's levels as Cloud Logging's severities. */
const SEVERITIES: Record<string, string> = {
  fatal: 'severity>=CRITICAL',
  error: 'severity=ERROR',
  warn: 'severity=WARNING',
  info: '(severity=INFO OR severity=NOTICE)',
  debug: 'severity=DEBUG',
};

const quote = (value: string) => JSON.stringify(value);
const regexOf = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
/** Any part of a value without case, unless it has `*`: then the whole value. */
const contains = (value: string) => quote(value.includes('*') ? `(?i)^${regexOf(value)}$` : `(?i)${regexOf(value)}`);
const any = (terms: string[]) => (terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`);

/** A path in the query language, each name quoted that is not a plain identifier. */
function path(name: string): string | undefined {
  const parts = name.split('.');
  if (parts.some((part) => !part)) return undefined;
  const full = ENTRY_FIELDS.has(parts[0]) ? parts : ['jsonPayload', ...parts];
  return full.map((part) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : quote(part))).join('.');
}

/** The paths a field term looks at: its own, and the usual names of its kind. */
function paths(token: Token, serviceField: string): string[] | undefined {
  const name = token.field!.replace(/^@/, '');
  const canonical = token.canonical ?? canonicalField(name);
  const own = path(name);
  if (!own) return undefined;
  if (canonical === 'service') return [...new Set([serviceField, own])];
  return [...new Set([own, ...(NAMES[canonical] ?? [])])];
}

function term(token: Token, text: string, serviceField: string): string | undefined {
  if (token.changed !== undefined) return undefined;
  if (['last', 'timestamp', 'time'].includes(token.canonical ?? '')) return undefined;
  let condition: string | undefined;
  if (token.field === undefined) {
    // Words are searched as Cloud Logging searches them, in every field.
    if (!token.value || token.regex !== undefined) return undefined;
    condition = quote(typedValue(text, token));
  } else if (token.canonical === 'exists') {
    const where = path(token.value);
    if (!where) return undefined;
    condition = `${where}:*`;
  } else {
    const fields = paths(token, serviceField);
    if (!fields) return undefined;
    if (token.regex !== undefined) {
      return undefined;
    } else if (token.numericComparison) {
      const { operator, target } = token.numericComparison;
      if (!['>', '>=', '<', '<='].includes(operator)) return undefined;
      condition = any(fields.map((field) => `${field}${operator}${target}`));
    } else if (token.numericRange) {
      const [low, high] = token.numericRange;
      condition = any(fields.map((field) => `(${field}>=${low} AND ${field}<=${high})`));
    } else if (token.compare) {
      return undefined;
    } else if (token.canonical === 'status' && /^\dxx$/.test(token.value)) {
      const low = Number(token.value[0]) * 100;
      condition = any(fields.map((field) => `(${field}>=${low} AND ${field}<=${low + 99})`));
    } else if (token.canonical === 'level') {
      // The entry's severity, or a level the payload names itself.
      const severity = SEVERITIES[token.value];
      const named = fields.filter((field) => field !== 'severity').map((field) => `${field}=~${contains(token.value)}`);
      condition = any([...(severity ? [severity] : []), ...named]);
    } else {
      const value = typedValue(text, token);
      condition = any(
        fields.flatMap((field) =>
          /^-?\d+(?:\.\d+)?$/.test(value)
            ? [`${field}=~${contains(value)}`, `${field}=${value}`]
            : [`${field}=~${contains(value)}`],
        ),
      );
    }
  }
  // NOT also matches entries without the field, as Logline does.
  return token.negate ? `NOT ${condition.startsWith('(') ? condition : `(${condition})`}` : condition;
}

/**
 * A field's regular expression, which has no token for the shared translation: RE2 on both sides, and only
 * the case flag carries over.
 */
function regexTerm(text: string, serviceField: string): string | undefined {
  const match = /^(-?)@?([A-Za-z_][A-Za-z0-9_.]*):\/(.+)\/([a-z]*)$/.exec(text);
  if (!match || /[^i]/.test(match[4])) return undefined;
  const [, not, name, source, flags] = match;
  const fields = paths(
    { negate: false, field: name, canonical: canonicalField(name), value: '' } as Token,
    serviceField,
  );
  if (!fields) return undefined;
  const condition = any(fields.map((field) => `${field}=~${quote(`${flags ? '(?i)' : ''}${source}`)}`));
  return not ? `NOT ${condition.startsWith('(') ? condition : `(${condition})`}` : condition;
}

/** Translate a search into the Logging query language; empty when it cannot be narrowed. */
export function gcpQuery(input: string, serviceField = 'resource.labels.service_name'): GcpQuery {
  const groups = termGroups(input);
  const { branches, pushed, local, unrestricted } = pushDown(groups, (token, text) => term(token, text, serviceField));
  // A field's regular expression joins a search without OR.
  if (groups.length === 1)
    for (const text of [...local]) {
      const condition = !groups[0].find((typed) => typed.text === text)?.token && regexTerm(text, serviceField);
      if (!condition) continue;
      (branches[0] ??= []).push(condition);
      pushed.push(text);
      local.splice(local.indexOf(text), 1);
    }
  if ((unrestricted && !pushed.length) || !branches.length || !branches[0]?.length)
    return { filter: '', pushed, local };
  const and = (terms: string[]) => (terms.length === 1 ? terms[0] : `(${terms.join(' AND ')})`);
  return { filter: branches.length === 1 ? branches[0].join(' AND ') : any(branches.map(and)), pushed, local };
}

/** A query to send: the connection's own filter, the time range, and the search, each in parentheses. */
export function gcpFilter(parts: { base?: string; fromMs: number; toMs: number; query: string }): string {
  return [
    parts.base ? `(${parts.base})` : '',
    `timestamp>=${quote(new Date(parts.fromMs).toISOString())}`,
    `timestamp<=${quote(new Date(parts.toMs).toISOString())}`,
    parts.query.trim() ? `(${parts.query.trim()})` : '',
  ]
    .filter(Boolean)
    .join(' AND ');
}
