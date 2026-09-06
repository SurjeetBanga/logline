// Names that mean the same thing across logging libraries. A field filter tries
// the name exactly as typed first and only then the rest of its group, so
// `statusCode:200` works whether the log calls the field `status` or
// `statusCode`. Rewriting the name up front instead would break the common case
// where the user types what the column header shows.
const FIELD_GROUPS = [
  ['level', 'severity'],
  ['message', 'msg'],
  ['status', 'statusCode', 'status_code'],
  ['service', 'service_name', 'serviceName'],
  ['requestId', 'request_id'],
  ['traceId', 'trace_id'],
  ['spanId', 'span_id'],
  ['durationMs', 'duration', 'duration_ms']
];

function groupFor(field) {
  const lower = String(field).toLowerCase();
  return FIELD_GROUPS.find(names => names.some(name => name.toLowerCase() === lower));
}

function canonicalField(field) {
  return groupFor(field)?.[0] ?? field;
}

function parseQuery(input = '') {
  const normalized = input.replace(/\[([^\]]+)\]/g, (_, value) => `[${value.replace(/\s+TO\s+/i, '__TO__')}]`);
  const tokens = (normalized.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map(token => token.replace('__TO__', ' TO '));
  const groups = [[]];
  for (const token of tokens) {
    if (token === 'OR' || token === 'or') groups.push([]);
    else groups.at(-1).push(parseToken(token));
  }
  return groups.filter(group => group.length);
}

function parseToken(token) {
  let negate = token.startsWith('-');
  if (negate) token = token.slice(1);
  // Only a bare identifier before the colon names a field, so pasted values that
  // contain a colon (URLs, timestamps, "host:port") stay free-text searches.
  const match = token.match(/^@?([A-Za-z_][A-Za-z0-9_.]*):(.+)$/);
  let field;
  let value = token;
  if (match && !match[2].startsWith('//')) {
    field = match[1];
    value = match[2];
  }
  const canonical = field === undefined ? undefined : canonicalField(field);
  value = value.replace(/^"|"$/g, '');
  if (canonical !== 'exists') value = value.toLowerCase();
  return { negate, field, canonical, value };
}

function matchesQuery(event, input) {
  const groups = Array.isArray(input) ? input : parseQuery(input);
  if (!groups.length) return true;
  return groups.some(group => group.every(token => {
    if (token.canonical === 'last') {
      const match = token.value.match(/^(\d+)(s|m|h|d)$/);
      const matched = match ? event.timestampMs >= Date.now() - Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 })[match[2]] : false;
      return token.negate ? !matched : matched;
    }
    if (token.canonical === 'exists') {
      const present = getField(event, token.value) !== undefined;
      return token.negate ? !present : present;
    }
    if (token.canonical === 'timestamp' || token.canonical === 'time') {
      const range = token.value.match(/^\[([^\s]+)\s+TO\s+([^\]]+)\]$/i);
      let matched;
      if (range) matched = event.timestampMs >= Date.parse(range[1]) && event.timestampMs <= Date.parse(range[2]);
      else matched = event.timestamp.toLowerCase().includes(token.value);
      return token.negate ? !matched : matched;
    }
    let actual = token.field ? getField(event, token.field) : `${event.level} ${event.message} ${event.raw}`;
    actual = String(actual ?? '').toLowerCase();
    let matched;
    const numeric = actual === '' ? NaN : Number(actual);
    const isNumeric = Number.isFinite(numeric);
    if (token.value.startsWith('/') && token.value.lastIndexOf('/') > 0) {
      const end = token.value.lastIndexOf('/');
      try { matched = new RegExp(token.value.slice(1, end), token.value.slice(end + 1)).test(String(actual)); } catch { matched = false; }
    } else if (token.field && isNumeric && /^(>=|<=|>|<)\s*-?\d+(?:\.\d+)?$/.test(token.value)) {
      const operator = token.value.match(/^(>=|<=|>|<)/)[1];
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

function readField(event, field) {
  if (field === 'level' || field === 'message' || field === 'stream' || field === 'timestamp' || field === 'time') return event[field];
  return event.fields?.[field];
}

function getField(event, field) {
  const direct = readField(event, field);
  if (direct !== undefined) return direct;
  for (const name of groupFor(field) ?? []) {
    const value = readField(event, name);
    if (value !== undefined) return value;
  }
}

module.exports = { parseQuery, matchesQuery, getField, canonicalField };
