import type { LogEvent } from '../../core/types';
import type { HostMessage } from '../../protocol/messages';
import type { Elements } from '../dom';
import { cell } from '../dom';
import { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';
import { buildEventDetails } from './details';

export function createInspection(elements: Elements, scrollViewport: HTMLElement, api: WebviewApi, formatTimestamp: (event: LogEvent) => string | undefined, scope: EventScope) {
  let contextAnchor: number | undefined;
  let contextSelected: number | undefined;
  let contextScrollTop = 0;
  let contextEvents: LogEvent[] = [];
  function showContext(id: number) {
    contextAnchor = id;
    contextSelected = undefined;
    contextScrollTop = scrollViewport.scrollTop;
    elements.contextStatus.textContent = 'Loading…';
    elements.contextLogs.replaceChildren();
    elements.contextDetails.replaceChildren();
    contextEvents = [];
    elements.contextDialog.showModal();
    api.postMessage({ type: 'context', id });
  }

  function selectContextEvent(id: number) {
    contextSelected = id;
    elements.contextDetails.textContent = 'Loading…';
    for (const button of elements.contextLogs.querySelectorAll<HTMLElement>('.context-event')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.id) === id));
    }
    api.postMessage({ type: 'details', id, target: 'context' });
  }

  scope.listen(elements.contextClose, 'click', () => elements.contextDialog.close());

  scope.listen(elements.contextExport, 'click', () => api.postMessage({ type: 'exportContext', ids: contextEvents.map(event => event.id) }));

  scope.listen(elements.contextDialog, 'close', () => {
    contextAnchor = undefined;
    contextSelected = undefined;
    elements.contextLogs.replaceChildren();
    elements.contextDetails.replaceChildren();
    contextEvents = [];
    scrollViewport.scrollTop = contextScrollTop;
  });

  scope.listen(elements.contextLogs, 'click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('.context-event');
    if (button)
      selectContextEvent(Number(button.dataset.id));
  });

  scope.listen(elements.contextDetails, 'click', handleDetailAction);

  function handleDetailAction(event: Event) {
    const source = (event.target as HTMLElement).closest<HTMLElement>('.source-link');
    if (source) {
      api.postMessage({ type: 'openSource', id: Number(source.dataset.id), block: Number(source.dataset.block), line: Number(source.dataset.line) });
      return true;
    }
    const copy = (event.target as HTMLElement).closest<HTMLElement>('.copy-button');
    if (copy) {
      api.postMessage({ type: 'copy', id: Number(copy.dataset.id) });
      return true;
    }
    const share = (event.target as HTMLElement).closest<HTMLElement>('.share-source-button');
    if (share) {
      api.postMessage({ type: 'shareEvent', id: Number(share.dataset.id) });
      return true;
    }
    const context = (event.target as HTMLElement).closest<HTMLElement>('.context-button');
    if (context) {
      showContext(Number(context.dataset.id));
      return true;
    }
    return false;
  }
  function receiveContext(data: Extract<HostMessage, { type: 'context'; }>) {

    if (!elements.contextDialog.open || data.id !== contextAnchor)
      return;
    elements.contextStatus.textContent = data.missing
      ? 'This event has been discarded from retained history. Close this view to return to your results.'
      : `${data.server || 'Source'} · Same session · All levels and captured streams · Up to 25 retained events before and after · Snapshot in capture order`;
    contextEvents = data.events ?? [];
    elements.contextLogs.replaceChildren(...data.events.map(event => {
      const row = document.createElement('tr');
      row.dataset.id = String(event.id);
      row.className = event.id === contextAnchor ? 'context-anchor' : '';
      const message = cell('');
      const button = document.createElement('button');
      button.className = 'context-event';
      button.dataset.id = String(event.id);
      button.textContent = `${event.id === contextAnchor ? 'Selected: ' : ''}${event.message ?? ''}${event.truncated ? ' [truncated]' : ''}`;
      message.append(button);
      row.append(cell(formatTimestamp(event), 'time'), cell(event.level, `level ${event.level}`), message, cell(event.stream, 'source'));
      return row;
    }));
    elements.contextLogs.querySelector('.context-anchor')?.scrollIntoView({ block: 'center' });
    if (!data.missing)
      selectContextEvent(contextAnchor);
    return;

  }
  function receiveDetails(data: Extract<HostMessage, { type: 'details'; }>) {
    if (elements.contextDialog.open && data.id === contextSelected) elements.contextDetails.replaceChildren(buildEventDetails(data.id, data.text, data.exceptions));
  }
  return { showContext, selectContextEvent, handleDetailAction, receiveContext, receiveDetails };
}
