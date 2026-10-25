import { getField } from './query';
import type { LogEvent } from './types';

export function fieldValue(event: LogEvent, field: string): unknown {
  if (field === 'id') return event.id;
  if (field === 'timestampMs') return event.timestampMs;
  return getField(event, field);
}
const valueCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// A sort key read once per event. Comparators otherwise resolve the field (and
// its aliases) and coerce it to a number twice per comparison, n log n times.
export interface SortKey {
  event: LogEvent;
  empty: boolean;
  number: number;
  text: string;
}

function sortKey(event: LogEvent, field: string): SortKey {
  const value = fieldValue(event, field);
  const empty = value === undefined || value === null || value === '';
  const number = empty ? NaN : typeof value === 'number' ? value : Number(value);
  return { event, empty, number, text: empty ? '' : String(value) };
}

function compareKeys(a: SortKey, b: SortKey, sign: number): number {
  if (a.empty) return b.empty ? a.event.id - b.event.id : 1;
  if (b.empty) return -1;
  if (Number.isFinite(a.number) && Number.isFinite(b.number))
    return sign * (a.number - b.number || a.event.id - b.event.id);
  return sign * valueCollator.compare(a.text, b.text) || a.event.id - b.event.id;
}

/** Sort in place, preserving the array identity callers rely on. */
export function sortEvents(events: LogEvent[], field: string, direction: 'asc' | 'desc' = 'asc'): LogEvent[] {
  const sign = direction === 'desc' ? -1 : 1;
  const keys = events.map((event) => sortKey(event, field)).sort((a, b) => compareKeys(a, b, sign));
  for (let i = 0; i < keys.length; i++) events[i] = keys[i].event;
  return events;
}

/** Sort events, returning each with its key, so later merges need not read the field again. */
export function sortedKeys(events: readonly LogEvent[], field: string, direction: 'asc' | 'desc' = 'asc'): SortKey[] {
  const sign = direction === 'desc' ? -1 : 1;
  return events.map((event) => sortKey(event, field)).sort((a, b) => compareKeys(a, b, sign));
}

/**
 * Merge new events into keys from sortedKeys with the same field and direction,
 * reading the field only for the new events. Returns a new array.
 */
export function mergeSortedKeys(
  sorted: readonly SortKey[],
  fresh: readonly LogEvent[],
  field: string,
  direction: 'asc' | 'desc' = 'asc',
): SortKey[] {
  if (!fresh.length) return sorted.slice();
  const sign = direction === 'desc' ? -1 : 1;
  const incoming = sortedKeys(fresh, field, direction);
  const merged: SortKey[] = new Array(sorted.length + incoming.length);
  let i = 0,
    j = 0,
    k = 0;
  while (i < sorted.length && j < incoming.length)
    merged[k++] = compareKeys(sorted[i], incoming[j], sign) <= 0 ? sorted[i++] : incoming[j++];
  while (i < sorted.length) merged[k++] = sorted[i++];
  while (j < incoming.length) merged[k++] = incoming[j++];
  return merged;
}
