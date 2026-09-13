import type { LogEvent } from '../../core/types';
import type { HostMessage } from '../../protocol/messages';
import type { Elements } from '../dom';
import { element, emptyMessage } from '../dom';
import { EventScope } from '../event-scope';
import type { ViewerState } from '../state';
import type { ViewerActions, WebviewApi } from '../types';
import { layoutColumnWidths } from './layout';
import { createRows } from './rows';

export function createTable(elements: Elements, scrollViewport: HTMLElement, state: ViewerState, api: WebviewApi, formatTimestamp: (event: LogEvent) => string | undefined, actions: ViewerActions, scope: EventScope) {
  const { request, saveState, updateFollowControl, updateModeLabel, populateFacetFields } = actions;
  function totalColumnCount() { return displayedColumns.length; }

  const { buildRow, buildDetailRow } = createRows(state, () => displayedColumns, formatTimestamp);

  // Only the rows scrolled into view are ever built, bracketed by two
  // height-only spacer rows that stand in for the rest of the page. That keeps
  // the DOM cost of a refresh bounded by the viewport instead of by how many of
  // the page's up-to-1,000 events are retained.
  let virtualEvents: LogEvent[] = [];

  let rowHeight = 30;

  let rowHeightMeasured = false;

  let topSpacer: HTMLTableRowElement | undefined;

  let bottomSpacer: HTMLTableRowElement | undefined;

  let expandedHeight = 0;

  let expandedRow: HTMLTableRowElement | undefined;

  let renderRevision = 0;

  let renderedWindow: string | undefined;

  const detailResizeObserver = scope.observer(() => scheduleRenderWindow());

  function ensureSpacers() {
    if (topSpacer)
      return;
    topSpacer = document.createElement('tr');
    topSpacer.className = 'virtual-spacer';
    topSpacer.append(document.createElement('td'));
    bottomSpacer = document.createElement('tr');
    bottomSpacer.className = 'virtual-spacer';
    bottomSpacer.append(document.createElement('td'));
  }

  // Rows are a fixed height (no wrapping, see .message-button), so one
  // measurement covers the whole table. Retried lazily since it can read 0
  // while the view is hidden.
  function ensureRowHeight() {
    if (rowHeightMeasured)
      return;
    const probe = buildRow({ id: -1, timestamp: '00:00:00.000', message: 'sample', level: 'info', stream: '', fields: {} });
    probe.style.visibility = 'hidden';
    elements.logs.append(probe);
    const measured = probe.getBoundingClientRect().height;
    probe.remove();
    if (measured > 0) {
      rowHeight = measured;
      rowHeightMeasured = true;
    }
  }

  function renderWindow() {
    ensureSpacers();
    ensureRowHeight();
    const total = virtualEvents.length;
    const selectedIndex = virtualEvents.findIndex(event => event.id === state.selected);
    if (selectedIndex < 0)
      expandedHeight = 0;
    else {
      const detail = elements.logs.querySelector<HTMLTableRowElement>('.detail-row');
      if (detail)
        expandedHeight = detail.getBoundingClientRect().height;
    }
    const overscan = 8;
    const visibleCount = Math.max(1, Math.ceil(scrollViewport.clientHeight / rowHeight)) + overscan * 2;
    const detailTop = (selectedIndex + 1) * rowHeight;
    const offset = selectedIndex >= 0 && scrollViewport.scrollTop > detailTop
      ? scrollViewport.scrollTop - Math.min(expandedHeight, scrollViewport.scrollTop - detailTop)
      : scrollViewport.scrollTop;
    let start = Math.floor(offset / rowHeight) - overscan;
    start = Math.max(0, Math.min(start, Math.max(0, total - visibleCount)));
    const end = Math.min(total, start + visibleCount);
    const totalCols = totalColumnCount();
    (topSpacer!.firstChild as HTMLTableCellElement).colSpan = totalCols;
    (topSpacer!.firstChild as HTMLTableCellElement).style.height = `${start * rowHeight + (selectedIndex >= 0 && selectedIndex < start ? expandedHeight : 0)}px`;
    (bottomSpacer!.firstChild as HTMLTableCellElement).colSpan = totalCols;
    (bottomSpacer!.firstChild as HTMLTableCellElement).style.height = `${(total - end) * rowHeight + (selectedIndex >= end ? expandedHeight : 0)}px`;
    const windowKey = `${start}:${end}:${renderRevision}`;
    if (renderedWindow === windowKey)
      return;
    renderedWindow = windowKey;
    // Capture focus before moving the expanded row into a fragment. Rebuilding
    // must never scroll a focused event back into view during wheel scrolling.
    const focused = document.activeElement as HTMLElement | null;
    const focusedRow = !!focused && elements.logs.contains(focused) ? focused.closest('tr') : undefined;
    const refocusId = focusedRow?.classList.contains('event-row') ? focusedRow.dataset.id : undefined;
    const detailScrollers = [...(expandedRow?.querySelectorAll<HTMLElement>('.event-details, pre') ?? [])]
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const event = virtualEvents[i];
      fragment.append(buildRow(event));
      if (event.id === state.selected) {
        if (!expandedRow) {
          detailResizeObserver.disconnect();
          expandedRow = buildDetailRow(event);
          detailResizeObserver.observe(expandedRow);
        }
        (expandedRow.firstChild as HTMLTableCellElement).colSpan = totalCols;
        fragment.append(expandedRow);
      }
    }
    // Rebuilding replaces the focused button's element out from under it, which
    // (besides dropping keyboard focus) makes Chrome yank the scroll position
    // once focus falls back to <body>. Re-focus the same row's new button.
    elements.logs.replaceChildren(topSpacer!, fragment, bottomSpacer!);
    for (const { element, top, left } of detailScrollers) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    if (focused && !!focused && elements.logs.contains(focused))
      focused.focus({ preventScroll: true });
    else if (refocusId !== undefined)
      elements.logs.querySelector<HTMLElement>(`tr.event-row[data-id="${refocusId}"] .message-button`)?.focus({ preventScroll: true });
    const measured = elements.logs.querySelector<HTMLTableRowElement>('.detail-row')?.getBoundingClientRect().height;
    if (measured !== undefined && measured !== expandedHeight) {
      expandedHeight = measured;
      scheduleRenderWindow();
    }
  }

  let windowRenderQueued = false;

  let followTailRequested = false;

  function scheduleRenderWindow(followTail = false) {
    followTailRequested ||= followTail === true;
    if (windowRenderQueued)
      return;
    windowRenderQueued = true;
    scope.frame(() => {
      windowRenderQueued = false;
      const followTail = followTailRequested;
      followTailRequested = false;
      renderWindow();
      if (followTail && state.following && !state.paused && !state.selectedSort) {
        scrollViewport.scrollTop = scrollViewport.scrollHeight;
        renderWindow();
      }
    });
  }

  scope.listen(scrollViewport, 'scroll', () => scheduleRenderWindow());

  scope.observer(() => {
    rowHeightMeasured = false;
    renderRevision++;
    layoutColumns();
    scheduleRenderWindow(state.following && !state.paused && !state.selectedSort);
  }).observe(scrollViewport);

  function renderRows(events: LogEvent[]) {
    virtualEvents = events;
    renderRevision++;
    renderWindow();
    if (state.following && !state.paused && !state.selectedSort) {
      // Spacers above now size scrollHeight to the full list; scroll to the
      // true bottom, then re-render so the visible window matches.
      scrollViewport.scrollTop = scrollViewport.scrollHeight;
      renderWindow();
      scheduleRenderWindow(true);
    }
  }

  let currentColumns: string[] = [];
  const baseColumns = [
    { key: 'base:time', label: 'Time' }, { key: 'base:level', label: 'Level' },
    { key: 'base:message', label: 'Message' }, { key: 'base:source', label: 'Source' }
  ];

  let displayedColumns = [...baseColumns];

  let availableColumns: string[] = [];

  let automaticColumns: string[] = [];

  let draggedColumn: string | undefined;

  let columnsInitialized = false;

  let columnElements = new Map<string, HTMLTableColElement>();

  function updateColumns(columns: string[], force = false) {
    automaticColumns = Array.isArray(columns) ? columns : [];
    const next = [...new Set([...automaticColumns, ...state.extraColumns.filter(field => state.columnFields.includes(field))])];
    if (columnsInitialized && !force && JSON.stringify(next) === JSON.stringify(availableColumns))
      return;
    columnsInitialized = true;
    renderRevision++;
    availableColumns = next;
    currentColumns = next.filter(label => !state.hiddenColumns.has(`field:${label}`));
    const allColumns = [...baseColumns, ...currentColumns.map(label => ({ key: `field:${label}`, label }))];
    const known = new Map(allColumns.map(column => [column.key, column]));
    displayedColumns = [...state.columnOrder.map(key => known.get(key)).filter((column): column is { key: string; label: string; } => Boolean(column)), ...allColumns.filter(column => !state.columnOrder.includes(column.key))];
    state.columnOrder = displayedColumns.map(column => column.key);
    columnElements = new Map(displayedColumns.map(column => [column.key, document.createElement('col')]));
    element('eventColumns').replaceChildren(...columnElements.values());
    layoutColumns();
    const head = element('head-row');
    head.replaceChildren(...displayedColumns.map(column => {
      const { key, label } = column;
      const th = document.createElement('th');
      const grip = document.createElement('span');
      grip.className = 'column-grip';
      grip.textContent = '⠿';
      grip.title = `Drag to move ${label}`;
      grip.draggable = true;
      th.append(grip);
      const sortButton = document.createElement('button');
      sortButton.type = 'button';
      sortButton.className = 'column-sort';
      const labelText = document.createElement('span');
      labelText.className = 'column-label';
      labelText.textContent = label;
      sortButton.append(labelText);
      const sortKey = key === 'base:time' ? 'timestampMs' : key === 'base:level' ? 'level' : key === 'base:message' ? 'message' : key === 'base:source' ? 'stream' : label;
      const indicator = document.createElement('span');
      indicator.className = 'sort-indicator';
      indicator.textContent = state.selectedSort === sortKey ? (state.selectedSortDirection === 'asc' ? '↑' : '↓') : '↕';
      indicator.setAttribute('aria-hidden', 'true');
      sortButton.append(indicator);
      th.append(sortButton);
      th.setAttribute('aria-sort', state.selectedSort === sortKey ? (state.selectedSortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
      sortButton.title = `Sort by ${label}${state.selectedSort === sortKey ? (state.selectedSortDirection === 'asc' ? ' descending' : ' ascending') : ''}`;
      sortButton.setAttribute('aria-label', sortButton.title);
      th.dataset.column = key;
      scope.listen(sortButton, 'click', () => {
        state.sort(sortKey);
        updateModeLabel();
        saveState();
        updateColumns(automaticColumns, true);
        updateModeLabel();
        request(true);
        scrollViewport.scrollTop = 0;
        head.querySelectorAll<HTMLElement>('.column-sort')[displayedColumns.findIndex(column => column.key === key)]?.focus();
      });
      scope.listen(grip, 'dragstart', event => {
        draggedColumn = key;
        th.classList.add?.('column-dragging');
        event.dataTransfer?.setData('text/plain', key);
        if (event.dataTransfer)
          event.dataTransfer.effectAllowed = 'move';
      });
      scope.listen(th, 'dragover', event => {
        if (draggedColumn && draggedColumn !== key) {
          event.preventDefault();
          th.classList.add('column-drop-target');
        }
      });
      scope.listen(th, 'dragleave', () => th.classList.remove?.('column-drop-target'));
      scope.listen(th, 'drop', event => {
        event.preventDefault();
        th.classList.remove?.('column-drop-target');
        const source = draggedColumn || event.dataTransfer?.getData('text/plain');
        if (!source || source === key)
          return;
        const order = displayedColumns.map(item => item.key);
        const from = order.indexOf(source);
        const to = order.indexOf(key);
        if (from < 0 || to < 0)
          return;
        order.splice(from, 1);
        order.splice(to, 0, source);
        state.columnOrder = order;
        saveState();
        updateColumns(automaticColumns, true);
        renderWindow();
      });
      scope.listen(grip, 'dragend', () => {
        draggedColumn = undefined; th.classList.remove?.('column-dragging', 'column-drop-target'); for (const item of head.querySelectorAll?.('.column-drop-target') ?? [])
          item.classList.remove?.('column-drop-target');
      });
      const handle = document.createElement('span');
      handle.className = 'resize-handle';
      handle.dataset.column = key;
      handle.setAttribute('aria-label', `Resize ${label} column`);
      handle.title = `Drag to resize ${label}`;
      handle.draggable = false;
      scope.listen(handle, 'pointerdown', event => { event.stopPropagation?.(); resizeFromPointer(event, key, th); });
      scope.listen(handle, 'click', event => event.stopPropagation?.());
      th.append(handle);
      if (key.startsWith('field:')) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-column';
        remove.textContent = '×';
        remove.title = `Remove ${label} column`;
        remove.setAttribute('aria-label', `Remove ${label} column`);
        scope.listen(remove, 'click', event => { event.stopPropagation?.(); state.hiddenColumns.add(key); state.columnOrder = state.columnOrder.filter(item => item !== key); saveState(); updateColumns(automaticColumns, true); renderWindow(); });
        th.append(remove);
      }
      return th;
    }));
    renderFieldList();
    populateFacetFields(state.allFields.length ? state.allFields : currentColumns);
    state.lastRows = undefined;
  }

  function layoutColumns() { layoutColumnWidths(displayedColumns, columnElements, state.columnWidths, scrollViewport.clientWidth || 0, element('eventsTable')); }

  function resizeFromPointer(event: PointerEvent, key: string, header: HTMLElement) {
    if (event.button !== undefined && event.button !== 0)
      return;
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = header.getBoundingClientRect().width || Number(state.columnWidths[key]) || 80;
    const move = (pointer: PointerEvent) => {
      const width = Math.max(72, Math.min(1600, startWidth + pointer.clientX - startX));
      state.columnWidths[key] = Math.round(width);
      layoutColumns();
    };
    const finish = () => {
      document.removeEventListener?.('pointermove', move);
      document.removeEventListener?.('pointerup', finish);
      document.removeEventListener?.('pointercancel', finish);
      saveState();
    };
    scope.listen(document, 'pointermove', move);
    scope.listen(document, 'pointerup', finish, { once: true });
    scope.listen(document, 'pointercancel', finish, { once: true });
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  let fieldListSignature: string | undefined;

  function renderFieldList() {
    if (!elements.fieldList)
      return;
    const choices = [...new Set([...availableColumns, ...state.columnFields])];
    const signature = JSON.stringify([choices, currentColumns]);
    if (signature === fieldListSignature)
      return;
    fieldListSignature = signature;
    if (!choices.length) {
      elements.fieldList.replaceChildren(emptyMessage('Additional fields will appear when structured logs are received.'));
      return;
    }
    elements.fieldList.replaceChildren(...choices.map(label => {
      const row = document.createElement('label');
      row.className = 'field-toggle';
      row.dataset.field = label;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = currentColumns.includes(label);
      scope.listen(input, 'change', () => {
        const key = `field:${label}`;
        if (input.checked) {
          state.hiddenColumns.delete(key);
          if (!state.extraColumns.includes(label))
            state.extraColumns.push(label);
        }
        else {
          state.hiddenColumns.add(key);
          state.extraColumns = state.extraColumns.filter(field => field !== label);
        }
        saveState();
        updateColumns(automaticColumns, true);
        renderWindow();
        request(true);
      });
      row.append(input, document.createTextNode(label));
      return row;
    }));
  }

  function toggleExpand(id: number) {
    expandedHeight = 0;
    expandedRow = undefined;
    detailResizeObserver.disconnect();
    renderRevision++;
    if (state.inspect(id)) api.postMessage({ type: 'details', id });
    updateFollowControl();
    updateModeLabel();
    renderWindow();
  }
  function resetDetails() { expandedHeight = 0; expandedRow = undefined; detailResizeObserver.disconnect(); renderRevision++; }
  function receiveDetails(data: Extract<HostMessage, { type: 'details'; }>) {
    if (data.id !== state.selected) return;
    state.selectedDetailText = data.text; state.selectedExceptions = data.exceptions;
    resetDetails(); renderWindow();
  }

  return {
    updateColumns, layoutColumns, renderFieldList, renderRows, renderWindow, scheduleRenderWindow, toggleExpand, resetDetails, receiveDetails,
    get currentColumns() { return currentColumns; }, get automaticColumns() { return automaticColumns; },
    get events() { return virtualEvents; }, get expandedHeight() { return expandedHeight; }
  };
}
