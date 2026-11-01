// Turns a Logline search into a CloudWatch Logs filter pattern, matching as
// CloudWatch does: a field of a JSON log matches its whole value, with case,
// unless the value has a `*`, and a word matches with case. A pattern is
// either a JSON pattern or a text pattern, never both, so a search with fields
// sends them and leaves its words to Logline. Fetched logs are filtered again
// with the whole search, so what CloudWatch cannot express still applies.
import { pushDown, termGroups, typedValue } from './pushdown';
import { canonicalField, type Token } from './query';

export interface CloudWatchQuery {
  /** The filter pattern; empty matches every log. */
  pattern: string;
  pushed: string[];
  local: string[];
  /** Service names the search asks for, which choose the log groups to read; every group when left out. */
  services?: string[];
}

// The names a field goes by across logging libraries, as Logline reads them, for fields a pattern names.
const NAMES: Record<string, string[]> = {
  level: ['level', 'severity', 'log.level', 'severityText'],
  message: ['message', 'msg'],
  status: ['status', 'statusCode', 'status_code', 'http.response.status_code', 'http.status_code'],
  traceId: ['traceId', 'trace_id', 'trace.id'],
  durationMs: ['durationMs', 'duration', 'duration_ms', 'responseTime'],
};

/** Each Logline level as JSON logs write it, CloudWatch comparing with case; pino and bunyan write numbers. */
const LEVELS: Record<string, (string | number)[]> = {
  fatal: ['fatal', 'FATAL', 'Fatal', 'critical', 'CRITICAL', 'Critical', 60],
  error: ['error', 'ERROR', 'Error', 50],
  warn: ['warn', 'WARN', 'Warn', 'warning', 'WARNING', 'Warning', 40],
  info: ['info', 'INFO', 'Info', 30],
  debug: ['debug', 'DEBUG', 'Debug', 20],
  trace: ['trace', 'TRACE', 'Trace', 10],
};

const SELECTOR = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const quote = (value: string) => JSON.stringify(value);
const any = (terms: string[]) => (terms.length === 1 ? terms[0] : `(${terms.join(' || ')})`);

/** The JSON paths a field term looks at, or undefined for a name a pattern cannot say. */
function paths(token: Token): string[] | undefined {
  const name = token.field!.replace(/^@/, '');
  const known = NAMES[token.canonical ?? canonicalField(name)];
  const names = known ? [...new Set([name, ...known])] : [name];
  return names.every((candidate) => SELECTOR.test(candidate)) ? names.map((candidate) => `$.${candidate}`) : undefined;
}

/** A field term as a JSON pattern condition, or undefined when CloudWatch cannot say it. */
function jsonTerm(token: Token, text: string): string | undefined {
  // A negated term matches logs without the field too, which a JSON pattern cannot promise; Logline applies it.
  if (token.field === undefined || token.negate || token.changed !== undefined || token.regex !== undefined)
    return undefined;
  if (['last', 'timestamp', 'time', 'exists', 'service'].includes(token.canonical ?? '')) return undefined;
  const fields = paths(token);
  if (!fields) return undefined;
  let condition: string | undefined;
  if (token.numericComparison) {
    const { operator, target } = token.numericComparison;
    if (['>', '>=', '<', '<='].includes(operator))
      condition = any(fields.map((field) => `${field} ${operator} ${target}`));
  } else if (token.numericRange) {
    const [low, high] = token.numericRange;
    condition = any(fields.map((field) => `(${field} >= ${low} && ${field} <= ${high})`));
  } else if (token.compare) {
    condition = undefined;
  } else if (token.canonical === 'level') {
    const spellings = LEVELS[token.value];
    if (spellings)
      condition = any(
        fields.flatMap((field) =>
          spellings.map((value) => `${field} = ${typeof value === 'number' ? value : quote(value)}`),
        ),
      );
  } else if (token.canonical === 'status' && /^\dxx$/.test(token.value)) {
    const low = Number(token.value[0]) * 100;
    condition = any(fields.map((field) => `(${field} >= ${low} && ${field} <= ${low + 99})`));
  } else {
    const value = typedValue(text, token);
    // A number may be written as one or as text.
    condition = any(
      fields.flatMap((field) =>
        NUMBER.test(value) ? [`${field} = ${value}`, `${field} = ${quote(value)}`] : [`${field} = ${quote(value)}`],
      ),
    );
  }
  return condition;
}

/** Free text as a text pattern term: the words as typed, which CloudWatch matches with case. */
function textTerm(token: Token, text: string): string | undefined {
  if (token.field !== undefined || token.regex !== undefined || !token.value) return undefined;
  return `${token.negate ? '-' : ''}${quote(typedValue(text, token))}`;
}

/** The services a `service:` term names, which choose log groups rather than a pattern. */
function serviceTerm(token: Token, text: string): string | undefined {
  if (token.canonical !== 'service' || token.negate || token.compare || token.numericComparison) return undefined;
  return typedValue(text, token);
}

/** Translate a search into a CloudWatch filter pattern; empty when CloudWatch cannot narrow it. */
export function cloudwatchQuery(input: string): CloudWatchQuery {
  const groups = termGroups(input);
  const services: string[] = [];
  // A JSON pattern when any field can be said in one; words are then left to Logline.
  const json = groups.some((group) => group.some(({ text, token }) => token && jsonTerm(token, text)));
  const { branches, pushed, local, unrestricted } = pushDown(groups, (token, text, count) => {
    const service = count === 1 ? serviceTerm(token, text) : undefined;
    if (service !== undefined) {
      services.push(service);
      return 'taken';
    }
    return json ? jsonTerm(token, text) : textTerm(token, text);
  });
  const chosen = services.length ? { services } : {};
  if (unrestricted || !branches.length) return { pattern: '', pushed: unrestricted ? [] : pushed, local, ...chosen };
  if (json) {
    const all = branches.map((terms) => (terms.length === 1 ? terms[0] : `(${terms.join(' && ')})`));
    // A branch of only a service term matches every log of its groups.
    if (branches.some((terms) => !terms.length)) return { pattern: '', pushed, local, ...chosen };
    return { pattern: `{ ${all.length === 1 ? all[0] : all.join(' || ')} }`, pushed, local, ...chosen };
  }
  if (branches.length === 1) {
    // A pattern of only exclusions is not one CloudWatch takes.
    if (branches[0].length && branches[0].every((term) => term.startsWith('-')))
      return { pattern: '', pushed: [], local: groups.flat().map((term) => term.text), ...chosen };
    return { pattern: branches[0].join(' '), pushed, local, ...chosen };
  }
  // Text patterns say OR only of single words, each marked with `?`.
  if (branches.every((terms) => terms.length === 1 && !terms[0].startsWith('-')))
    return { pattern: branches.map((terms) => `?${terms[0]}`).join(' '), pushed, local, ...chosen };
  return { pattern: '', pushed: [], local: groups.flat().map((term) => term.text), ...chosen };
}
