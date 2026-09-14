import type { HostMessage } from '../protocol/messages';
import { createAnalysis } from './analysis/charts';
import { SnapshotBridge } from './bridge';
import { getElements } from './dom';
import { EventScope } from './event-scope';
import { createInspection } from './inspection/context';
import { createPopovers } from './popovers';
import { createSearch } from './search/controls';
import { ViewerState } from './state';
import { createTable } from './table/controller';
import { createTimestampFormatter } from './time';
import type { WebviewApi } from './types';

export function createViewer(api: WebviewApi) {
  const scope = new EventScope();
  const elements = getElements();
  const scrollViewport = document.querySelector<HTMLElement>('.table-scroll')!;
  const saved = api.getState() ?? {};
  const state = new ViewerState(saved);
  elements.search.value = saved.query ?? '';
  const bridge = new SnapshotBridge(api, state, () => elements.search.value);
  const request = (force = false) => bridge.request(force);
  const { popovers, createPopover } = createPopovers(scope);
  const formatTimestamp = createTimestampFormatter(state);
  const analysis = createAnalysis(elements, state);
  const inspection = createInspection(elements, scrollViewport, api, formatTimestamp, scope);
  const search = createSearch(elements, state, api, popovers, { filterChanged }, scope);
  const table = createTable(elements, scrollViewport, state, api, formatTimestamp,
    { request, saveState, filterChanged, setFollowing, updateFollowControl, updateModeLabel }, scope);
  let serverSignature = '';
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let autocompleteDebounce: ReturnType<typeof setTimeout> | undefined;
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let cellFilterQuery: string | undefined;
  // The host increments its generation when logs are cleared. An older
  // snapshot can arrive afterwards, so keep it from restoring the old schema.
  let minimumSnapshotGeneration = 0;
  const onMessage = (event: MessageEvent<HostMessage>) => receive(event.data);
  scope.listen(window, 'message', onMessage);
  function receive(data: HostMessage) {
    // Pushed by the extension whenever retained data or status actually
    // changes, coalesced on its side. This replaces polling on a fixed
    // interval, so an idle server costs nothing here.
    if (data.type === 'update') {
      request();
      return;
    }
    if (data.type === 'serversChanged') {
      serverSignature = '';
      request(true);
      return;
    }
    if (data.type === 'context') { inspection.receiveContext(data); return; }
    if (data.type === 'details') {
      if (data.target === 'context') inspection.receiveDetails(data); else table.receiveDetails(data);
      return;
    }
    if (data.type === 'autocomplete') {
      // The browser's built-in search clear button fires an input event. A
      // response for the text just cleared may still be in transit, but an
      // empty search should never open a field-name dropdown.
      if (elements.search.value.trim()) search.renderAutocomplete(data);
      else search.clearAutocomplete();
      return;
    }
    if (data.type === 'analysis') {
      elements.analysisStatus.textContent = 'Analysis of the current retained filter';
      analysis.renderAnalysis(data.analysis);
      return;
    }
    if (data.type === 'searches') {
      search.renderSearchState(data.searches);
      return;
    }
    if (data.type !== 'snapshot')
      return;
    bridge.received();
    if (data.generation < minimumSnapshotGeneration) {
      bridge.flush();
      return;
    }
    minimumSnapshotGeneration = 0;
    if (state.generation !== undefined && state.generation !== data.generation) {
      state.before = undefined;
      state.page = 0;
      state.lastRows = undefined;
      state.selected = undefined;
      state.selectedDetailText = undefined;
      state.selectedExceptions = [];
      table.resetDetails();
      table.resetAutomaticColumns();
      table.renderRows([]);
      bridge.refreshRequested = true;
    }
    state.generation = data.generation;
    if (data.timezone && data.timezone !== state.displayTimezone) {
      state.displayTimezone = data.timezone;
      state.lastRows = undefined;
    }
    state.newest = data.newest;
    if (!state.following && state.before === undefined)
      state.before = state.newest;
    elements.status.textContent = data.status;
    elements.command.textContent = data.command;
    elements.command.title = data.command;
    elements.stop.disabled = !data.running;
    elements.stop.textContent = state.selectedServer ? 'Stop server' : 'Stop all';
    const activeSessions = Array.isArray(data.sessions) ? data.sessions.filter(session => ['running', 'stopping'].includes(session.status)) : [];
    elements.sessions.textContent = activeSessions.length
      ? `${activeSessions.length} active session${activeSessions.length === 1 ? '' : 's'}` : 'No active sessions';
    if (data.servers) {
      const signature = JSON.stringify(data.servers.map(server => [server.id, server.label, server.status, server.activeSessions,
      server.taskName, server.taskType, server.dependencies, server.dependencyState, server.exitReason]));
      if (signature !== serverSignature) {
        serverSignature = signature;
        const activeCount = data.servers.reduce((sum, server) => sum + (server.activeSessions || 0), 0);
        const options = [document.createElement('option'), ...data.servers.map(() => document.createElement('option'))];
        options[0].textContent = activeCount ? `All servers · ${activeCount} active` : 'All servers';
        options[0].value = '';
        data.servers.forEach((server, index) => {
          const state = server.status === 'idle' ? '' : ` · ${server.status}`;
          const activity = server.activeSessions > 1 ? ` (${server.activeSessions} active)` : '';
          const task = server.taskName ? `Task: ${server.taskName}` : server.label;
          const type = server.taskType ? ` (${server.taskType})` : '';
          const dependency = server.dependencies?.length
            ? ` · deps ${server.dependencies.join(', ')} (${server.dependencyState || 'unknown'})`
            : (server.dependencyState && server.dependencyState !== 'none' ? ` · deps ${server.dependencyState}` : '');
          const reason = server.exitReason ? ` · ${server.exitReason}` : '';
          options[index + 1].textContent = `${task}${type}${state}${activity}${dependency}${reason}`;
          options[index + 1].value = server.id;
          options[index + 1].title = [server.lastSession ? `Session ${server.lastSession}` : undefined,
          server.taskName ? `Task ${server.taskName}${server.taskType ? ` (${server.taskType})` : ''}` : undefined,
          server.dependencyState ? `Dependencies: ${server.dependencies?.join(', ') || 'none'} (${server.dependencyState})` : undefined,
          server.exitReason ? `Exit: ${server.exitReason}` : undefined].filter(Boolean).join(' · ') || server.status;
        });
        elements.server.replaceChildren(...options);
        elements.server.value = data.servers.some(server => server.id === state.selectedServer) ? state.selectedServer : '';
        state.selectedServer = elements.server.value;
      }
    }
    const number = (value: number) => value.toLocaleString();
    const budget = Number.isFinite(data.maxBytes) ? (data.maxBytes / 1048576).toFixed(0) : '?';
    elements.counts.textContent = `${number(data.total)} received · ${number(data.retained)} retained · ${number(data.discarded)} discarded · ${(data.bytes / 1048576).toFixed(1)} / ${budget} MiB · ${data.truncated} truncated`
      + (data.persistDropped ? ` · ${number(data.persistDropped)} disk writes skipped` : '');
    updateModeLabel();
    if (Array.isArray(data.columnFields))
      state.columnFields = data.columnFields;
    table.updateColumns(data.columns ?? []);
    if (data.events?.length)
      table.lockAutomaticColumns();
    table.renderFieldList();
    if (Array.isArray(data.fields))
      state.allFields = data.fields;
    if (data.searches)
      search.renderSearchState(data.searches);
    if (data.events && !bridge.refreshRequested && !state.paused) {
      state.page = data.page ?? 0;
      state.pages = data.pages ?? 1;
      elements.page.textContent = `Page ${state.page + 1} of ${state.pages} · ${number(data.matched ?? 0)} matches`;
      elements.older.disabled = state.page >= state.pages - 1;
      elements.newer.disabled = state.page === 0;
      const signature = data.events.map(event => event.id).join(',');
      if (signature !== state.lastRows) {
        state.lastRows = signature;
        table.renderRows(data.events);
      }
      elements.empty.hidden = data.events.length > 0;
      elements.empty.textContent = data.total ? 'No matching events in retained history.' : 'Run a server command to see its logs here.';
      if (state.following && !state.paused && !state.selectedSort)
        table.scheduleRenderWindow(true);
    }
    bridge.flush();
  }

  function updateFollowControl() {
    if (state.paused) {
      elements.follow.setAttribute('aria-pressed', 'false');
      elements.follow.setAttribute('aria-label', 'Resume live updates');
      elements.follow.title = 'Resume live updates';
      elements.follow.textContent = 'Resume';
      return;
    }
    elements.follow.setAttribute('aria-pressed', String(state.following));
    elements.follow.setAttribute('aria-label', state.following ? 'Live updates' : 'Browse retained history');
    elements.follow.title = state.following ? 'Live updates' : 'Browse retained history';
    elements.follow.textContent = state.following ? 'Live' : 'Browse';
  }

  function updateModeLabel() {
    elements.older.textContent = state.selectedSort ? 'Next →' : '← Older';
    elements.newer.textContent = state.selectedSort ? '← Previous' : 'Newer →';
    elements.mode.textContent = state.paused ? 'Paused — collection continues' : state.selectedSort ? `Sorted ${state.selectedSortDirection === 'asc' ? 'ascending' : 'descending'}${state.following ? ' · Live updates' : ''}`
      : state.following ? 'Live · newest 1,000' : 'Browsing retained history';
    elements.mode.className = state.following && !state.paused ? 'live-mode' : '';
  }

  function setFollowing(value: boolean) { state.setFollowing(value); updateFollowControl(); updateModeLabel(); }
  function saveState() { api.setState(state.persist(elements.search.value)); }
  function hasActiveFilter() {
    return Boolean(elements.search.value.trim()) || state.checkedLevels.size !== 6 || Boolean(state.selectedServer);
  }
  function updateCopyResultsControl() {
    elements.copyResults.hidden = !hasActiveFilter();
    elements.copyResults.textContent = 'Copy results';
  }
  function filterChanged() { state.filterChanged(); updateCopyResultsControl(); saveState(); request(true); }

  function filterForCell(id: number, column: string): { query: string; label: string; } | undefined {
    const event = table.events.find(item => item.id === id);
    if (!event) return;
    const field = column === 'base:time' ? 'timestamp'
      : column === 'base:level' ? 'level'
        : column === 'base:message' ? 'message'
          : column === 'base:source' ? 'stream'
            : column.startsWith('field:') ? column.slice('field:'.length) : undefined;
    if (!field) return;
    const value = field === 'timestamp' ? event.timestamp
      : field === 'level' ? event.level
        : field === 'message' ? event.message
          : field === 'stream' ? event.stream
            : event.fields?.[field];
    const text = String(value ?? '').trim().replace(/"/g, '');
    if (!text) return;
    const query = /\s/.test(text) ? `${field}:"${text}"` : `${field}:${text}`;
    return { query, label: `Filter ${field}: ${text}` };
  }

  function closeCellFilterMenu() {
    cellFilterQuery = undefined;
    elements.cellFilterMenu.hidden = true;
  }

  scope.listen(elements.logs, 'click', event => {
    if (inspection.handleDetailAction(event))
      return;
    const button = (event.target as HTMLElement).closest<HTMLElement>('.message-button');
    if (!button)
      return;
    table.toggleExpand(Number(button.closest('tr')!.dataset.id));
  });

  scope.listen(elements.logs, 'contextmenu', event => {
    const cell = (event.target as HTMLElement).closest<HTMLTableCellElement>('td[data-column]');
    const row = cell?.closest<HTMLTableRowElement>('tr.event-row');
    const choice = cell && row ? filterForCell(Number(row.dataset.id), cell.dataset.column ?? '') : undefined;
    if (!choice) return;
    event.preventDefault();
    cellFilterQuery = choice.query;
    elements.cellFilterAction.textContent = choice.label;
    elements.cellFilterAction.title = choice.label;
    elements.cellFilterMenu.style.left = `${Math.max(8, event.clientX)}px`;
    elements.cellFilterMenu.style.top = `${Math.max(8, event.clientY)}px`;
    elements.cellFilterMenu.hidden = false;
  });

  scope.listen(elements.cellFilterAction, 'click', () => {
    if (!cellFilterQuery) return;
    elements.search.value = [elements.search.value.trim(), cellFilterQuery].filter(Boolean).join(' ');
    closeCellFilterMenu();
    elements.search.focus();
    filterChanged();
  });

  scope.listen(document, 'click', event => {
    if (!elements.cellFilterMenu.hidden && !elements.cellFilterMenu.contains(event.target as Node))
      closeCellFilterMenu();
  });

  scope.listen(document, 'keydown', event => {
    if (event.key === 'Escape') closeCellFilterMenu();
  });

  scope.listen(elements.search, 'input', () => {
    updateCopyResultsControl();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(filterChanged, 150);
    clearTimeout(autocompleteDebounce);
    if (!elements.search.value.trim()) {
      search.clearAutocomplete();
      return;
    }
    autocompleteDebounce = setTimeout(() => {
      api.postMessage({ type: 'autocomplete', input: elements.search.value, serverId: state.selectedServer || undefined });
    }, 150);
  });

  search.buildLevelMenu();

  search.updateLevelButtonLabel();

  updateFollowControl();

  updateModeLabel();

  updateCopyResultsControl();

  createPopover(elements.levelButton.closest<HTMLElement>('.popover-container')!, elements.levelButton, elements.levelMenu);

  createPopover(elements.searchHelp.closest<HTMLElement>('.popover-container')!, elements.searchHelp, elements.searchHelpPanel);

  createPopover(elements.searchTools.closest<HTMLElement>('.popover-container')!, elements.searchTools, elements.searchToolsPanel);

  createPopover(elements.fieldsButton.closest<HTMLElement>('.popover-container')!, elements.fieldsButton, elements.fieldsPanel);

  scope.listen(elements.copyResults, 'click', () => {
    if (!hasActiveFilter()) return;
    api.postMessage({ type: 'copyFiltered', query: elements.search.value, levels: state.currentLevels(), serverId: state.selectedServer || undefined });
    elements.copyResults.textContent = 'Copied';
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(updateCopyResultsControl, 1200);
  });

  scope.listen(elements.saveSearch, 'click', () => {
    for (const popover of popovers)
      popover.close();
    elements.saveSearchName.value = elements.search.value || '';
    elements.saveSearchDialog.showModal();
    elements.saveSearchName.select?.();
  });

  scope.listen(elements.saveSearchCancel, 'click', () => elements.saveSearchDialog.close());

  scope.listen(elements.saveSearchForm, 'submit', event => {
    event.preventDefault();
    const name = elements.saveSearchName.value;
    elements.saveSearchDialog.close();
    api.postMessage({ type: 'saveSearch', name, query: elements.search.value, levels: state.currentLevels(), serverId: state.selectedServer || undefined });
  });

  scope.listen(elements.analyze, 'click', () => {
    elements.analysisDialog.showModal();
    elements.analysisStatus.textContent = 'Loading analysis…';
    api.postMessage({ type: 'analysis', query: elements.search.value, levels: state.currentLevels(), serverId: state.selectedServer || undefined });
  });

  scope.listen(elements.analysisClose, 'click', () => elements.analysisDialog.close());

  scope.listen(elements.server, 'change', () => {
    state.selectedServer = elements.server.value;
    state.page = 0;
    state.lastRows = undefined;
    table.resetAutomaticColumns();
    updateCopyResultsControl();
    saveState();
    request(true);
  });

  scope.listen(elements.follow, 'click', () => {
    if (state.paused || !state.following) {
      state.resume(); table.resetDetails(); saveState(); table.updateColumns(table.automaticColumns, true);
      updateFollowControl(); updateModeLabel(); request(true); table.scheduleRenderWindow(true);
    } else { setFollowing(false); updateFollowControl(); request(true); }
  });
  scope.listen(elements.older, 'click', () => {
    if (state.following)
      setFollowing(false);
    state.page = Math.min(state.pages - 1, state.page + 1);
    request(true);
  });

  scope.listen(elements.newer, 'click', () => { state.page = Math.max(0, state.page - 1); request(true); });

  scope.listen(elements.clear, 'click', () => {
    // The host clears asynchronously. Reset the data-derived column picker
    // immediately, rather than leaving the previous session's fields visible
    // until its next snapshot arrives.
    state.columnFields = [];
    minimumSnapshotGeneration = Math.max(minimumSnapshotGeneration, (state.generation ?? 0) + 1);
    table.resetAutomaticColumns();
    table.updateColumns([], true);
    table.renderFieldList();
    search.clearAutocomplete();
    api.postMessage({ type: 'clear' });
    request(true);
  });

  scope.listen(elements.stop, 'click', () => api.postMessage({ type: 'stop', serverId: state.selectedServer || undefined }));

  scope.listen(elements.config, 'click', () => api.postMessage({ type: 'config' }));

  scope.listen(elements.manage, 'click', () => api.postMessage({ type: 'manageServers' }));

  function exportRequest(type: 'export' | 'exportForAI') {
    api.postMessage({ type, query: elements.search.value, levels: state.currentLevels(), serverId: state.selectedServer || undefined });
  }

  scope.listen(elements.export, 'click', () => exportRequest('export'));

  scope.listen(elements.import, 'click', () => api.postMessage({ type: 'import' }));

  scope.listen(elements.run, 'click', () => api.postMessage({ type: 'run', serverId: elements.server.value || undefined }));

  scope.listen(document, 'visibilitychange', () => {
    if (!document.hidden)
      request();
  });

  // A push should arrive whenever data actually changes; this is only a
  // safety net in case one is ever missed.
  const fallbackTimer = setInterval(() => request(), 5000);

  request();
  return {
    state, bridge, table, search, inspection, receive,
    dispose() { scope.dispose(); clearInterval(fallbackTimer); clearTimeout(searchDebounce); clearTimeout(autocompleteDebounce); clearTimeout(copyFeedbackTimer); window.removeEventListener('message', onMessage); }
  };
}
