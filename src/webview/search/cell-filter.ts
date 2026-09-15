import { queryTokens } from '../../core/query-tokens';
import type { LogEvent } from '../../core/types';

export interface CellValue { field: string; value: string | number | boolean | undefined; }
export type FilterChoice = { query: string; reason?: never } | { query?: never; reason: string };

export function valueForCell(event: LogEvent, column: string): CellValue | undefined {
  switch (column) {
    case 'base:time': return { field: 'timestamp', value: event.timestamp };
    case 'base:level': return { field: 'level', value: event.level };
    case 'base:message': return { field: 'message', value: event.message };
    case 'base:source': return { field: 'stream', value: event.stream };
  }
  if (column.startsWith('field:')) {
    const field = column.slice(6);
    return { field, value: Object.hasOwn(event.fields ?? {}, field) ? event.fields![field] : undefined };
  }
}

export function cellFilterQuery(input: string, cell: CellValue, exclude: boolean, limit = 256): FilterChoice {
  // These names are operators, not searchable payload fields.
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(cell.field) || /^(exists|last)$/i.test(cell.field))
    return { reason: 'This field name cannot be used in a field filter.' };
  if (cell.value === undefined || cell.value === null || String(cell.value) === '')
    return { reason: 'This cell has no value to filter.' };
  const term = `${exclude ? '-' : ''}${cell.field}:${JSON.stringify(String(cell.value))}`;
  const groups: string[][] = [[]];
  for (const token of queryTokens(input)) {
    if (token === 'OR' || token === 'or') groups.push([]);
    else groups.at(-1)!.push(token);
  }
  const branches = groups.filter(group => group.length);
  const query = (branches.length ? branches : [[]]).map(group => [...group, term].join(' ')).join(' OR ');
  return query.length > limit ? { reason: `This filter would exceed the ${limit}-character search limit.` } : { query };
}
