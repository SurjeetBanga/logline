// Lines up the errors of a production run with those of local runs, so a
// developer can tell whether a local run reproduces a production failure and
// whether a fix makes it go away. Errors are matched by their message with
// ids, numbers, and paths masked, because file paths and line numbers differ
// between machines and move when the code is fixed.
import { groupErrors, normalizeMessage, patternText, type ErrorGroup } from './log-analysis';
import type { LogEvent } from './types';

/**
 * - `reproduced`: in production and in the newest local run.
 * - `fixed`: in production and an earlier local run, but not the newest.
 * - `notSeen`: in production only.
 * - `new`: only in the newest local run, not in production or earlier runs.
 * - `localOnly`: in local runs, not in production.
 */
export type SignatureStatus = 'reproduced' | 'fixed' | 'notSeen' | 'new' | 'localOnly';

export interface SignatureRow {
  signature: string;
  /** The first message seen, from production when it has one. */
  message: string;
  pattern: string;
  /** Where a local run threw it, else where production did, as `file:line`. */
  location?: string;
  baseline: number;
  /** Occurrences in each local run, oldest first. */
  runs: number[];
  status: SignatureStatus;
  /** The newest run's occurrences come from code changed since the last commit. */
  changed?: boolean;
  /** An event of each side, to read side by side. */
  baselineSample?: number;
  localSample?: number;
  /** A search that finds the signature's events, when its message has enough literal text. */
  query?: string;
}

const ORDER: Record<SignatureStatus, number> = { reproduced: 0, fixed: 1, new: 2, localOnly: 3, notSeen: 4 };

interface Side {
  count: number;
  group: ErrorGroup;
}

function bySignature(events: LogEvent[]): Map<string, Side> {
  const sides = new Map<string, Side>();
  for (const group of groupErrors(events)) {
    const signature = normalizeMessage(group.message);
    const side = sides.get(signature);
    // Groups that differ only by call site in one run are one signature here.
    if (side) side.count += group.count;
    else sides.set(signature, { count: group.count, group });
  }
  return sides;
}

/**
 * Compare a baseline (production) with local runs, oldest first. `changed`
 * says whether an event comes from code changed since the last commit.
 */
export function compareSignatures(
  baseline: LogEvent[],
  runs: LogEvent[][],
  changed?: (event: LogEvent) => boolean,
  limit = 100,
): SignatureRow[] {
  const production = bySignature(baseline);
  const local = runs.map(bySignature);
  const newest = runs.length ? new Map(runs[runs.length - 1].map((event) => [event.id, event])) : new Map();
  const signatures = new Set([...production.keys(), ...local.flatMap((sides) => [...sides.keys()])]);
  const rows: SignatureRow[] = [];
  for (const signature of signatures) {
    const prod = production.get(signature);
    const sides = local.map((sides) => sides.get(signature));
    const counts = sides.map((side) => side?.count ?? 0);
    const latest = counts.at(-1) ?? 0;
    const earlier = counts.slice(0, -1).some((count) => count > 0);
    const status: SignatureStatus = prod
      ? latest
        ? 'reproduced'
        : earlier
          ? 'fixed'
          : 'notSeen'
      : latest && !earlier && runs.length > 1
        ? 'new'
        : 'localOnly';
    const localGroup = [...sides].reverse().find((side) => side)?.group;
    const group = prod?.group ?? localGroup!;
    const newestGroup = sides.at(-1)?.group;
    const sample = newestGroup?.sampleIds.map((id) => newest.get(id)).find(Boolean);
    rows.push({
      signature,
      message: group.message,
      pattern: patternText(group.message),
      ...(localGroup?.location || prod?.group.location
        ? { location: shortLocation(localGroup?.location ?? prod!.group.location!) }
        : {}),
      baseline: prod?.count ?? 0,
      runs: counts,
      status,
      ...(sample && changed?.(sample) ? { changed: true } : {}),
      ...(prod ? { baselineSample: prod.group.sampleIds[0] } : {}),
      ...(localGroup ? { localSample: localGroup.sampleIds[0] } : {}),
      ...(group.query ? { query: group.query } : {}),
    });
  }
  return rows
    .sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        b.baseline - a.baseline ||
        (b.runs.at(-1) ?? 0) - (a.runs.at(-1) ?? 0) ||
        a.signature.localeCompare(b.signature),
    )
    .slice(0, limit);
}

/** `file:line` without the directories, which differ between machines. */
function shortLocation(location: string): string {
  const separator = Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\'));
  return separator >= 0 ? location.slice(separator + 1) : location;
}

/** What the comparison means in a sentence, for a notification after a local run. */
export function summarizeComparison(rows: SignatureRow[]): string {
  const count = (status: SignatureStatus) => rows.filter((row) => row.status === status).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const fixed = count('fixed');
  const reproduced = count('reproduced');
  const fresh = rows.filter((row) => row.status === 'new');
  if (fixed) parts.push(`${plural(fixed, 'production error')} fixed locally`);
  if (reproduced) parts.push(`${plural(reproduced, 'production error')} reproduced`);
  if (fresh.length) {
    const changed = fresh.filter((row) => row.changed).length;
    const errors = plural(fresh.length, 'new local error');
    // "1 new local error from your changes", or "3 new local errors, 2 from your changes".
    parts.push(
      !changed
        ? errors
        : changed === fresh.length
          ? `${errors} from your changes`
          : `${errors}, ${changed} from your changes`,
    );
  }
  if (parts.length) return parts.join(' · ');
  return rows.some((row) => row.baseline > 0)
    ? 'None of the production errors occurred in the newest run.'
    : 'No errors in production or the newest run.';
}

/** Fields whose values differ between two events, for highlighting them side by side. */
export function differingFields(a: LogEvent, b: LogEvent): string[] {
  const left = a.fields ?? {};
  const right = b.fields ?? {};
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].filter(
    (name) => !(Object.hasOwn(left, name) && Object.hasOwn(right, name) && String(left[name]) === String(right[name])),
  );
}
