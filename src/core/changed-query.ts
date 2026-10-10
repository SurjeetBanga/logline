import { queryTokens } from './query-tokens';

/** The query term that keeps only events from code changed since the last commit. */
export const CHANGED_TERM = 'changed:true';

const isOr = (token: string) => token === 'OR' || token === 'or';
const isChangedTerm = (token: string) => token.toLowerCase() === CHANGED_TERM;

function groups(query: string): string[][] {
  const result: string[][] = [[]];
  for (const token of queryTokens(query.trim())) {
    if (isOr(token)) result.push([]);
    else result.at(-1)!.push(token);
  }
  return result.filter((group) => group.length);
}

/** Whether every alternative of the query is limited to changed code. */
export function hasChangedScope(query: string): boolean {
  const parts = groups(query);
  return parts.length > 0 && parts.every((group) => group.some(isChangedTerm));
}

/**
 * Add `changed:true` to every alternative of a query, or remove it. Terms
 * combine with AND inside an `OR` alternative, so adding it once would only
 * narrow the last alternative.
 */
export function withChangedScope(query: string, on: boolean): string {
  const parts = groups(query).map((group) => group.filter((token) => !isChangedTerm(token)));
  const kept = parts.filter((group) => group.length);
  if (!on) return kept.map((group) => group.join(' ')).join(' OR ');
  if (!kept.length) return CHANGED_TERM;
  return kept.map((group) => [...group, CHANGED_TERM].join(' ')).join(' OR ');
}
