import { getField } from './query';
import type { LogEvent } from './types';

export function fieldValue(event: LogEvent, field: string): unknown {
  if (field === 'id') return event.id;
  if (field === 'timestampMs') return event.timestampMs;
  return getField(event, field);
}
const valueCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortEvents(events: LogEvent[], field: string, direction: 'asc' | 'desc' = 'asc'): LogEvent[] {
  const sign = direction === 'desc' ? -1 : 1;
  return events.sort((a, b) => {
    const av = fieldValue(a, field); const bv = fieldValue(b, field);
    if (av === undefined || av === null || av === '') return bv === undefined || bv === null || bv === '' ? a.id - b.id : 1;
    if (bv === undefined || bv === null || bv === '') return -1;
    const an = typeof av === 'number' ? av : Number(av); const bn = typeof bv === 'number' ? bv : Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sign * (an - bn || a.id - b.id);
    return sign * valueCollator.compare(String(av), String(bv)) || a.id - b.id;
  });
}
