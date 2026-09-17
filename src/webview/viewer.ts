import type { HostMessage } from '../protocol/messages';
import { createAnalysis } from './analysis/charts';
import { SnapshotBridge } from './bridge';
import { getElements } from './dom';
import { EventScope } from './event-scope';
import { createInspection } from './inspection/context';
import { createPopovers } from './popovers';
import { createSearch } from './search/controls';
import { ViewerState } from './state';
import { LEVELS } from './state';
import { createTable } from './table/controller';
import { createCellActions } from './table/cell-actions';
import { createTimestampFormatter } from './time';
import type { WebviewApi } from './types';

export function createViewer(api: WebviewApi) {
  const scope = new EventScope();
  const elements = getElements();
  const scrollViewport = document.querySelector<HTMLElement>('.table-scroll')!;
  const saved = api.getState() ?? {};
  const state = new ViewerState(saved);
  elements.search.value = saved.query ?? '';
  const { popovers, createPopover } = createPopovers(scope);
  const formatTimestamp = createTimestampFormatter(state);
  const analysis = createAnalysis(elements, state);
  const inspection = createInspection(elements, scrollViewport, api, formatTimestamp, scope);
  const search = createSearch(elements, state, api, popovers, { filterChanged }, scope);
  const bridge = new SnapshotBridge(api, state, () => search.query());
  const request = (force = false) => bridge.request(force);
  let cellActions: ReturnType<typeof createCellActions> | undefined;
  const table = createTable(elements, scrollViewport, state, api, formatTimestamp,
    { request: requestInteraction, saveState, filterChanged, setFollowing, updateFollowControl, updateModeLabel }, scope, () => cellActions?.rowsChanged());
  let serverSignature = '';
  let sessionSignature = '';
  let guideUnread = document.body?.dataset.guideUnread === 'true';
  let agentSharingActive = false;
  elements.helpBadge.hidden = !guideUnread;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let autocompleteDebounce: ReturnType<typeof setTimeout> | undefined;
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
  cellActions = createCellActions(elements, () => table.events, () => search.query(), query => {
    clearTimeout(searchDebounce);
    clearTimeout(autocompleteDebounce);
    search.clearAutocomplete();
    search.setQuery(query, true);
    elements.search.focus();
  }, scope);
  // The host increments its generation when logs are cleared. An older
  // snapshot can arrive afterwards, so keep it from restoring the old schema.
  let minimumSnapshotGeneration = 0;
  const onMessage = (event: MessageEvent<HostMessage>) => receive(event.data);
  scope.listen(window, 'message', onMessage);
  function receive(data: HostMessage) {
    if (data.type === 'guideStatus') {
      updateGuideStatus(data);
      return;
    }
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
      // A response for draft text that was just cleared may still be in
      // transit, but an empty search should never open a field-name dropdown.
      if (data.input !== search.draft() || (data.serverId ?? '') !== state.selectedServer) return;
      if (search.draft().trim()) search.renderAutocomplete(data);
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
    if (data.guideStatus) updateGuideStatus(data.guideStatus);
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
    elements.captureToggle.textContent = data.captureStatus?.state === 'capturing' ? 'Capturing…'
      : data.captureStatus?.state === 'attention' ? 'Capture needs attention'
        : data.captureTerminals ? 'Terminal capture ready' : 'Enable terminal capture';
    elements.captureToggle.setAttribute('aria-pressed', String(data.captureTerminals));
    elements.captureToggle.title = data.captureStatus?.detail || 'Capture output from the next supported VS Code terminal command';
    const sharing = data.agentSharing?.active;
    agentSharingActive = Boolean(sharing);
    const sharedRuns = sharing ? data.agentSharing.sources.reduce((sum, source) => sum + (source.runs?.length ?? source.sessions), 0) : 0;
    const sharingAll = sharing && data.agentSharing.scope === 'all';
    elements.shareAgent.textContent = sharing ? 'Sharing logs · Stop' : 'Share logs with agent';
    elements.shareAgent.setAttribute('aria-pressed', String(Boolean(sharing)));
    elements.shareAgent.title = sharing
      ? sharingAll ? 'Existing and new captured logs are available to Copilot in this window. Click to stop sharing.'
        : `${sharedRuns} selected command run${sharedRuns === 1 ? '' : 's'} available to Copilot in this window. Click to stop sharing.`
      : 'Share existing and new captured logs in this window until stopped';
    elements.shareScope.hidden = !sharing;
    elements.shareScope.textContent = sharingAll ? 'Sharing existing and new runs in this window until stopped'
      : sharing ? `Sharing ${sharedRuns} selected run${sharedRuns === 1 ? '' : 's'} only` : '';
    elements.stop.textContent = state.selectedServer ? 'Stop server' : 'Stop all';
    const activeSessions = Array.isArray(data.sessions) ? data.sessions.filter(session => ['running', 'stopping'].includes(session.status)) : [];
    elements.sessions.textContent = activeSessions.length
      ? `${activeSessions.length} active session${activeSessions.length === 1 ? '' : 's'}` : 'No active sessions';
    let selectionChanged = false;
    if (data.servers) {
      const signature = JSON.stringify(data.servers.map(server => [server.id, server.label, server.status, server.activeSessions,
      server.taskName, server.taskType, server.dependencies, server.dependencyState, server.exitReason]));
      if (signature !== serverSignature) {
        serverSignature = signature;
        const activeCount = data.servers.reduce((sum, server) => sum + (server.activeSessions || 0), 0);
        const options = [document.createElement('option'), ...data.servers.map(() => document.createElement('option'))];
        options[0].textContent = activeCount ? `All sources · ${activeCount} active` : 'All sources';
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
        const selectedServer = data.servers.some(server => server.id === state.selectedServer) ? state.selectedServer : '';
        if (selectedServer !== state.selectedServer) {
          state.selectedServer = selectedServer;
          state.selectedSession = '';
          sessionSignature = '';
          selectionChanged = true;
        }
        elements.server.value = selectedServer;
      }
    }
    if (data.sessions) {
      const sessions = data.sessions.filter(session => !state.selectedServer || session.serverId === state.selectedServer);
      const signature = JSON.stringify(sessions.map(session => [session.id, session.serverId, session.command, session.status, session.startedAt, session.endedAt, session.captureStatus, session.captureReason]));
      if (signature !== sessionSignature) {
        sessionSignature = signature;
        const options = [document.createElement('option'), ...sessions.map(() => document.createElement('option'))];
        options[0].textContent = sessions.length ? `All runs · ${sessions.length}` : 'All runs';
        options[0].value = '';
        sessions.forEach((session, index) => {
          const started = session.startedAt ? new Date(session.startedAt).toLocaleTimeString() : '';
          const stateText = session.status === 'running' ? 'running' : (session.exitReason || session.status);
          options[index + 1].textContent = `${session.command || session.id} · ${started} · ${stateText}`;
          options[index + 1].value = session.id;
          options[index + 1].title = [session.cwd, session.captureStatus ? `Capture: ${session.captureStatus}` : undefined, session.captureReason].filter(Boolean).join(' · ');
        });
        elements.session.replaceChildren(...options);
        const selectedSession = sessions.some(session => session.id === state.selectedSession) ? state.selectedSession : '';
        if (selectedSession !== state.selectedSession) {
          state.selectedSession = selectedSession;
          selectionChanged = true;
        }
        elements.session.value = selectedSession;
      }
    }
    if (selectionChanged) {
      state.filterChanged();
      saveState();
      updateCopyResultsControl();
      bridge.refreshRequested = true;
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
  function saveState() { api.setState(state.persist(search.query())); }
  function hasActiveFilter() {
    return Boolean(search.query()) || state.checkedLevels.size !== LEVELS.length || Boolean(state.selectedServer) || Boolean(state.selectedSession);
  }
  function updateCopyResultsControl() {
    elements.copyResults.hidden = !hasActiveFilter();
    elements.copyResults.textContent = 'Copy results';
  }
  function updateGuideStatus(status: { unread: boolean; version: string }) {
    guideUnread = status.unread;
    elements.helpBadge.hidden = !status.unread;
    elements.help.setAttribute('aria-label', status.unread ? 'Open the Logline Guide — new features available' : 'Open the Logline Guide');
    elements.help.title = status.unread ? `Open the Logline Guide · New in ${status.version}` : 'Open the Logline Guide';
  }
  function requestInteraction() {
    if (state.paused) { state.browseFromInspection(); table.resetDetails(); table.renderWindow(); }
    updateFollowControl(); updateModeLabel(); request(true);
  }
  function filterChanged() { state.filterChanged(); updateCopyResultsControl(); saveState(); requestInteraction(); }

  scope.listen(elements.logs, 'click', event => {
    if (inspection.handleDetailAction(event))
      return;
    const button = (event.target as HTMLElement).closest<HTMLElement>('.message-button');
    if (!button)
      return;
    table.toggleExpand(Number(button.closest('tr')!.dataset.id));
  });

  scope.listen(elements.search, 'input', () => {
    search.clearAutocomplete();
    updateCopyResultsControl();
    clearTimeout(searchDebounce);
    // Filtering is committed by the editor's Enter handler. Retain a short
    // draft timer for compatibility with hosts that expect input activity to
    // be coalesced alongside autocomplete requests.
    searchDebounce = setTimeout(() => { searchDebounce = undefined; }, 150);
    clearTimeout(autocompleteDebounce);
    if (!search.draft().trim()) {
      search.clearAutocomplete();
      return;
    }
    autocompleteDebounce = setTimeout(() => {
      api.postMessage({ type: 'autocomplete', input: search.draft(), serverId: state.selectedServer || undefined });
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

  const actionsContainer = elements.moreActions.closest<HTMLElement>('.popover-container')!;
  const actionsMenu = createPopover(actionsContainer, elements.moreActions, elements.actionsMenu);
  const actionItems = [elements.shareSpecificRuns, elements.export, elements.import, elements.manage, elements.config, elements.help];
  scope.listen(elements.moreActions, 'click', () => {
    if (actionsMenu.isOpen()) actionItems[0].focus();
  });
  scope.listen(elements.moreActions, 'keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    actionsMenu.open();
    actionItems[event.key === 'ArrowUp' ? actionItems.length - 1 : 0].focus();
  });
  scope.listen(elements.actionsMenu, 'keydown', event => {
    if (event.key === 'Tab') {
      actionsMenu.close(true);
      return;
    }
    const index = actionItems.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? actionItems.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % actionItems.length
        : event.key === 'ArrowUp' ? (index - 1 + actionItems.length) % actionItems.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    actionItems[next].focus();
  });
  scope.listen(actionsContainer, 'focusout', event => {
    if (!actionsContainer.contains(event.relatedTarget as Node | null)) actionsMenu.close();
  });
  for (const item of actionItems) scope.listen(item, 'click', () => actionsMenu.close(true));

  scope.listen(elements.copyResults, 'click', () => {
    if (!hasActiveFilter()) return;
    api.postMessage({ type: 'copyFiltered', query: search.query(), levels: state.currentLevels(), serverId: state.selectedServer || undefined, sessionId: state.selectedSession || undefined });
    elements.copyResults.textContent = 'Copied';
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(updateCopyResultsControl, 1200);
  });

  scope.listen(elements.captureToggle, 'click', () => {
    const enabled = elements.captureToggle.getAttribute('aria-pressed') !== 'true';
    api.postMessage({ type: 'toggleTerminalCapture', enabled });
  });
  scope.listen(elements.shareAgent, 'click', () => {
    if (agentSharingActive) api.postMessage({ type: 'stopSharing' });
    else api.postMessage({ type: 'shareWithAgent' });
  });
  scope.listen(elements.shareSpecificRuns, 'click', () => api.postMessage({ type: 'shareWithAgent', chooseRuns: true }));

  scope.listen(elements.saveSearch, 'click', () => {
    for (const popover of popovers)
      popover.close();
    elements.saveSearchName.value = search.query() || '';
    elements.saveSearchDialog.showModal();
    elements.saveSearchName.select?.();
  });

  scope.listen(elements.saveSearchCancel, 'click', () => elements.saveSearchDialog.close());

  scope.listen(elements.saveSearchForm, 'submit', event => {
    event.preventDefault();
    const name = elements.saveSearchName.value;
    elements.saveSearchDialog.close();
    api.postMessage({ type: 'saveSearch', name, query: search.query(), levels: state.currentLevels(), serverId: state.selectedServer || undefined });
  });

  scope.listen(elements.analyze, 'click', () => {
    elements.analysisDialog.showModal();
    elements.analysisStatus.textContent = 'Loading analysis…';
    api.postMessage({ type: 'analysis', query: search.query(), levels: state.currentLevels(), serverId: state.selectedServer || undefined, sessionId: state.selectedSession || undefined });
  });

  scope.listen(elements.analysisClose, 'click', () => elements.analysisDialog.close());

  scope.listen(elements.server, 'change', () => {
    search.clearAutocomplete();
    state.selectedServer = elements.server.value;
    state.selectedSession = '';
    sessionSignature = '';
    state.page = 0;
    state.lastRows = undefined;
    table.resetAutomaticColumns();
    updateCopyResultsControl();
    saveState();
    requestInteraction();
  });
  scope.listen(elements.session, 'change', () => {
    state.selectedSession = elements.session.value;
    state.page = 0;
    state.lastRows = undefined;
    state.filterChanged();
    saveState();
    requestInteraction();
  });

  scope.listen(elements.follow, 'click', () => {
    if (state.paused || !state.following) {
      state.resume(); table.resetDetails(); saveState(); table.updateColumns(table.automaticColumns, true);
      updateFollowControl(); updateModeLabel(); request(true); table.scheduleRenderWindow(true);
    } else { setFollowing(false); updateFollowControl(); request(true); }
  });
  scope.listen(elements.older, 'click', () => {
    if (state.following && !state.paused)
      setFollowing(false);
    state.page = Math.min(state.pages - 1, state.page + 1);
    requestInteraction();
  });

  scope.listen(elements.newer, 'click', () => { state.page = Math.max(0, state.page - 1); requestInteraction(); });

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
    state.browseFromInspection();
    table.resetDetails();
    api.postMessage({ type: 'clear' });
    requestInteraction();
  });

  scope.listen(elements.stop, 'click', () => api.postMessage({ type: 'stop', serverId: state.selectedServer || undefined }));

  scope.listen(elements.config, 'click', () => api.postMessage({ type: 'config' }));

  scope.listen(elements.help, 'click', () => api.postMessage({ type: 'showGuide', section: guideUnread ? 'whatsNew' : 'guide' }));

  scope.listen(elements.manage, 'click', () => api.postMessage({ type: 'manageServers' }));

  function exportRequest(type: 'export' | 'exportForAI') {
    api.postMessage({ type, query: search.query(), levels: state.currentLevels(), serverId: state.selectedServer || undefined, sessionId: state.selectedSession || undefined });
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
