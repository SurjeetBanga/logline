// Turns a Logline search into Datadog log search syntax, matching as Datadog
// does: a field value is matched whole unless it has a `*`, and a word is a
// word of the message. Fetched logs are filtered again with the whole search,
// so terms Datadog cannot express (regular expressions, `changed:`) still apply.
import { parseQuery, type Token } from './query';
import { queryTokens } from './query-tokens';

// Characters with a meaning in Datadog's search syntax, escaped in values.
const SPECIAL = /[+\-=&|><!(){}[\]^"“”~*?:\\/\s]/g;
const escape = (value: string) => value.replace(SPECIAL, (character) => `\\${character}`);
/** A value with its special characters escaped, except `*`, which stays Datadog's wildcard. */
const pattern = (value: string) => value.replace(SPECIAL, (character) => (character === '*' ? '*' : `\\${character}`));
// A Logline field that Datadog keeps as a reserved attribute rather than under `@`.
const RESERVED: Record<string, string> = { service: 'service', host: 'host', source: 'source', traceId: 'trace_id' };
const REGEX_TERM = /^-?(?:@?[A-Za-z_][A-Za-z0-9_.]*:(?!\/\/))?\/.+\/[dgimsuvy]*$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Text in the message. Datadog matches whole words and Logline any part of the text, so a word becomes a
 * wildcard term; a phrase is matched as a phrase.
 */
function text(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"` : `*${escape(value)}*`;
}

/**
 * Free text: a word of the message, as Datadog searches it, which is far quicker for Datadog than a part of
 * every attribute; `*` is a wildcard. A phrase is matched as a phrase.
 */
function words(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"` : pattern(value);
}

/** Datadog levels, which Datadog calls statuses, for each Logline level. */
const STATUSES: Record<string, string[]> = {
  fatal: ['emergency', 'alert', 'critical'],
  error: ['error'],
  warn: ['warn', 'warning'],
  info: ['info', 'notice'],
  debug: ['debug'],
  trace: ['trace'],
};

function attribute(name: string): string {
  // An attribute name keeps its dots (`@http.url`) and loses anything that would end the term.
  return `@${name.replace(/[^A-Za-z0-9_.\-@]/g, '_')}`;
}

/**
 * The value as typed. The parser lowercases values because Logline compares
 * them without case, but Datadog compares attribute values with case.
 */
function typedValue(text: string, token: Token): string {
  let value = text.replace(/^-/, '');
  if (token.field !== undefined) value = value.slice(value.indexOf(':') + 1);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  return value.toLowerCase() === token.value ? value : token.value;
}

/**
 * The term in Datadog syntax, matched as Datadog matches it, or undefined when Datadog cannot say. A field
 * typed with `@` is an attribute; one typed without is a tag or an attribute, as `env:prod` is a tag in Datadog.
 */
function term(token: Token, input: string): string | undefined {
  const typed = typedValue(input, token);
  const at = input.replace(/^-/, '').startsWith('@');
  const quoted = input.endsWith('"');
  if (token.changed !== undefined || token.regex !== undefined) return undefined;
  if (token.canonical === 'last' || token.canonical === 'timestamp' || token.canonical === 'time') return undefined;
  const not = token.negate ? '-' : '';
  if (token.canonical === 'exists') return `${not}${attribute(token.value)}:*`;
  if (token.field === undefined) return token.value ? `${not}${words(typed)}` : undefined;
  const canonical = token.canonical ?? token.field;
  if (canonical === 'level') {
    // Logline matches a part of the level (`warn` matches `warning`); statuses are few, so list them.
    const statuses = Object.entries(STATUSES)
      .filter(([level, names]) => level.includes(token.value) || names.some((name) => name.includes(token.value)))
      .flatMap(([, names]) => names);
    if (!statuses.length) return `${not}status:${escape(token.value)}`;
    return `${not}status:(${[...new Set(statuses)].join(' OR ')})`;
  }
  if (canonical === 'status') {
    // HTTP status: Datadog's `status` is the level.
    if (/^\dxx$/.test(token.value)) return `${not}@http.status_code:[${token.value[0]}00 TO ${token.value[0]}99]`;
    if (token.numericComparison)
      return `${not}@http.status_code:${token.numericComparison.operator}${token.numericComparison.target}`;
    if (NUMBER.test(token.value)) return `${not}@http.status_code:${token.value}`;
    return undefined;
  }
  if (canonical === 'message') return token.value ? `${not}${text(typed)}` : undefined;
  const reserved = !at && Object.hasOwn(RESERVED, canonical);
  const name = reserved ? RESERVED[canonical] : attribute(token.field);
  if (token.numericComparison) {
    const { operator, target } = token.numericComparison;
    return `${not}${name}:${operator}${target}`;
  }
  if (token.numericRange) return `${not}${name}:[${token.numericRange[0]} TO ${token.numericRange[1]}]`;
  if (token.compare || !token.value) return undefined;
  // The whole value, as Datadog matches it; a quoted value is taken as it is, `*` and all.
  const value = NUMBER.test(token.value) ? token.value : quoted ? escape(typed) : pattern(typed);
  if (reserved || at) return `${not}${name}:${value}`;
  const tag = token.field.replace(/[^A-Za-z0-9_.\-]/g, '_');
  return not ? `-${tag}:${value} -${name}:${value}` : `(${tag}:${value} OR ${name}:${value})`;
}

export interface DatadogQuery {
  query: string;
  pushed: string[];
  local: string[];
}

/** Translate a search into Datadog log search syntax; `*` when Datadog cannot narrow it. */
export function datadogQuery(input: string): DatadogQuery {
  const groups: { text: string; token?: Token }[][] = [[]];
  for (const text of queryTokens(input.slice(0, 1024))) {
    if (text === 'OR' || text === 'or') groups.push([]);
    else if (REGEX_TERM.test(text)) groups.at(-1)!.push({ text });
    else {
      const token = parseQuery(text)[0]?.[0];
      if (token) groups.at(-1)!.push({ text, token });
    }
  }
  const pushed = new Set<string>();
  const local = new Set<string>();
  const alternatives: string[] = [];
  let unrestricted = false;
  for (const group of groups.filter((candidate) => candidate.length)) {
    const terms: string[] = [];
    for (const { text, token } of group) {
      const translated = token && term(token, text);
      if (translated) {
        terms.push(translated);
        pushed.add(text);
      } else local.add(text);
    }
    if (!terms.length) unrestricted = true;
    alternatives.push(terms.join(' '));
  }
  if (unrestricted || !alternatives.length)
    return { query: '*', pushed: [], local: groups.flat().map((term) => term.text) };
  return {
    query: alternatives.length === 1 ? alternatives[0] : alternatives.map((terms) => `(${terms})`).join(' OR '),
    pushed: [...pushed],
    local: [...local],
  };
}

export interface DatadogLink {
  /** The Log Explorer's own query, in Datadog syntax. */
  query?: string;
  fromMs?: number;
  toMs?: number;
  /** The log the link points at. */
  eventId?: string;
  traceId?: string;
}

/**
 * Read what a person pastes to find logs: a Log Explorer link (its query,
 * time range, and selected log), or a trace id.
 */
export function parseDatadogLink(input: string, now = Date.now()): DatadogLink | undefined {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(text)) return { traceId: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const params = url.searchParams;
  const time = (name: string) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const link: DatadogLink = {};
  const query = params.get('query');
  if (query) link.query = query;
  const event = params.get('event');
  if (event && /^[A-Za-z0-9_-]{1,256}$/.test(event)) link.eventId = event;
  const fromMs = time('from_ts');
  const toMs = time('to_ts');
  if (fromMs !== undefined) link.fromMs = fromMs;
  if (toMs !== undefined) link.toMs = toMs;
  // A link without a window covers the last day.
  if (link.fromMs === undefined && (link.query || link.eventId)) {
    link.toMs ??= now;
    link.fromMs = link.toMs - 86400000;
  }
  return link.query || link.eventId ? link : undefined;
}
