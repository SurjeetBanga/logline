import type { LogEvent } from '../../core/types';
import type { Elements } from '../dom';
import type { EventScope } from '../event-scope';
import { cellFilterQuery, valueForCell, type CellValue } from '../search/cell-filter';

export function createCellActions(elements: Elements, events: () => LogEvent[], query: () => string, apply: (query: string) => void, scope: EventScope) {
  const menu = elements.cellFilterMenu;
  const buttons = [elements.cellFilterInclude, elements.cellFilterExclude];
  let origin: HTMLTableCellElement | undefined;
  let selected: CellValue | undefined;
  let active: { id: string; column: string } | undefined;

  function rows() { return [...elements.logs.querySelectorAll<HTMLTableRowElement>('.event-row')]; }
  function cells(row: HTMLTableRowElement) {
    return [...row.querySelectorAll<HTMLTableCellElement>('td[data-column]')].filter(cell => cell.getBoundingClientRect().width > 0);
  }
  function identify(cell: HTMLTableCellElement) {
    return { id: cell.closest<HTMLTableRowElement>('tr.event-row')!.dataset.id!, column: cell.dataset.column! };
  }
  function setActive(cell: HTMLTableCellElement) {
    active = identify(cell);
    for (const row of rows()) for (const item of cells(row)) item.tabIndex = item === cell ? 0 : -1;
  }
  function close(restoreFocus = false) {
    const previous = origin;
    const focusedMenu = menu.contains(document.activeElement);
    menu.hidden = true;
    selected = undefined;
    origin = undefined;
    if (restoreFocus && previous && elements.logs.contains(previous)) previous.focus({ preventScroll: true });
    else if (focusedMenu) {
      const fallback = rows().flatMap(cells).find(cell => cell.tabIndex === 0);
      (fallback ?? elements.search).focus({ preventScroll: true });
    }
  }
  function choices() {
    if (!selected) return;
    const results = buttons.map((button, index) => {
      // If the user has started replacing the serialized value in the native
      // input, include that draft in the cell action. Otherwise use the
      // authoritative applied query represented by the chips.
      const draft = elements.search.value.trim();
      const currentQuery = draft && draft !== query() ? draft : query();
      const choice = cellFilterQuery(currentQuery, selected!, index === 1);
      button.disabled = choice.query === undefined;
      button.title = choice.reason ?? '';
      return choice;
    });
    elements.cellFilterReason.textContent = [...new Set(results.map(choice => choice.reason).filter(Boolean))].join(' ');
    elements.cellFilterReason.hidden = !elements.cellFilterReason.textContent;
    return results;
  }
  function open(cell: HTMLTableCellElement, x: number, y: number) {
    const id = identify(cell);
    const event = events().find(event => String(event.id) === id.id);
    const value = event && valueForCell(event, id.column);
    if (!value) return false;
    origin = cell;
    selected = value;
    setActive(cell);
    elements.cellFilterLabel.textContent = `${value.field}: ${value.value === undefined ? '(missing)' : JSON.stringify(String(value.value))}`;
    elements.cellFilterLabel.title = elements.cellFilterLabel.textContent;
    choices();
    menu.hidden = false;
    // Measure at a safe position before clamping both edges of the popup.
    menu.style.left = '8px';
    menu.style.top = '8px';
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    (buttons.find(button => !button.disabled) ?? menu).focus({ preventScroll: true });
    return true;
  }
  function activate(index: number) {
    // Recheck against the current search rather than applying a stale query.
    const choice = choices()?.[index];
    if (choice?.query === undefined) return;
    close();
    apply(choice.query);
  }

  buttons.forEach((button, index) => scope.listen(button, 'click', () => activate(index)));
  scope.listen(elements.logs, 'contextmenu', event => {
    const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>('td[data-column]');
    if (!cell?.closest('tr.event-row')) return;
    // Keyboard contextmenu events can have zero pointer coordinates.
    const bounds = cell.getBoundingClientRect();
    if (open(cell, event.clientX || bounds.left, event.clientY || bounds.bottom)) event.preventDefault();
  });
  scope.listen(elements.logs, 'focusin', event => {
    const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>('td[data-column]');
    if (cell?.closest('tr.event-row')) setActive(cell);
  });
  scope.listen(elements.logs, 'keydown', event => {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLTableCellElement>('td[data-column]');
    if (!cell?.closest('tr.event-row')) return;
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      const bounds = cell.getBoundingClientRect();
      if (open(cell, bounds.left, bounds.bottom)) event.preventDefault();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // Leave buttons (including normal message expansion) with their own keys.
    if (target !== cell) return;
    const visibleRows = rows();
    const row = cell.closest<HTMLTableRowElement>('tr.event-row')!;
    const rowIndex = visibleRows.indexOf(row);
    const rowCells = cells(row);
    const columnIndex = rowCells.indexOf(cell);
    let next: HTMLTableCellElement | undefined;
    if (event.key === 'ArrowLeft') next = rowCells[Math.max(0, columnIndex - 1)];
    else if (event.key === 'ArrowRight') next = rowCells[Math.min(rowCells.length - 1, columnIndex + 1)];
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const nextRow = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, rowIndex + (event.key === 'ArrowUp' ? -1 : 1)))];
      next = cells(nextRow).find(item => item.dataset.column === cell.dataset.column);
    }
    if (next) { event.preventDefault(); setActive(next); next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  });
  scope.listen(menu, 'keydown', event => {
    const enabled = buttons.filter(button => !button.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus({ preventScroll: true });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (index >= 0) activate(buttons.indexOf(enabled[index]));
    } else if (event.key === 'Tab') close(true);
  });
  scope.listen(document, 'keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); }
  });
  scope.listen(document, 'click', event => {
    if (!menu.hidden && !menu.contains(event.target as Node)) close();
  });
  scope.listen(document, 'scroll', event => {
    if (!menu.hidden && !menu.contains(event.target as Node)) close();
  }, { capture: true });
  scope.listen(window, 'resize', () => { if (!menu.hidden) close(); });

  function rowsChanged() {
    const all = rows().flatMap(cells);
    const current = all.find(cell => {
      const id = identify(cell);
      return id.id === active?.id && id.column === active.column;
    }) ?? all[0];
    if (current) setActive(current);
    if (!menu.hidden) close();
  }
  menu.hidden = true;
  rowsChanged();
  return { rowsChanged };
}
