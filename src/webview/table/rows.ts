import type { LogEvent } from '../../core/types';
import type { RowEvent } from '../../protocol/messages';
import { cell } from '../dom';
import { buildEventDetails, eventAction, icon, type IconName } from '../inspection/details';
import type { ViewerState } from '../state';

export interface Column { key: string; label: string; }

/** A small icon-only button in a row; its label is the tooltip and accessible name. */
function rowIcon(className: string, iconName: IconName, label: string, id: number): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `row-icon ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.dataset.id = String(id);
  button.append(icon(iconName));
  return button;
}


export function createRows(state: ViewerState, columns: () => Column[], formatTimestamp: (event: LogEvent) => string | undefined) {
  function buildRow(event: RowEvent) {
    const row = document.createElement('tr');
    row.className = 'event-row';
    row.dataset.id = String(event.id);
    const messageCell = cell('', 'message-cell');
    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';
    const button = document.createElement('button');
    button.className = 'message-button';
    button.textContent = `${event.message}${event.truncated ? ' [truncated]' : ''}`;
    // No tooltip: it would repeat a possibly long message. Clicking the row shows all of it.
    button.setAttribute('aria-expanded', String(event.id === state.selected));
    messageContent.append(button);
    // Room for the quick actions a hovered row shows. The space is kept on
    // every row, so hovering neither covers other icons nor shifts where the
    // message is cut off, and it sits before the link icons so those stay
    // aligned at the right edge. The buttons themselves are only built for
    // the row under the pointer (fillQuickActions).
    const quick = document.createElement('span');
    quick.className = event.site ? 'row-quick has-site' : 'row-quick';
    messageContent.append(quick);
    if (event.traceId) {
      // One click from any request's log to its waterfall across services.
      const trace = document.createElement('button');
      trace.className = 'row-trace-button';
      trace.type = 'button';
      trace.dataset.traceId = event.traceId;
      trace.title = 'Trace: show this request across services';
      trace.setAttribute('aria-label', 'Show trace');
      trace.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="M2 3.5h7M4 7.5h8M7 11.5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      messageContent.append(trace);
    }
    // What the row links to, visible without opening it.
    if (event.site)
      messageContent.append(rowIcon('row-site-button', 'code', 'Open code: open the log statement that logged this event', event.id));
    if (event.finding) {
      const finding = rowIcon(`row-finding-button severity-${event.finding.severity}`, event.finding.severity, `Log doctor: ${event.finding.message} Click for details.`, event.id);
      messageContent.append(finding);
    }
    messageCell.append(messageContent);
    for (const column of columns()) {
      let tableCell: HTMLTableCellElement;
      if (column.key === 'base:time')
        tableCell = cell(formatTimestamp(event), 'time');
      else if (column.key === 'base:level')
        tableCell = cell(event.level, `level ${event.level}`);
      else if (column.key === 'base:message')
        tableCell = messageCell;
      else if (column.key === 'base:source')
        tableCell = cell(event.stream, 'source');
      else
        tableCell = cell(event.fields?.[column.label] ?? '');
      tableCell.dataset.column = column.key;
      tableCell.tabIndex = -1;
      tableCell.setAttribute('aria-label', `${column.label}: ${tableCell.textContent ?? ''}`);
      tableCell.setAttribute('aria-haspopup', 'menu');
      row.append(tableCell);
    }
    return row;
  }

  function buildDetailRow(event: LogEvent) {
    const details = document.createElement('tr');
    details.className = 'detail-row';
    const container = cell('', 'detail-cell');
    container.colSpan = columns().length;
    const context = eventAction('context-button', 'context', 'Surrounding logs', 'Show the logs just before and after this event from the same run');
    context.dataset.id = String(event.id);
    container.append(buildEventDetails(event.id, state.selectedDetailText, state.selectedExceptions, state.selectedLinks, [context]));
    if (!state.cellHintDismissed) {
      const hint = document.createElement('p');
      hint.className = 'detail-hint';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'dismiss-hint';
      dismiss.textContent = 'Got it';
      hint.append(document.createTextNode('Tip: right-click any cell in the table to include or exclude its value.'), dismiss);
      container.append(hint);
    }
    details.append(container);
    return details;
  }

  /** Build the hovered row's quick actions into its reserved space. */
  function fillQuickActions(row: HTMLElement) {
    const slot = row.querySelector<HTMLElement>('.row-quick');
    if (!slot || slot.firstChild) return;
    const id = Number(row.dataset.id);
    const quick = [rowIcon('row-action row-context-button', 'context', 'Surrounding logs: show the logs just before and after this event', id)];
    if (slot.classList.contains('has-site')) quick.push(rowIcon('row-action row-break-button', 'breakpoint', 'Break here: stop the debugger the next time this statement logs', id));
    for (const item of quick) item.tabIndex = -1;
    slot.append(...quick);
  }

  return { buildRow, buildDetailRow, fillQuickActions };
}
