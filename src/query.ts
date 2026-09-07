import type { LogEvent } from './types';

// Names that mean the same thing across logging libraries. A field filter tries
// the name exactly as typed first and only then the rest of its group, so
// `statusCode:200` works whether the log calls the field `status` or
// `statusCode`. Rewriting the name up front instead would break the common case
// where the user types what the column header shows.
const FIELD_GROUPS: string[][] = [
  ['level', 'severity'],
  ['message', 'msg'],
  ['status', 'statusCode', 'status_code'],
  ['service', 'service_name', 'serviceName'],
  ['requestId', 'request_id'],
  ['traceId', 'trace_id'],
  ['spanId', 'span_id'],
  ['durationMs', 'duration', 'duration_ms']
];

export interface Token {
  negate: boolean;
  field?: string;
  canonical?: string;
  value: string;
  regex?: RegExp | null;
}
export type TokenGroup = Token[];
export type ParsedQuery = TokenGroup[];
type FieldValue = string | number | boolean | undefined;

function groupFor(field: string): string[] | undefined {
  const lower = String(field).toLowerCase();
  return FIELD_GROUPS.find(names => names.some(name => name.toLowerCase() === lower));
}

export function canonicalField(field: string): string {
  return groupFor(field)?.[0] ?? field;
}

export function parseQuery(input = ''): ParsedQuery {
  const normalized = input.replace(/\[([^\]]+)\]/g, (_, value) => `[${value.replace(/\s+TO\s+/i, '__TO__')}]`);
  const tokens = (normalized.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map(token => token.replace('__TO__', ' TO '));
  const groups: TokenGroup[] = [[]];
  for (const token of tokens) {
    if (token === 'OR' || token === 'or') groups.push([]);
    else groups.at(-1)!.push(parseToken(token));
  }
  return groups.filter(group => group.length);
}

function parseToken(token: string): Token {
  let negate = token.startsWith('-');
  if (negate) token = token.slice(1);
  // Only a bare identifier before the colon names a field, so pasted values that
  // contain a colon (URLs, timestamps, "host:port") stay free-text searches.
  const match = token.match(/^@?([A-Za-z_][A-Za-z0-9_.]*):(.+)$/);
  let field: string | undefined;
  let value = token;
  if (match && !match[2].startsWith('//')) {
    field = match[1];
    value = match[2];
  }
  const canonical = field === undefined ? undefined : canonicalField(field);
  value = value.replace(/^"|"$/g, '');
  if (canonical !== 'exists') value = value.toLowerCase();
  // Compiled once here, at parse time, rather than once per event in matchesQuery.
  let regex: RegExp | null | undefined;
  if (value.startsWith('/') && value.lastIndexOf('/') > 0) {
    const end = value.lastIndexOf('/');
    try { regex = new RegExp(value.slice(1, end), value.slice(end + 1)); } catch { regex = null; }
  }
  return { negate, field, canonical, value, regex };
}

export function matchesQuery(event: LogEvent, input: string | ParsedQuery): boolean {
  const groups = Array.isArray(input) ? input : parseQuery(input);
  if (!groups.length) return true;
  return groups.some(group => group.every(token => {
    if (token.canonical === 'last') {
      const match = token.value.match(/^(\d+)(s|m|h|d)$/);
      const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      const matched = match ? (event.timestampMs ?? 0) >= Date.now() - Number(match[1]) * units[match[2]] : false;
      return token.negate ? !matched : matched;
    }
    if (token.canonical === 'exists') {
      const present = getField(event, token.value) !== undefined;
      return token.negate ? !present : present;
    }
    if (token.canonical === 'timestamp' || token.canonical === 'time') {
      const range = token.value.match(/^\[([^\s]+)\s+TO\s+([^\]]+)\]$/i);
      let matched: boolean;
      if (range) matched = (event.timestampMs ?? 0) >= Date.parse(range[1]) && (event.timestampMs ?? 0) <= Date.parse(range[2]);
      else matched = (event.timestamp ?? '').toLowerCase().includes(token.value);
      return token.negate ? !matched : matched;
    }
    let actualValue: FieldValue = token.field ? getField(event, token.field) : `${event.level} ${event.message} ${event.raw}`;
    const actual = String(actualValue ?? '').toLowerCase();
    let matched: boolean | undefined;
    const numeric = actual === '' ? NaN : Number(actual);
    const isNumeric = Number.isFinite(numeric);
    if (token.regex !== undefined) {
      // Global and sticky expressions carry a cursor between calls.
      if (token.regex) token.regex.lastIndex = 0;
      matched = token.regex ? token.regex.test(actual) : false;
    } else if (token.field && isNumeric && /^(>=|<=|>|<)\s*-?\d+(?:\.\d+)?$/.test(token.value)) {
      const operator = token.value.match(/^(>=|<=|>|<)/)![1];
      const target = Number(token.value.slice(operator.length));
      matched = operator === '>' ? numeric > target : operator === '>=' ? numeric >= target : operator === '<' ? numeric < target : numeric <= target;
    } else if (token.field && isNumeric && /^\[.*\s+to\s+.*\]$/.test(token.value)) {
      const range = token.value.slice(1, -1).split(/\s+to\s+/);
      matched = numeric >= Number(range[0]) && numeric <= Number(range[1]);
    }
    if (matched === undefined) {
      if (token.canonical === 'status' && /^\dxx$/.test(token.value)) matched = actual.startsWith(token.value[0]);
      else if (token.canonical === 'status' && /^\d{3}$/.test(token.value)) matched = actual === token.value;
      else matched = actual.includes(token.value);
    }
    return token.negate ? !matched : matched;
  }));
}

// 'time' has no matching `.time` property on LogEvent (only `.timestamp`
// does) — this always returns undefined for it, same as the original
// `event[field]` lookup did. The 'timestamp'/'time' canonical fields are
// actually handled earlier in matchesQuery, so this path is effectively only
// reachable via `exists:time`, which was already a no-op before this file
// had types.
function readField(event: LogEvent, field: string): FieldValue {
  if (field === 'level') return event.level;
  if (field === 'message') return event.message;
  if (field === 'stream') return event.stream;
  if (field === 'timestamp') return event.timestamp;
  if (field === 'time') return undefined;
  return event.fields?.[field];
}

export function getField(event: LogEvent, field: string): FieldValue {
  const direct = readField(event, field);
  if (direct !== undefined) return direct;
  for (const name of groupFor(field) ?? []) {
    const value = readField(event, name);
    if (value !== undefined) return value;
  }
  return undefined;
}
