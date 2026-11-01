// What every connection's translation shares: a search split into its OR
// branches, each term either pushed to the store or left for Logline to apply
// to the fetched logs. A store may match more than the search, never fewer.
import { parseToken, type Token } from './query';
import { queryTokens } from './query-tokens';

// A regular expression term, with or without a field: this loop never pushes
// one to a store, so it is not parsed here, which would compile it for nothing.
export const REGEX_TERM = /^-?(?:@?[A-Za-z_][A-Za-z0-9_.]*:(?!\/\/))?\/.+\/[dgimsuvy]*$/;

/** A term as typed, and how Logline reads it; a regular expression has no token. */
export interface TypedTerm {
  text: string;
  token?: Token;
}

/** The query's terms as typed, grouped like parseQuery groups them. */
export function termGroups(input: string): TypedTerm[][] {
  const groups: TypedTerm[][] = [[]];
  for (const text of queryTokens(input.slice(0, 1024))) {
    if (text === 'OR' || text === 'or') groups.push([]);
    else if (REGEX_TERM.test(text)) groups.at(-1)!.push({ text });
    // The text is one token already, so it is parsed as one rather than tokenized again.
    else groups.at(-1)!.push({ text, token: parseToken(text) });
  }
  return groups.filter((group) => group.length);
}

/**
 * The value as typed. The parser lowercases values because Logline compares
 * them without case; stores that compare with case need what was typed.
 */
export function typedValue(text: string, token: Token): string {
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

export interface Pushdown<T> {
  /** The pushed terms of each OR branch, in order. */
  branches: T[][];
  pushed: string[];
  local: string[];
  /**
   * A branch the store cannot narrow, which makes the whole OR unnarrowable:
   * the caller then fetches everything, and `pushed` and `local` already say so.
   */
  unrestricted: boolean;
}

/**
 * Translate each term with `emit`, which returns the store's term, `'taken'`
 * for a term the caller applies another way, such as a time term taken as its
 * range, or undefined when the store cannot say. A taken term narrows a search
 * only without OR, since in one branch it would narrow every branch.
 */
export function pushDown<T>(
  groups: TypedTerm[][],
  emit: (token: Token, text: string, branches: number) => T | 'taken' | undefined,
): Pushdown<T> {
  const pushed = new Set<string>();
  const local = new Set<string>();
  const branches: T[][] = [];
  let unrestricted = false;
  for (const group of groups) {
    const terms: T[] = [];
    let narrowed = false;
    for (const { text, token } of group) {
      const result = token && emit(token, text, groups.length);
      if (result === 'taken' && groups.length === 1) {
        pushed.add(text);
        narrowed = true;
      } else if (result !== undefined && result !== 'taken') {
        terms.push(result);
        pushed.add(text);
        narrowed = true;
      } else local.add(text);
    }
    if (!narrowed) unrestricted = true;
    branches.push(terms);
  }
  if (unrestricted) return { branches, pushed: [], local: groups.flat().map((term) => term.text), unrestricted };
  return { branches, pushed: [...pushed], local: [...local], unrestricted };
}
