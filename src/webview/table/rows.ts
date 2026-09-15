import type { LogEvent } from '../../core/types';
import { cell } from '../dom';
import { buildEventDetails } from '../inspection/details';
import type { ViewerState } from '../state';

export interface Column { key: string; label: string; }
export function createRows(state: ViewerState, columns: () => Column[], formatTimestamp: (event: LogEvent) => string | undefined) {
  function buildRow(event: LogEvent) {
    const row = document.createElement('tr');
    row.className = 'event-row';
    row.dataset.id = String(event.id);
    const messageCell = cell('');
    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';
    const button = document.createElement('button');
    button.className = 'message-button';
    button.textContent = `${event.message}${event.truncated ? ' [truncated]' : ''}`;
    button.title = event.message ?? '';
    button.setAttribute('aria-expanded', String(event.id === state.selected));
    messageContent.append(button);
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
    const actions = document.createElement('div');
    actions.className = 'detail-actions';
    const context = document.createElement('button');
    context.textContent = 'Show context';
    context.className = 'context-button';
    context.dataset.id = String(event.id);
    actions.append(context);
    container.append(actions, buildEventDetails(event.id, state.selectedDetailText, state.selectedExceptions));
    details.append(container);
    return details;
  }

  return { buildRow, buildDetailRow };
}
