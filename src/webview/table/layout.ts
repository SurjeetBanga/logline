import type { Column } from './rows';

export function layoutColumnWidths(displayedColumns: Column[], columnElements: Map<string, HTMLTableColElement>, columnWidths: Record<string, number>, available: number, table: HTMLElement) {
  if (!columnElements.size)
    return;
  const defaults: Record<string, number> = { 'base:time': 140, 'base:level': 110, 'base:source': 110 };
  const messageFloor = 300;
  const minWidth = 72;
  const isExplicit = (key: string) => Number.isFinite(Number(columnWidths[key]));
  const widthFor = (key: string) => {
    const savedWidth = Number(columnWidths[key]);
    return Number.isFinite(savedWidth) ? Math.max(minWidth, Math.min(1600, savedWidth)) : defaults[key] || 160;
  };
  const fullOtherWidth = displayedColumns.filter(column => column.key !== 'base:message').reduce((sum, column) => sum + widthFor(column.key), 0);
  // Degrade gracefully in a narrow panel by collapsing the least essential
  // column (Source) instead of forcing horizontal scrolling.
  const sourceElement = columnElements.get('base:source');
  const collapseSource = Boolean(sourceElement) && available > 0 && fullOtherWidth + messageFloor > available;
  if (sourceElement)
    sourceElement.style.visibility = collapseSource ? 'collapse' : '';
  const columns = displayedColumns.filter(column => !(collapseSource && column.key === 'base:source'));
  const explicitWidth = columns.filter(column => isExplicit(column.key)).reduce((sum, column) => sum + widthFor(column.key), 0);
  // Columns without a manually-dragged width are free to shrink (down to the
  // same floor manual resizing enforces) so adding or removing columns keeps
  // everything fitting the panel instead of only the message column ever
  // reacting and the rest just forcing a horizontal scrollbar.
  const autoOthers = columns.filter(column => column.key !== 'base:message' && !isExplicit(column.key));
  const autoOthersNatural = autoOthers.reduce((sum, column) => sum + widthFor(column.key), 0);
  const remaining = available > 0 ? available - explicitWidth : -Infinity;
  let messageWidth;
  let shrinkRatio = 1;
  if (isExplicit('base:message')) {
    messageWidth = widthFor('base:message');
  }
  else if (remaining >= messageFloor + autoOthersNatural) {
    messageWidth = remaining - autoOthersNatural;
  }
  else {
    messageWidth = messageFloor;
    const minTotal = autoOthers.length * minWidth;
    const remainingForOthers = remaining - messageFloor;
    shrinkRatio = remainingForOthers > minTotal && autoOthersNatural > minTotal
      ? (remainingForOthers - minTotal) / (autoOthersNatural - minTotal) : 0;
  }
  const widths = new Map<string, number>();
  let total = 0;
  for (const { key } of columns) {
    const width = key === 'base:message' ? messageWidth
      : isExplicit(key) ? widthFor(key)
        : Math.round(minWidth + (widthFor(key) - minWidth) * shrinkRatio);
    widths.set(key, width);
    total += width;
  }
  // A manually narrowed Message column used to leave an empty strip at the
  // right edge. Treat its saved width as a floor so the table always uses the
  // available panel width while retaining horizontal scrolling when needed.
  if (available > total && widths.has('base:message')) {
    widths.set('base:message', widths.get('base:message')! + available - total);
    total = available;
  }
  for (const [key, width] of widths)
    columnElements.get(key)!.style.width = `${width}px`;
  table.style.width = `${Math.max(total, available)}px`;
}
