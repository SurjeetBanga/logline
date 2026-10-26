import type { HostMessage, Snapshot } from '../protocol/messages';
import { createAnalysis } from './analysis/charts';
import { addFilterTerm } from './search/cell-filter';
import { hasChangedScope, withChangedScope } from '../core/changed-query';
import { SnapshotBridge } from './bridge';
import { getElements, setLabel } from './dom';
import { createTooltips } from './tooltip';
import { EventScope } from './event-scope';
import { createInspection } from './inspection/context';
import { createTraceView } from './inspection/trace';
import { createTraceList } from './inspection/traces';
import { createMetricList } from './inspection/metrics';
import { createAiCalls } from './inspection/ai-calls';
import { createDoctor } from './inspection/doctor';
import { createPopovers } from './popovers';
import { createSearch } from './search/controls';
import { createConnectionBar } from './search/connection-bar';
import { createSourceRail } from './search/source-rail';
import { createSharePanel } from './share-panel';
import { createConnectionTab } from './connection-tab';
import { createRailResize } from './rail-resize';
import { createTabRail } from './tab-rail';
import { createTour } from './tour';
import { createCompare } from './inspection/compare';
import { createMetricQuery } from './inspection/metric-query';
import { ViewerState } from './state';
import { LEVELS } from './state';
import { createTable } from './table/controller';
import { createCellActions } from './table/cell-actions';
import { createTimestampFormatter } from './time';
import type { WebviewApi } from './types';
import { createViews, isTabName, tabOf, type TabName, type ViewName } from './views';

const HOLD_AFTER_MOVE_MS = 2000;
// Host status texts that say nothing new; the status bar shows only the others, such as a failure.
const STEADY_STATUS = new Set(['', 'Ready', 'Running', 'Idle', 'Stopped']);
const MIB = 1048576;

export function createViewer(api: WebviewApi) {
  const scope = new EventScope();
  const elements = getElements();
  const scrollViewport = document.querySelector<HTMLElement>('.table-scroll')!;
  // One formatter for every count: toLocaleString builds a new one per call.
  const numberFormat = new Intl.NumberFormat();
  const saved = api.getState() ?? {};
  const state = new ViewerState(saved);
  elements.search.value = saved.query ?? '';
  const { popovers, createPopover } = createPopovers(scope);
  const sharePanel = createSharePanel(elements, api, scope, createPopover);
  const tabRail = createTabRail(elements, state, scope, {
    saveState: () => saveState(),
    collapsedChanged: () => rail.applyCollapsed(),
  });
  createRailResize([elements.railResizer, elements.tabRailResizer], state, scope, { saveState: () => saveState() });
  createTooltips(scope);
  // The remembered tab, until the first snapshot says whether it has data.
  let restoreTab: TabName | undefined;
  const views = createViews(
    {
      logs: elements.logsTab,
      analysis: elements.analyze,
      compare: elements.compare,
      traces: elements.traces,
      metrics: elements.metrics,
      aiCalls: elements.aiCalls,
      doctor: elements.doctor,
      connection: elements.connectionTab,
    },
    {
      logs: elements.logsView,
      analysis: elements.analysisView,
      compare: elements.compareView,
      traces: elements.tracesView,
      trace: elements.traceView,
      metrics: elements.metricsView,
      aiCalls: elements.aiCallsView,
      aiCall: elements.aiCallView,
      doctor: elements.doctorView,
      connection: elements.connectionView,
    },
    scope,
    openView,
    viewChanged,
  );
  const connectionTab = createConnectionTab(
    elements,
    api,
    {
      show: (view) => views.show(view),
      active: () => views.active(),
      back: (tab) => openView(views.available(tab) ? tab : 'logs'),
    },
    (title, items) => tabRail.set('connection', title, items),
  );
  const formatTimestamp = createTimestampFormatter(state);
  const analysis = createAnalysis(
    elements,
    state,
    {
      drill: (term) => {
        const choice = addFilterTerm(search.query(), term);
        if (choice.query === undefined) {
          elements.analysisStatus.textContent = choice.reason;
          return;
        }
        views.show('logs');
        search.setQuery(choice.query, true);
      },
      selectSource: (id) => {
        views.show('logs');
        selectSource(id);
      },
    },
    scope,
  );
  const inspection = createInspection(elements, scrollViewport, api, formatTimestamp, scope, (traceId) =>
    traceView.show(traceId),
  );
  const search = createSearch(elements, state, api, popovers, { filterChanged, updateScopeSelection }, scope);
  const connectionBar = createConnectionBar(
    elements,
    state,
    api,
    scope,
    () => search.query(),
    saveState,
    (baselineServerId, baselineSessionId) => compareView.open({ baselineServerId, baselineSessionId }),
  );
  const rail = createSourceRail(elements, state, api, scope, {
    selectSource: (id) => selectSource(id),
    selectRun,
    saveState,
    query: () => search.query(),
    collapsedChanged: () => tabRail.applyCollapsed(),
  });
  const request = (force = false) => bridge.request(force);
  const traceView = createTraceView(elements, api, scope, {
    showContext: (id) => inspection.showContext(id),
    applyQuery: (query) => {
      views.show('logs');
      search.setQuery(query, true);
    },
    showList: () => traceList.show(),
    openAiCall: (traceId, spanId) => aiCalls.open(traceId, spanId),
    reveal: () => views.show('trace'),
    visible: () => views.active() === 'trace',
  });
  const traceList = createTraceList(elements, api, scope, {
    showTrace: (traceId) => traceView.show(traceId),
    formatTime: (ms) => formatTimestamp({ id: 0, level: '', timestampMs: ms }) ?? '',
    startReceiver: () => api.postMessage({ type: 'toggleOtlp', enabled: true }),
    receiver: () => ({ running: otlpRunning, endpoint: otlpEndpoint }),
    reveal: () => views.show('traces'),
    visible: () => views.active() === 'traces',
    rail: (title, items) => tabRail.set('traces', title, items),
  });
  const compareView = createCompare(elements, api, scope, {
    reveal: () => views.show('compare'),
    visible: () => views.active() === 'compare',
    formatTime: (ms) => formatTimestamp({ id: 0, level: '', timestampMs: ms }) ?? '',
    showContext: (id) => inspection.showContext(id),
    rail: (title, items) => tabRail.set('compare', title, items),
  });
  const metricQuery = createMetricQuery(elements, api, scope, {
    formatTime: (ms) => formatTimestamp({ id: 0, level: '', timestampMs: ms }) ?? '',
    showLogs: (connectionId, fromMs, toMs) =>
      api.postMessage({
        type: 'connectionFetch',
        connectionId,
        query: search.query(),
        range: state.connectionRange,
        fromMs,
        toMs,
      }),
    showLocal: (fromMs, toMs) => {
      views.show('logs');
      selectSource('');
      search.setQuery(`timestamp:[${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}]`, true);
    },
  });
  const metricList = createMetricList(elements, api, scope, {
    reveal: () => views.show('metrics'),
    visible: () => views.active() === 'metrics',
    rail: (title, items) => tabRail.set('metrics', title, items),
    queryConnection: (id) => {
      elements.metricConnection.value = id;
      elements.metricInput.focus();
    },
  });
  const aiCalls = createAiCalls(elements, api, scope, {
    showTrace: (traceId) => traceView.show(traceId),
    formatTime: (ms) => formatTimestamp({ id: 0, level: '', timestampMs: ms }) ?? '',
    revealList: () => views.show('aiCalls'),
    revealCall: () => views.show('aiCall'),
    listVisible: () => views.active() === 'aiCalls',
    callVisible: () => views.active() === 'aiCall',
    receiver: () => ({ running: otlpRunning, endpoint: otlpEndpoint }),
  });
  const doctor = createDoctor(
    elements.doctor,
    elements.doctorCount,
    elements.doctorView,
    elements.doctorList,
    api,
    scope,
    // Show events filters the table, so the table comes back into view.
    (action) => {
      if (action === 'showEvents') views.show('logs');
    },
    (id) => inspection.showContext(id),
    (traceId) => traceView.show(traceId),
  );
  let otlpRunning = false;
  // Files changed since the last commit; undefined outside a git repository.
  let changedFiles: number | undefined;
  let otlpEndpoint: string | undefined;
  let pointerOverRows = false;
  let heldEvents: Snapshot['events'];
  let lastPointerMove = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let cellActions: ReturnType<typeof createCellActions> | undefined;
  const table = createTable(
    elements,
    scrollViewport,
    state,
    api,
    formatTimestamp,
    { request: requestInteraction, saveState, filterChanged, setFollowing, updateFollowControl, updateModeLabel },
    scope,
    () => cellActions?.rowsChanged(),
  );
  const bridge = new SnapshotBridge(
    api,
    state,
    () => search.query(),
    () => table.currentColumns,
    () => doctor.revision(),
  );
  let visibleSources: Snapshot['servers'] = [];
  /** The line above Analyze: what it covers, with the source by name once the snapshot has named it. */
  function analysisContext(): void {
    const filter = search.query();
    const source = state.selectedServer
      ? (visibleSources.find((server) => server.id === state.selectedServer)?.label ?? state.selectedServer)
      : '';
    elements.analysisStatus.textContent = `${filter ? `Logs matching ${filter}` : 'All retained logs'}${source ? ` from ${source}` : ''}${state.currentLevels() ? ' at the selected levels' : ''}. Click a bar, value, pattern or error group to show its logs.`;
  }
  // Every run in the latest snapshot, and those of the selected source.
  let allSessions: Snapshot['sessions'] = [];
  let visibleSessions: Snapshot['sessions'] = [];
  let guideUnread = document.body?.dataset.guideUnread === 'true';
  elements.helpBadge.hidden = !guideUnread;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;
  let autocompleteDebounce: ReturnType<typeof setTimeout> | undefined;
  cellActions = createCellActions(
    elements,
    () => table.events,
    () => search.query(),
    (query) => {
      clearTimeout(searchDebounce);
      clearTimeout(autocompleteDebounce);
      search.clearAutocomplete();
      search.setQuery(query, true);
      elements.search.focus();
    },
    scope,
  );
  // The host increments its generation when logs are cleared. An older
  // snapshot can arrive afterwards, so keep it from restoring the old schema.
  let minimumSnapshotGeneration = 0;
  const onMessage = (event: MessageEvent<HostMessage>) => {
    if (event.data?.type !== 'snapshot') {
      receive(event.data);
      return;
    }
    // Measure before the snapshot writes anything, so rendering its rows needs no forced layout.
    table.measureViewport();
    try {
      receive(event.data);
    } finally {
      table.releaseViewport();
    }
  };
  scope.listen(window, 'message', onMessage);
  function receive(data: HostMessage) {
    if (data.type === 'connectionForm') {
      connectionTab.receive(data);
      return;
    }
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
      request(true);
      return;
    }
    if (data.type === 'context') {
      inspection.receiveContext(data);
      return;
    }
    if (data.type === 'trace') {
      traceView.receive(data.trace);
      return;
    }
    if (data.type === 'traces') {
      traceList.receive(data.traces);
      return;
    }
    if (data.type === 'metrics') {
      metricList.receive(data.metrics);
      return;
    }
    if (data.type === 'metricQuery') {
      metricQuery.receive(data);
      return;
    }
    if (data.type === 'metricNames') {
      metricQuery.receiveNames(data);
      return;
    }
    if (data.type === 'compare') {
      compareView.receive(data);
      return;
    }
    if (data.type === 'connectionPreview') {
      connectionBar.receivePreview(data);
      return;
    }
    if (data.type === 'aiCalls') {
      aiCalls.receive(data.aiCalls);
      return;
    }
    if (data.type === 'aiCall') {
      aiCalls.receiveCall(data);
      return;
    }
    if (data.type === 'details') {
      if (data.target === 'context') inspection.receiveDetails(data);
      else table.receiveDetails(data);
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
      analysisContext();
      analysis.renderAnalysis(data.analysis);
      return;
    }
    if (data.type === 'searches') {
      search.renderSearchState(data.searches);
      return;
    }
    if (data.type === 'snapshotError') {
      if (bridge.failed(data.requestId)) {
        elements.status.textContent = `Snapshot failed: ${data.message}`;
        bridge.flush();
      }
      return;
    }
    if (data.type !== 'snapshot') return;
    if (data.guideStatus) updateGuideStatus(data.guideStatus);
    bridge.received(data.requestId);
    const rows = bridge.rows(data);
    // A filter requested from the editor (a log statement's CodeLens).
    if (data.applyQuery !== undefined && data.applyQuery !== search.query()) {
      views.show('logs');
      search.setQuery(data.applyQuery, true);
    }
    if (data.openTrace) traceView.show(data.openTrace);
    if (data.startTour) scope.frame(() => startTour());
    // The guide's Show me: point at the control once this snapshot is on screen.
    const reveal = data.reveal;
    if (reveal) scope.frame(() => revealControl(reveal.target, reveal.fallback));
    // A source and run chosen from the editor, such as a connection just added or a search just run. This
    // snapshot's rows and columns belong to the previous selection, so the next one is rendered instead.
    if (
      data.applySource &&
      data.servers?.some((server) => server.id === data.applySource) &&
      (data.applySource !== state.selectedServer || (data.applyRun ?? '') !== state.selectedSession)
    ) {
      views.show('logs');
      selectSource(data.applySource, data.applyRun);
      if (data.openConnectionForm) connectionTab.open(data.openConnectionForm);
      bridge.flush();
      return;
    }
    // Opened here rather than with the rest of the snapshot, which a stale generation skips below.
    if (data.openConnectionForm) connectionTab.open(data.openConnectionForm);
    const receiverWasRunning = otlpRunning;
    otlpRunning = data.otlp?.running === true;
    otlpEndpoint = data.otlp?.endpoint;
    if (otlpRunning !== receiverWasRunning) traceList.receiverChanged();
    // The receiver's chip shows whether it runs, and starts or stops it.
    elements.otlpStatus.setAttribute('aria-pressed', String(otlpRunning));
    elements.otlpStatus.textContent = otlpRunning
      ? `OpenTelemetry ${data.otlp?.endpoint?.replace(/^https?:\/\//, '') ?? ''}`.trim()
      : 'OpenTelemetry off';
    elements.otlpStatus.title = otlpRunning
      ? `Receiving OpenTelemetry logs, traces, and metrics on ${data.otlp?.endpoint ?? 'localhost'}${data.otlp?.error ? ` (${data.otlp.error})` : ''}. Click to stop the receiver.`
      : 'Receive OpenTelemetry logs, traces, and metrics from instrumented apps on this machine. Click to start the receiver.';
    doctor.receive(data.doctor);
    changedFiles = data.changes?.files;
    updateChangesControl();
    // A connection can be queried for metrics, so the tab shows with one too.
    metricList.update(data.metrics, otlpRunning || !!data.connections?.length);
    metricQuery.update(data.connections);
    metricList.setConnections(data.connections);
    aiCalls.update(data.aiCalls, otlpRunning);
    views.ensureVisible();
    elements.traceCount.hidden = !data.traceCount;
    elements.traceCount.textContent = data.traceCount ? numberFormat.format(data.traceCount) : '';
    elements.traces.title = data.traceCount
      ? `${numberFormat.format(data.traceCount)} traces received from OpenTelemetry. Show requests across services.`
      : 'Requests across services, from OpenTelemetry spans and logs with a trace id';
    if (data.generation < minimumSnapshotGeneration) {
      bridge.flush();
      return;
    }
    minimumSnapshotGeneration = 0;
    const generationChanged = state.generation !== undefined && state.generation !== data.generation;
    if (generationChanged && !state.paused) {
      state.before = undefined;
      state.page = 0;
      state.lastRows = undefined;
      state.selected = undefined;
      state.selectedDetailText = undefined;
      state.selectedExceptions = [];
      table.resetDetails();
      table.resetAutomaticColumns();
      bridge.forget();
      table.renderRows([]);
      bridge.refreshRequested = true;
    }
    // While a row is open the reset is deferred, so keep the old generation
    // until then; the first snapshot after inspection ends applies it.
    if (!generationChanged || !state.paused) state.generation = data.generation;
    if (data.timezone && data.timezone !== state.displayTimezone) {
      state.displayTimezone = data.timezone;
      state.lastRows = undefined;
      table.invalidateRows();
    }
    if (data.newestFirst !== undefined && data.newestFirst !== state.newestFirst) {
      state.newestFirst = data.newestFirst;
      state.lastRows = undefined;
      table.renderRows(table.events);
    }
    state.newest = data.newest;
    if (!state.following && state.before === undefined) state.before = state.newest;
    // The OpenTelemetry chip already shows where the receiver listens.
    elements.status.textContent =
      otlpRunning && data.status.startsWith('OpenTelemetry receiver on') ? 'Ready' : data.status;
    // Only news is shown: a steady state is already visible in the rail and the chips.
    elements.status.hidden = STEADY_STATUS.has(elements.status.textContent);
    setLabel(
      elements.captureToggle,
      data.captureStatus?.state === 'capturing'
        ? 'Capturing…'
        : data.captureStatus?.state === 'attention'
          ? 'Capture needs attention'
          : data.captureTerminals
            ? 'Capture on'
            : 'Capture off',
    );
    elements.captureToggle.setAttribute('aria-pressed', String(data.captureTerminals));
    elements.captureToggle.title =
      data.captureStatus?.detail ||
      (data.captureTerminals
        ? 'Terminal capture is on. Click to turn it off.'
        : 'Terminal capture is off. Click to turn it on.');
    const sharing = data.agentSharing?.active;
    sharePanel.update(data);
    const sharedRuns = sharing
      ? data.agentSharing.sources.reduce((sum, source) => sum + (source.runs?.length ?? source.sessions), 0)
      : 0;
    const sharingAll = sharing && data.agentSharing.scope === 'all';
    // While sharing, the button says what pressing it does; the status bar says what is shared.
    setLabel(elements.shareAgent, sharing ? 'Stop sharing' : 'Share with agent');
    elements.shareAgent.setAttribute('aria-pressed', String(Boolean(sharing)));
    elements.shareAgent.title = sharing
      ? sharingAll
        ? 'Existing and new captured logs are available to agents in this window: Copilot, and Claude Code or Codex if connected. Click to stop sharing.'
        : `${sharedRuns} selected command run${sharedRuns === 1 ? '' : 's'} available to agents in this window. Click to stop sharing.`
      : 'Share existing and new captured logs with Copilot, Claude Code, Codex, or other connected agents until stopped';
    elements.shareScope.hidden = !sharing;
    // Which MCP clients are reading, so sharing never happens unnoticed.
    const readers = sharing && data.agentClients?.length ? ` · read by ${data.agentClients.join(', ')}` : '';
    elements.shareScope.textContent =
      (sharingAll ? 'Sharing all runs' : sharing ? `Sharing ${sharedRuns} run${sharedRuns === 1 ? '' : 's'}` : '') +
      readers;
    elements.shareScope.title = sharingAll
      ? 'Agents can read existing and new runs in this window, redacted, until you stop sharing.'
      : sharing
        ? `Agents can read ${sharedRuns} selected run${sharedRuns === 1 ? '' : 's'} in this window, redacted, until you stop sharing. Later commands are not included.`
        : '';
    let selectionChanged = false;
    if (data.servers) {
      visibleSources = data.servers;
      if (elements.analysisStatus.textContent) analysisContext();
      const selectedServer = data.servers.some((server) => server.id === state.selectedServer)
        ? state.selectedServer
        : '';
      if (selectedServer !== state.selectedServer) {
        state.selectedServer = selectedServer;
        state.selectedSession = '';
        selectionChanged = true;
      }
    }
    connectionBar.update(data.connections);
    compareView.update(data.sessions, data.servers, data.newest);
    // Tabs such as Metrics and Compare appear only once the snapshot says they have data.
    if (restoreTab) {
      const tab = restoreTab;
      restoreTab = undefined;
      if (views.available(tab)) openView(tab);
    }
    if (data.openCompare) compareView.open(data.openCompare);
    if (data.sessions) {
      allSessions = data.sessions;
      visibleSessions = sessionsFor(state.selectedServer);
      const selectedSession = visibleSessions.some((session) => session.id === state.selectedSession)
        ? state.selectedSession
        : '';
      if (selectedSession !== state.selectedSession) {
        state.selectedSession = selectedSession;
        selectionChanged = true;
      }
    }
    rail.update({
      servers: data.servers,
      sessions: data.sessions ? visibleSessions : undefined,
      connections: data.connections ?? [],
    });
    connectionTab.setConnections(data.connections ?? []);
    if (selectionChanged) {
      state.filterChanged();
      saveState();
      updateCopyResultsControl();
      bridge.refreshRequested = true;
    }
    const number = (value: number) => numberFormat.format(value);
    renderMemory(data, number);
    updateModeLabel();
    if (Array.isArray(data.columnFields)) state.columnFields = data.columnFields;
    table.updateColumns(data.columns ?? []);
    if (rows?.length) table.lockAutomaticColumns();
    table.renderFieldList();
    if (Array.isArray(data.fields)) state.allFields = data.fields;
    if (data.searches) search.renderSearchState(data.searches);
    if (rows && !bridge.refreshRequested && !state.paused && holdingLive()) {
      // Rows would move under the pointer; show them when it leaves the table.
      heldEvents = rows;
      updateModeLabel();
    } else if (rows && !bridge.refreshRequested && !state.paused) {
      heldEvents = undefined;
      state.page = data.page ?? 0;
      state.pages = data.pages ?? 1;
      const matched = data.matched ?? 0;
      elements.page.textContent = matched ? `${number(matched)} match${matched === 1 ? '' : 'es'}` : 'No matches';
      elements.pageNumber.textContent = `${state.page + 1} / ${state.pages}`;
      elements.older.disabled = state.page >= state.pages - 1;
      elements.newer.disabled = state.page === 0;
      // A partial refresh that added nothing returns the same array.
      if (rows !== table.events || state.lastRows === undefined) {
        const signature = rows.map((event) => event.id).join(',');
        if (signature !== state.lastRows) {
          state.lastRows = signature;
          table.renderRows(rows);
        }
      }
      elements.empty.hidden = rows.length > 0;
      elements.rowHint.hidden = state.rowHintDismissed || !rows.length;
      elements.empty.textContent =
        connectionBar.emptyText() ??
        (data.total ? 'No matching events in retained history.' : 'Run a server command to see its logs here.');
      if (state.following && !state.paused && !state.selectedSort) table.scheduleRenderWindow(true);
    }
    bridge.flush();
  }

  // While following live, new rows push the table up every refresh, so a row
  // can move away between pointing at it and clicking. Hold the rows while the
  // pointer moves over them, and catch up once it rests for a moment or
  // leaves, so a pointer parked on the table does not freeze the view.
  function holdingLive() {
    return (
      pointerOverRows && Date.now() - lastPointerMove < HOLD_AFTER_MOVE_MS && state.following && !state.selectedSort
    );
  }
  function pointerMoved() {
    pointerOverRows = true;
    lastPointerMove = Date.now();
    if (!holdTimer) holdTimer = setTimeout(checkHold, HOLD_AFTER_MOVE_MS);
  }
  // One timer per pause in movement, not per pointermove.
  function checkHold() {
    holdTimer = undefined;
    const rested = Date.now() - lastPointerMove;
    if (pointerOverRows && rested < HOLD_AFTER_MOVE_MS) {
      holdTimer = setTimeout(checkHold, HOLD_AFTER_MOVE_MS - rested);
      return;
    }
    releaseHeld();
  }
  scope.listen(scrollViewport, 'pointerenter', pointerMoved);
  scope.listen(scrollViewport, 'pointermove', pointerMoved);
  scope.listen(scrollViewport, 'pointerleave', () => {
    pointerOverRows = false;
    releaseHeld();
  });
  function releaseHeld() {
    const events = heldEvents;
    heldEvents = undefined;
    if (events && state.following && !state.paused) {
      state.lastRows = events.map((event) => event.id).join(',');
      table.renderRows(events);
      elements.empty.hidden = events.length > 0;
      table.scheduleRenderWindow(true);
    }
    updateModeLabel();
  }

  function updateFollowControl() {
    if (state.paused) {
      elements.follow.setAttribute('aria-pressed', 'false');
      elements.follow.setAttribute('aria-label', 'Resume live updates');
      elements.follow.title = 'Paused while you inspect an event; capture continues. Click to resume live logs.';
      elements.follow.dataset.mode = 'resume';
      setLabel(elements.follow, 'Resume');
      return;
    }
    elements.follow.setAttribute('aria-pressed', String(state.following));
    elements.follow.setAttribute('aria-label', state.following ? 'Live updates' : 'Browse retained history');
    elements.follow.title = state.following
      ? 'Live: new logs appear as they arrive. Click to stop following and browse history.'
      : 'Browsing history: the table stays where it is. Click to follow live logs.';
    elements.follow.dataset.mode = state.following ? 'live' : 'browse';
    setLabel(elements.follow, state.following ? 'Live' : 'Browse');
  }

  function updateModeLabel() {
    const older = state.selectedSort ? 'Next page' : 'Older page';
    const newer = state.selectedSort ? 'Previous page' : 'Newer page';
    elements.older.setAttribute('aria-label', older);
    elements.older.title = older;
    elements.newer.setAttribute('aria-label', newer);
    elements.newer.title = newer;
    elements.mode.textContent = state.paused
      ? 'Paused — collection continues'
      : state.selectedSort
        ? `Sorted ${state.selectedSortDirection === 'asc' ? 'ascending' : 'descending'}${state.following ? ' · Live updates' : ''}`
        : state.following
          ? heldEvents
            ? 'Live · new rows held while you point at the table'
            : 'Live · newest 1,000'
          : state.newestFirst && state.page === 0 && state.before !== undefined && state.newest > state.before
            ? 'Browsing · newer logs arrived — scroll to the top for Live'
            : 'Browsing retained history';
    elements.mode.className = state.following && !state.paused ? 'live-mode' : '';
    // Plain Live is what the Live button already says; anything else is worth a word.
    elements.mode.hidden = state.following && !state.paused && !heldEvents && !state.selectedSort;
  }

  function setFollowing(value: boolean) {
    state.setFollowing(value);
    updateFollowControl();
    updateModeLabel();
  }
  function saveState() {
    api.setState(state.persist(search.query()));
  }
  function hasActiveFilter() {
    return (
      Boolean(search.query()) ||
      state.checkedLevels.size !== LEVELS.length ||
      Boolean(state.selectedServer) ||
      Boolean(state.selectedSession)
    );
  }
  function updateCopyResultsControl() {
    elements.copyResults.hidden = !hasActiveFilter();
  }
  // Shown in a git repository, and whenever the filter already uses it so it can be turned off.
  function updateChangesControl() {
    const on = hasChangedScope(search.query());
    const button = elements.changedOnly;
    button.hidden = changedFiles === undefined && !on;
    button.setAttribute('aria-pressed', String(on));
    const tooLong = !on && withChangedScope(search.query(), true).length > 256;
    button.disabled = tooLong;
    button.title = tooLong
      ? 'The filter is too long to add changed:true. Remove a filter first.'
      : changedFiles === undefined
        ? 'Not in a git repository, so no code counts as changed. Click to remove the filter.'
        : `${on ? 'Showing' : 'Show'} only logs from code changed since the last commit (${numberFormat.format(changedFiles)} ${changedFiles === 1 ? 'file' : 'files'}): the statement that logged them, or a stack frame in their exception, is on a changed line`;
  }
  function updateGuideStatus(status: { unread: boolean; version: string }) {
    guideUnread = status.unread;
    elements.helpBadge.hidden = !status.unread;
    elements.help.setAttribute(
      'aria-label',
      status.unread ? 'Open the Logline Guide — new features available' : 'Open the Logline Guide',
    );
    elements.help.title = status.unread
      ? `Open the Logline Guide · New in ${status.version}`
      : 'Open the Logline Guide';
  }
  function requestInteraction() {
    if (state.paused) {
      state.browseFromInspection();
      table.resetDetails();
      table.renderWindow();
    }
    updateFollowControl();
    updateModeLabel();
    request(true);
    // Analyze always shows the current filter, source, and run.
    if (views.active() === 'analysis') requestAnalysis();
  }
  function filterChanged() {
    state.filterChanged();
    updateCopyResultsControl();
    updateChangesControl();
    connectionBar.queryChanged();
    saveState();
    requestInteraction();
  }

  scope.listen(elements.logs, 'click', (event) => {
    const target = event.target as HTMLElement;
    const dismiss = target.closest<HTMLElement>('.dismiss-hint');
    if (dismiss) {
      state.cellHintDismissed = true;
      saveState();
      dismiss.closest('.detail-hint')?.remove();
      return;
    }
    if (doctor.handleAction(event) || inspection.handleDetailAction(event)) return;
    const rowButton = target.closest<HTMLElement>('.row-icon, .row-action');
    const rowId = Number(rowButton?.dataset.id);
    if (rowButton && Number.isSafeInteger(rowId)) {
      if (rowButton.classList.contains('row-site-button')) api.postMessage({ type: 'openLogSite', id: rowId });
      else if (rowButton.classList.contains('row-break-button')) api.postMessage({ type: 'breakOnEvent', id: rowId });
      else if (
        rowButton.classList.contains('row-context-button') ||
        rowButton.classList.contains('row-attached-button')
      )
        inspection.showContext(rowId);
      else if (rowButton.classList.contains('row-finding-button') && state.selected !== rowId) toggleExpand(rowId);
      return;
    }
    const trace = (event.target as HTMLElement).closest<HTMLElement>('.row-trace-button');
    if (trace?.dataset.traceId) {
      traceView.show(trace.dataset.traceId);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>('.message-button');
    if (!button) return;
    toggleExpand(Number(button.closest('tr')!.dataset.id));
  });

  scope.listen(elements.search, 'input', () => {
    search.clearAutocomplete();
    updateCopyResultsControl();
    clearTimeout(searchDebounce);
    // Filtering is committed by the editor's Enter handler. Retain a short
    // draft timer for compatibility with hosts that expect input activity to
    // be coalesced alongside autocomplete requests.
    searchDebounce = setTimeout(() => {
      searchDebounce = undefined;
    }, 150);
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

  createPopover(
    elements.levelButton.closest<HTMLElement>('.popover-container')!,
    elements.levelButton,
    elements.levelMenu,
  );

  createPopover(
    elements.searchHelp.closest<HTMLElement>('.popover-container')!,
    elements.searchHelp,
    elements.searchHelpPanel,
  );

  createPopover(
    elements.searchTools.closest<HTMLElement>('.popover-container')!,
    elements.searchTools,
    elements.searchToolsPanel,
  );

  createPopover(
    elements.fieldsButton.closest<HTMLElement>('.popover-container')!,
    elements.fieldsButton,
    elements.fieldsPanel,
  );

  const actionsContainer = elements.moreActions.closest<HTMLElement>('.popover-container')!;
  // Findings shown in an expanded event inside Surrounding logs act the same way.
  scope.listen(elements.contextDetails, 'click', (event) => {
    doctor.handleAction(event);
  });
  scope.listen(elements.rowHintDismiss, 'click', dismissRowHint);
  function dismissRowHint() {
    if (!state.rowHintDismissed) {
      state.rowHintDismissed = true;
      saveState();
    }
    elements.rowHint.hidden = true;
  }
  function toggleExpand(id: number) {
    table.toggleExpand(id);
  }
  const actionsMenu = createPopover(actionsContainer, elements.moreActions, elements.actionsMenu);
  const actionItems = [
    elements.copyResults,
    elements.export,
    elements.import,
    elements.clear,
    elements.breakOnLogs,
    elements.manage,
    elements.config,
    elements.help,
    elements.takeTour,
  ];
  // Copy filtered results is hidden without a filter; keyboard navigation skips it.
  const shownActions = () => actionItems.filter((item) => !item.hidden);
  scope.listen(elements.moreActions, 'click', () => {
    if (actionsMenu.isOpen()) shownActions()[0].focus();
  });
  scope.listen(elements.moreActions, 'keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    actionsMenu.open();
    const items = shownActions();
    items[event.key === 'ArrowUp' ? items.length - 1 : 0].focus();
  });
  scope.listen(elements.actionsMenu, 'keydown', (event) => {
    if (event.key === 'Tab') {
      actionsMenu.close(true);
      return;
    }
    const items = shownActions();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : event.key === 'ArrowUp'
              ? (index - 1 + items.length) % items.length
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  });
  scope.listen(actionsContainer, 'focusout', (event) => {
    if (!actionsContainer.contains(event.relatedTarget as Node | null)) actionsMenu.close();
  });
  for (const item of actionItems) scope.listen(item, 'click', () => actionsMenu.close(true));

  scope.listen(elements.copyResults, 'click', () => {
    if (!hasActiveFilter()) return;
    api.postMessage({
      type: 'copyFiltered',
      query: search.query(),
      levels: state.currentLevels(),
      serverId: state.selectedServer || undefined,
      sessionId: state.selectedSession || undefined,
    });
  });

  scope.listen(elements.captureToggle, 'click', () => {
    const enabled = elements.captureToggle.getAttribute('aria-pressed') !== 'true';
    api.postMessage({ type: 'toggleTerminalCapture', enabled });
  });
  scope.listen(elements.shareScope, 'click', (event) => {
    event.stopPropagation();
    sharePanel.open();
  });
  scope.listen(elements.statusIcon, 'click', () => api.postMessage({ type: 'showStatus' }));

  // The tour: one stop per area of the panel, from the menu, the guide, or the first-run welcome.
  const tour = createTour(scope, {
    prepare: () => {
      if (views.active() !== 'logs') views.show('logs');
      for (const popover of popovers) popover.close();
    },
    ended: () => undefined,
  });
  function startTour(): void {
    elements.tourHint.hidden = true;
    if (elements.welcomeDialog.open) elements.welcomeDialog.close();
    tour.start();
  }
  scope.listen(elements.takeTour, 'click', () => startTour());
  scope.listen(elements.tourHintStart, 'click', () => startTour());
  scope.listen(elements.tourHintDismiss, 'click', () => (elements.tourHint.hidden = true));
  /** Leave the welcome, remembering it was seen, and do what was chosen. */
  const welcomeChoice = (then: () => void) => () => {
    elements.welcomeDialog.close();
    api.postMessage({ type: 'onboardingSeen' });
    then();
  };
  scope.listen(
    elements.welcomeTour,
    'click',
    welcomeChoice(() => tour.start()),
  );
  scope.listen(
    elements.welcomeExplore,
    'click',
    welcomeChoice(() => (elements.tourHint.hidden = false)),
  );
  scope.listen(
    elements.welcomeCapture,
    'click',
    welcomeChoice(() => api.postMessage({ type: 'toggleTerminalCapture', enabled: true })),
  );
  scope.listen(
    elements.welcomeImport,
    'click',
    welcomeChoice(() => api.postMessage({ type: 'import' })),
  );
  scope.listen(
    elements.welcomeConnection,
    'click',
    welcomeChoice(() => api.postMessage({ type: 'addConnection' })),
  );
  scope.listen(
    elements.welcomeOtel,
    'click',
    welcomeChoice(() => api.postMessage({ type: 'toggleOtlp', enabled: true })),
  );
  // Escape on the welcome counts as exploring: it never shows again.
  scope.listen(elements.welcomeDialog, 'cancel', () => {
    api.postMessage({ type: 'onboardingSeen' });
    elements.tourHint.hidden = false;
  });
  if (document.body?.dataset.firstRun === 'true') elements.welcomeDialog.showModal?.();
  createPopover(elements.counts.closest<HTMLElement>('.popover-container')!, elements.counts, elements.memoryPanel);
  scope.listen(elements.memorySettings, 'click', () =>
    api.postMessage({ type: 'config', setting: 'logline.maxMemoryMb' }),
  );

  scope.listen(elements.saveSearch, 'click', () => {
    for (const popover of popovers) popover.close();
    elements.saveSearchName.value = search.query() || '';
    elements.saveSearchDialog.showModal();
    elements.saveSearchName.select?.();
  });

  scope.listen(elements.saveSearchCancel, 'click', () => elements.saveSearchDialog.close());

  scope.listen(elements.saveSearchForm, 'submit', (event) => {
    event.preventDefault();
    const name = elements.saveSearchName.value;
    elements.saveSearchDialog.close();
    api.postMessage({
      type: 'saveSearch',
      name,
      query: search.query(),
      levels: state.currentLevels(),
      serverId: state.selectedServer || undefined,
    });
  });

  scope.listen(elements.changedOnly, 'click', () => {
    search.setQuery(withChangedScope(search.query(), !hasChangedScope(search.query())), true);
  });
  function requestAnalysis() {
    elements.analysisStatus.textContent = 'Loading analysis…';
    api.postMessage({
      type: 'analysis',
      query: search.query(),
      levels: state.currentLevels(),
      serverId: state.selectedServer || undefined,
      sessionId: state.selectedSession || undefined,
    });
  }

  /** Opens a view from its tab, loading what it shows. */
  function openView(tab: TabName) {
    if (tab === 'analysis') {
      views.show('analysis');
      requestAnalysis();
    } else if (tab === 'traces') traceList.show();
    else if (tab === 'metrics') metricList.show();
    else if (tab === 'compare') compareView.show();
    else if (tab === 'aiCalls') aiCalls.show();
    else views.show(tab);
  }

  function viewChanged(view: ViewName, previous: ViewName) {
    restoreTab = undefined;
    if (previous === 'trace') traceView.hide();
    if (previous === 'metrics') metricList.hide();
    if (previous === 'compare') compareView.hide();
    if (previous === 'aiCalls') aiCalls.hide();
    if (previous === 'aiCall') aiCalls.close();
    state.view = tabOf(view);
    tabRail.show(tabOf(view));
    saveState();
  }

  function resumeLive() {
    state.resume();
    table.resetDetails();
    saveState();
    table.updateColumns(table.automaticColumns, true);
    updateFollowControl();
    updateModeLabel();
    request(true);
    table.scheduleRenderWindow(true);
  }
  scope.listen(elements.follow, 'click', () => {
    if (state.paused || !state.following) resumeLive();
    else {
      setFollowing(false);
      updateFollowControl();
      request(true);
    }
  });
  // With the newest on top, Live sits at the top of the table. Scrolling down
  // to read stops it, so rows hold still instead of being pushed down by new
  // ones; scrolling back to the top resumes it.
  let lastScrollTop = 0;
  scope.listen(scrollViewport, 'scroll', () => {
    const top = scrollViewport.scrollTop;
    const wasAtTop = lastScrollTop <= 1;
    lastScrollTop = top;
    if (!state.newestFirst || state.paused || state.selectedSort) return;
    if (state.following && top > 1) setFollowing(false);
    else if (!state.following && top <= 1 && !wasAtTop && state.page === 0) resumeLive();
  });
  scope.listen(elements.older, 'click', () => {
    if (state.following && !state.paused) setFollowing(false);
    state.page = Math.min(state.pages - 1, state.page + 1);
    requestInteraction();
  });

  scope.listen(elements.newer, 'click', () => {
    state.page = Math.max(0, state.page - 1);
    requestInteraction();
  });

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

  scope.listen(elements.config, 'click', () => api.postMessage({ type: 'config' }));

  scope.listen(elements.help, 'click', () =>
    api.postMessage({ type: 'showGuide', section: guideUnread ? 'whatsNew' : 'guide' }),
  );

  scope.listen(elements.manage, 'click', () => api.postMessage({ type: 'manageServers' }));
  scope.listen(elements.otlpStatus, 'click', () => api.postMessage({ type: 'toggleOtlp', enabled: !otlpRunning }));

  function exportRequest(type: 'export' | 'exportForAI') {
    api.postMessage({
      type,
      query: search.query(),
      levels: state.currentLevels(),
      serverId: state.selectedServer || undefined,
      sessionId: state.selectedSession || undefined,
    });
  }

  scope.listen(elements.export, 'click', () => exportRequest('export'));

  scope.listen(elements.import, 'click', () => api.postMessage({ type: 'import' }));
  scope.listen(elements.breakOnLogs, 'click', () =>
    api.postMessage({ type: 'breakOnQuery', query: search.query(), levels: state.currentLevels() }),
  );

  scope.listen(document, 'visibilitychange', () => {
    if (!document.hidden) request();
  });

  // A push should arrive whenever data actually changes; this is only a
  // safety net in case one is ever missed.
  const fallbackTimer = setInterval(() => request(), 5000);

  // The panel reopens on the tab it was left on: now when its tab is shown,
  // else once the first snapshot says whether it has data.
  views.show('logs');
  if (state.view !== 'logs' && isTabName(state.view)) {
    if (views.available(state.view)) openView(state.view);
    else restoreTab = state.view;
  }

  request();
  connectionTab.resume();
  return {
    state,
    views,
    bridge,
    table,
    search,
    inspection,
    traceView,
    traceList,
    receive,
    dispose() {
      scope.dispose();
      clearInterval(fallbackTimer);
      clearTimeout(holdTimer);
      clearTimeout(searchDebounce);
      clearTimeout(autocompleteDebounce);
      window.removeEventListener('message', onMessage);
    },
  };

  /** Which tab shows a view panel. */
  function tabForPanel(id: string): TabName | undefined {
    const tabs: Record<string, TabName> = {
      logsView: 'logs',
      analysisView: 'analysis',
      compareView: 'compare',
      tracesView: 'traces',
      traceView: 'traces',
      metricsView: 'metrics',
      aiCallsView: 'aiCalls',
      aiCallView: 'aiCalls',
      doctorView: 'doctor',
      connectionView: 'connection',
    };
    return tabs[id];
  }

  /** Whether an element is shown: neither it nor anything around it is hidden. */
  function shown(element: HTMLElement | null): boolean {
    for (let node = element; node; node = node.parentElement) if (node.hidden) return false;
    return Boolean(element);
  }

  /** Open what holds a control, such as its menu or tab; false when it cannot be shown. */
  function bringIntoView(element: HTMLElement): boolean {
    if (elements.actionsMenu.contains(element)) actionsMenu.open();
    else if (elements.sharePanel.contains(element)) sharePanel.open();
    const panel = element.closest<HTMLElement>('.view-panel');
    if (panel?.classList.contains('view-panel')) {
      const tab = tabForPanel(panel.id);
      if (!tab || !views.available(tab)) return false;
      if (tabOf(views.active()) !== tab) openView(tab);
    } else if (
      (elements.sourceRail.contains(element) || element.closest('.workspace-main')) &&
      views.active() !== 'logs' &&
      views.active() !== 'analysis'
    )
      // The rail and the filter row show on Logs and Analyze.
      views.show('logs');
    return shown(element);
  }

  /** Point at a control for the guide, or at `fallback` while the control is hidden. */
  function revealControl(target: string, fallback?: string): void {
    for (const id of [target, fallback]) {
      const element = id ? document.getElementById(id) : null;
      if (!element || !bringIntoView(element)) continue;
      element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      element.classList.add('reveal-pulse');
      setTimeout(() => element.classList.remove('reveal-pulse'), 1800);
      if (element.tabIndex >= 0) element.focus({ preventScroll: true });
      return;
    }
  }

  /** The memory chip: a meter and how much is kept, with every count in its panel. */
  function renderMemory(data: Snapshot, number: (value: number) => string): void {
    const used = data.bytes / MIB;
    const budget = Number.isFinite(data.maxBytes) && data.maxBytes > 0 ? data.maxBytes / MIB : undefined;
    const share = budget ? Math.min(1, used / budget) : 0;
    elements.memoryFill.style.width = `${Math.round(share * 100)}%`;
    elements.memoryFill.classList[share >= 0.9 ? 'add' : 'remove']('full');
    const memory = `${used.toFixed(used < 10 ? 1 : 0)} / ${budget ? budget.toFixed(0) : '?'} MiB`;
    elements.memoryText.textContent = memory;
    elements.counts.title = `${number(data.retained)} logs kept, using ${memory}. Click for details.`;
    elements.memorySummary.textContent = `${memory} of memory for ${number(data.retained)} logs. The oldest go first when it fills.`;
    const rows: [string, string][] = [
      ['Received', number(data.total)],
      ['Kept', number(data.retained)],
      ['Discarded, oldest first', number(data.discarded)],
      ['Lines cut short', number(data.truncated)],
      ...(data.persistDropped ? [['Disk writes skipped', number(data.persistDropped)] as [string, string]] : []),
    ];
    elements.memoryDetails.replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = value;
        return [term, detail];
      }),
    );
  }

  /** The runs of a source; a container source (`<source>::<service>`) shares those of the source that printed it. */
  function sessionsFor(id: string): Snapshot['sessions'] {
    return allSessions.filter((session) => !id || session.serverId === id || id.startsWith(`${session.serverId}::`));
  }

  /** The selection changed outside the rail, such as by a saved search. */
  function updateScopeSelection(): void {
    visibleSessions = sessionsFor(state.selectedServer);
    rail.selectionChanged(visibleSessions);
    connectionBar.render();
  }

  function selectSource(id: string, run = ''): void {
    search.clearAutocomplete();
    state.selectedServer = id;
    state.selectedSession = run;
    visibleSessions = sessionsFor(id);
    state.page = 0;
    state.lastRows = undefined;
    table.resetAutomaticColumns();
    saveState();
    rail.selectionChanged(visibleSessions);
    connectionBar.render();
    requestInteraction();
  }

  function selectRun(id: string): void {
    state.selectedSession = id;
    state.page = 0;
    state.lastRows = undefined;
    state.filterChanged();
    saveState();
    rail.selectionChanged();
    requestInteraction();
  }
}
