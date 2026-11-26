import type { WelcomeChoice } from '../core/usage-events';
import type { UpdateStatus } from '../protocol/messages';
import type { HostMessage, Snapshot } from '../protocol/messages';
import { createAnalysis } from './analysis/charts';
import { addFilterTerm, cellFilterQuery } from './search/cell-filter';
import { hasChangedScope, withChangedScope } from '../core/changed-query';
import { SnapshotBridge } from './bridge';
import { getElements, setLabel } from './dom';
import { createTooltips } from './tooltip';
import { EventScope } from './event-scope';
import { createInspection } from './inspection/context';
import { buildEventDetails, eventAction, eventFieldEntries, renderEventFields } from './inspection/details';
import { createInspector, type InspectorContent } from './inspector';
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
import { createInspectorResize, createRailResize } from './rail-resize';
import { createTabRail } from './tab-rail';
import { createTour } from './tour';
import { createAboutDialog } from './about-dialog';
import { createFeedbackForm } from './feedback-form';
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
  createInspectorResize(elements.inspectorResizer, elements.inspector, state, scope, { saveState: () => saveState() });
  // What is selected in a list shows beside it, so the list stays in view and nothing in it moves.
  const inspector = createInspector(elements, scope);
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
      metrics: elements.metricsView,
      aiCalls: elements.aiCallsView,
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
      back: (tab) => openView(canOpen(tab) ? tab : 'logs'),
    },
    (title, items) => tabRail.set('connection', title, items),
  );
  const ANALYSIS_REFRESH_MS = 5000;
  const formatTimestamp = createTimestampFormatter(state);
  const analysis = createAnalysis(
    elements,
    state,
    {
      drill: (term) => {
        const choice = addFilterTerm(search.query(), term);
        if (choice.query === undefined) {
          analysisStatus = 'note';
          elements.analysisStatus.textContent = choice.reason;
          return;
        }
        views.show('logs');
        search.setQuery(choice.query, true);
      },
      investigate: (id, query) => api.postMessage({ type: 'investigate', id, ...(query ? { query } : {}) }),
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
  const search = createSearch(
    elements,
    state,
    api,
    popovers,
    { filterChanged, updateScopeSelection, suggest: () => requestAutocomplete() },
    scope,
  );
  const connectionBar = createConnectionBar(
    elements,
    state,
    api,
    scope,
    () => search.query(),
    saveState,
    (baselineServerId, baselineSessionId) => compareView.open({ baselineServerId, baselineSessionId }),
    (query, keepDraft) => search.setQuery(query, true, keepDraft),
    () => search.applyPending(),
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
    openAiCall: (traceId, spanId) => aiCalls.open(traceId, spanId),
    inspect: (title, traceId) => {
      // A trace opened from a log, a finding, or an AI call shows beside the list of traces.
      if (views.active() !== 'traces') traceList.show();
      traceList.mark(traceId);
      inspector.open(
        'trace',
        { title, tooltip: traceId, body: [elements.traceView] },
        {
          closed: () => {
            traceView.hide();
            traceList.closed();
          },
        },
      );
    },
    inspecting: () => inspector.kind() === 'trace',
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
    queryConnection: (id) => metricQuery.choose(id),
  });
  const aiCalls = createAiCalls(elements, api, scope, {
    showTrace: (traceId) => traceView.show(traceId),
    formatTime: (ms) => formatTimestamp({ id: 0, level: '', timestampMs: ms }) ?? '',
    revealList: () => views.show('aiCalls'),
    inspect: (title, tooltip) => {
      if (views.active() !== 'aiCalls') aiCalls.show();
      const content = { title, tooltip, nav: [elements.aiCallNavigation], body: [elements.aiCallView] };
      // The same call's title arrives with its conversation; another call replaces the one shown.
      if (inspector.kind() === 'aiCall') inspector.update('aiCall', content);
      else inspector.open('aiCall', content, { closed: () => aiCalls.close() });
    },
    inspecting: () => inspector.kind() === 'aiCall',
    rail: (title, items) => tabRail.set('aiCalls', title, items),
    listVisible: () => views.active() === 'aiCalls',
    receiver: () => ({ running: otlpRunning, endpoint: otlpEndpoint }),
  });
  // The Issues tab shows only while its view is open; the status bar's chip and the status panel open it.
  elements.doctor.hidden = true;
  let doctorEnabled = false;
  const doctor = createDoctor(
    elements.issuesChip,
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
    (enabled, total) => {
      doctorEnabled = enabled;
      if (!enabled) elements.doctor.hidden = true;
      elements.statusIssuesRow.hidden = !enabled;
      elements.statusIssuesText.textContent = total
        ? `${numberFormat.format(total)} problem${total === 1 ? '' : 's'} with log statements`
        : 'No problems found so far';
    },
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
  /** What the line above Analyze says: a note, such as why a filter was not added, stays until the next request. */
  let analysisStatus: 'loading' | 'ready' | 'note' | 'error' = 'loading';
  let analysisRequest = 0;
  let analysisPending = false;
  let analysisLoadedAt = -Infinity;
  let analysisRefresh: ReturnType<typeof setTimeout> | undefined;
  /** A refresh was skipped, so the next snapshot asks again even with no newer logs. */
  let analysisStale = false;
  /** The retained logs the last snapshot described, to tell when Analyze and Traces are behind. */
  let retainedBasis: string | undefined;
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
  /** The open event, asked about again after the logs changed under it. */
  let recheckingSelected: number | undefined;
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
    if (data.type === 'feedbackResult') {
      feedback.receive(data);
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
      traceList.receive(data.traces, data.total);
      return;
    }
    if (data.type === 'span') {
      traceView.receiveSpan(data);
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
    if (data.type === 'connectionServices') {
      connectionBar.receiveServices(data);
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
      else if (data.missing && data.id === recheckingSelected && data.id === state.selected) {
        // The logs changed under the open event, and it went with them.
        recheckingSelected = undefined;
        inspector.close('event');
      } else if (table.receiveDetails(data)) inspector.update('event', eventContent());
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
      // Only the latest request's answer is shown; an older one arriving late is for a filter no longer chosen.
      if (data.requestId !== undefined && data.requestId !== analysisRequest) return;
      analysisPending = false;
      // A background refresh leaves a note, such as why a filter was not added, in place.
      if (analysisStatus !== 'note') {
        analysisStatus = 'ready';
        analysisContext();
      }
      analysis.renderAnalysis(data.analysis);
      return;
    }
    if (data.type === 'viewError') {
      if (data.view === 'traces') traceList.fail(data.message);
      else if (data.view === 'trace') traceView.fail(data.traceId, data.message);
      else if (data.view === 'span') traceView.failSpan(data.traceId, data.spanId, data.message);
      else if (data.requestId === undefined || data.requestId === analysisRequest) {
        analysisPending = false;
        analysisStatus = 'error';
        elements.analysisStatus.textContent = `Could not analyze these logs: ${data.message}`;
      }
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
    updateUpdateButton(data.update);
    bridge.received(data.requestId);
    const rows = bridge.rows(data);
    // A filter requested from the editor (a log statement's CodeLens).
    if (data.applyQuery !== undefined && data.applyQuery !== search.query()) {
      views.show('logs');
      search.setQuery(data.applyQuery, true);
    }
    if (data.openTrace) traceView.show(data.openTrace);
    if (data.startTour) scope.frame(() => startTour());
    const openFeedback = data.openFeedback;
    if (openFeedback) scope.frame(() => feedback.open(openFeedback));
    const openAbout = data.openAbout;
    if (openAbout) scope.frame(() => about.open(openAbout));
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
    // The receiver's chip shows only while it runs or has failed; the status panel starts and stops it.
    elements.otlpStatus.hidden = !otlpRunning && !data.otlp?.error;
    elements.statusOtlpText.textContent = otlpRunning
      ? `On · ${data.otlp?.endpoint?.replace(/^https?:\/\//, '') ?? 'localhost'}${data.otlp?.error ? ` · ${data.otlp.error}` : ''}`
      : (data.otlp?.error ?? 'Off');
    elements.statusOtlp.textContent = otlpRunning ? 'Stop' : 'Start';
    elements.railAddOtlp.hidden = otlpRunning;
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
    // Analyze and Traces follow the retained logs and spans: a view left open catches up as they arrive.
    const logsBasis = `${data.generation}:${data.newest}`;
    const tracesBasis = `${logsBasis}:${data.tracesRevision ?? 0}`;
    traceList.update(tracesBasis);
    traceView.update(tracesBasis);
    if (
      views.active() === 'analysis' &&
      ((retainedBasis !== undefined && retainedBasis !== logsBasis) || analysisStale)
    ) {
      analysisStale = false;
      refreshAnalysisSoon();
    }
    retainedBasis = logsBasis;
    views.ensureVisible();
    elements.traces.title = data.traceCount
      ? `${numberFormat.format(data.traceCount)} traces received from OpenTelemetry. Show requests across services.`
      : 'Requests across services, from OpenTelemetry spans and logs with a trace id';
    if (data.generation < minimumSnapshotGeneration) {
      bridge.flush();
      return;
    }
    minimumSnapshotGeneration = 0;
    const generationChanged = state.generation !== undefined && state.generation !== data.generation;
    if (generationChanged) {
      state.before = undefined;
      state.page = 0;
      state.lastRows = undefined;
      // The logs were cleared, or a source or run removed: the open event stays only if it is still kept.
      recheckingSelected = state.selected;
      if (recheckingSelected !== undefined) api.postMessage({ type: 'details', id: recheckingSelected });
      table.resetAutomaticColumns();
      bridge.forget();
      table.renderRows([]);
      bridge.refreshRequested = true;
    }
    state.generation = data.generation;
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
    elements.statusCaptureText.textContent =
      data.captureStatus?.state === 'capturing'
        ? 'Capturing…'
        : data.captureStatus?.state === 'attention'
          ? 'Needs attention'
          : data.captureTerminals
            ? 'On'
            : 'Off';
    elements.statusCapture.textContent = data.captureTerminals ? 'Turn off' : 'Turn on';
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
    elements.statusAgentsText.textContent = sharing ? elements.shareScope.textContent : 'Not sharing';
    let selectionChanged = false;
    if (data.servers) {
      visibleSources = data.servers;
      if (analysisStatus === 'ready') analysisContext();
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
      if (canOpen(tab)) openView(tab);
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
    if (rows && !bridge.refreshRequested && holdingLive()) {
      // Rows would move under the pointer; show them when it leaves the table.
      heldEvents = rows;
      updateModeLabel();
    } else if (rows && !bridge.refreshRequested) {
      heldEvents = undefined;
      state.page = data.page ?? 0;
      state.pages = data.pages ?? 1;
      const matched = data.matched ?? 0;
      elements.page.textContent = matched
        ? `${number(matched)} match${matched === 1 ? '' : 'es'}`
        : data.total
          ? 'No matches'
          : 'No logs yet';
      elements.pageNumber.textContent = `${state.page + 1} / ${state.pages}`;
      // One page needs no pager.
      if (elements.pageNumber.parentElement) elements.pageNumber.parentElement.hidden = state.pages <= 1;
      // With nothing captured the table has no header to show, only the ways to get logs in.
      if (document.body) document.body.dataset.empty = String(!data.total);
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
      const connectionEmpty = connectionBar.emptyText();
      elements.empty.textContent =
        connectionEmpty ??
        (data.total
          ? 'No matching events in retained history.'
          : data.captureTerminals
            ? 'Capture is on. Run your app in a terminal, or press F5, and its logs appear here.'
            : 'Nothing captured yet. Run your app with F5 and its logs appear here, or start with one of these:');
      // Nothing captured at all: offer the ways in, not only a sentence about them.
      elements.emptyActions.hidden = rows.length > 0 || data.total > 0 || connectionEmpty !== undefined;
      elements.emptyCapture.hidden = data.captureTerminals;
      if (state.following && !state.selectedSort) table.scheduleRenderWindow(true);
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
    if (events && state.following) {
      state.lastRows = events.map((event) => event.id).join(',');
      table.renderRows(events);
      elements.empty.hidden = events.length > 0;
      if (events.length) elements.emptyActions.hidden = true;
      table.scheduleRenderWindow(true);
    }
    updateModeLabel();
  }

  function updateFollowControl() {
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
    elements.mode.textContent = state.selectedSort
      ? `Sorted ${state.selectedSortDirection === 'asc' ? 'ascending' : 'descending'}${state.following ? ' · Live updates' : ''}`
      : state.following
        ? heldEvents
          ? 'Live · new rows held while you point at the table'
          : 'Live · newest 1,000'
        : state.newestFirst && state.page === 0 && state.before !== undefined && state.newest > state.before
          ? 'Browsing · newer logs arrived — scroll to the top for Live'
          : 'Browsing retained history';
    elements.mode.className = state.following ? 'live-mode' : '';
    // Plain Live is what the Live button already says; anything else is worth a word.
    elements.mode.hidden = state.following && !heldEvents && !state.selectedSort;
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
  function updateUpdateButton(update: UpdateStatus | undefined) {
    const button = elements.updateButton;
    button.hidden = !update;
    if (!update) return;
    button.disabled = update.state === 'installing';
    button.textContent =
      update.state === 'available' ? 'Update' : update.state === 'installing' ? 'Updating…' : 'Reload';
    button.title =
      update.state === 'ready'
        ? `Reload the window to use Logline ${update.version}`
        : `Update Logline to ${update.version}`;
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
      else if (rowButton.classList.contains('row-finding-button') && state.selected !== rowId) selectEvent(rowId);
      return;
    }
    const trace = (event.target as HTMLElement).closest<HTMLElement>('.row-trace-button');
    if (trace?.dataset.traceId) {
      traceView.show(trace.dataset.traceId);
      return;
    }
    // A click anywhere in a row opens it, not just on its message. Other controls in the row keep
    // their own clicks, and a drag that selects text to copy does not open the row.
    const button = target.closest<HTMLElement>('.message-button');
    let row = button?.closest<HTMLElement>('tr');
    if (!row) {
      if (target.closest('button, a, input, select, textarea')) return;
      if (window.getSelection?.()?.isCollapsed === false) return;
      row = target.closest<HTMLElement>('tr.event-row');
    }
    if (row) selectEvent(Number(row.dataset.id));
  });
  // With an event open, Escape anywhere in a row closes it, and the arrow keys on a message move to
  // the one above or below. On a cell they move between cells instead.
  scope.listen(elements.logs, 'keydown', (event) => {
    const target = event.target as HTMLElement;
    if (inspector.kind() !== 'event' || !target.closest?.('tr.event-row')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      inspector.close('event');
      return;
    }
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || !target.closest('.message-button')) return;
    const next = table.neighbor(event.key === 'ArrowDown' ? 1 : -1);
    if (!next) return;
    event.preventDefault();
    selectEvent(next.id);
    elements.logs
      .querySelector<HTMLElement>(`tr.event-row[data-id="${next.id}"] .message-button`)
      ?.focus({ preventScroll: false });
  });
  // The buttons of the event in the inspector: its actions, its findings, and its fields' filters.
  scope.listen(elements.inspectorBody, 'click', (event) => {
    const target = event.target as HTMLElement;
    const dismiss = target.closest<HTMLElement>('.dismiss-hint');
    if (dismiss) {
      state.cellHintDismissed = true;
      saveState();
      dismiss.closest('.detail-hint')?.remove();
      return;
    }
    const filter = target.closest<HTMLElement>('.field-filter');
    if (filter?.dataset.field) {
      const choice = cellFilterQuery(
        search.query(),
        { field: filter.dataset.field, value: filter.dataset.value },
        filter.dataset.exclude === 'true',
      );
      if (choice.query === undefined) filter.title = choice.reason;
      else search.setQuery(choice.query, true);
      return;
    }
    if (inspector.kind() === 'event' && !doctor.handleAction(event)) inspection.handleDetailAction(event);
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
    requestAutocomplete();
  });

  // A request still waiting when the box is left would only bring suggestions for a box no longer in use.
  scope.listen(elements.search, 'blur', () => clearTimeout(autocompleteDebounce));

  /** Ask the host for suggestions for what is typed in the search box, once typing pauses. */
  function requestAutocomplete(): void {
    clearTimeout(autocompleteDebounce);
    if (!search.draft().trim()) {
      search.clearAutocomplete();
      return;
    }
    autocompleteDebounce = setTimeout(() => {
      api.postMessage({ type: 'autocomplete', input: search.draft(), serverId: state.selectedServer || undefined });
    }, 150);
  }

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
  // Findings shown on an event inside Surrounding logs act the same way.
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
  /** Shows an event in the inspector; choosing the open one again closes it. */
  function selectEvent(id: number) {
    dismissRowHint();
    if (table.select(id))
      inspector.open('event', eventContent(), {
        closed: () => table.clearSelection(),
        // Rows are rebuilt as logs arrive, so the event's row is looked up when the pane closes.
        home: () => elements.logs.querySelector<HTMLElement>(`tr.event-row[data-id="${id}"] .message-button`),
      });
    else inspector.close('event');
  }
  // The selected event's details parsed once, not again each time the inspector is drawn.
  let parsedFields: { text: string | undefined; entries: [string, unknown][] | undefined } | undefined;
  function selectedFields(): [string, unknown][] | undefined {
    const text = state.selectedDetailText;
    if (!parsedFields || parsedFields.text !== text) parsedFields = { text, entries: eventFieldEntries(text) };
    return parsedFields.entries;
  }
  /** The selected event for the inspector: its message, where and when it was logged, its actions and fields. */
  function eventContent(): InspectorContent {
    const id = state.selected!;
    const event = table.selectedEvent();
    const context = eventAction(
      'context-button',
      'context',
      'Surrounding logs',
      'Show the logs just before and after this event from the same run',
    );
    context.dataset.id = String(id);
    const body: Node[] = [
      buildEventDetails(
        id,
        state.selectedDetailText,
        state.selectedExceptions,
        state.selectedLinks,
        [context],
        renderEventFields(selectedFields()),
      ),
    ];
    if (!state.cellHintDismissed) {
      const hint = document.createElement('p');
      hint.className = 'detail-hint';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'dismiss-hint';
      dismiss.textContent = 'Got it';
      hint.append(
        document.createTextNode('Tip: right-click any cell in the table to include or exclude its value.'),
        dismiss,
      );
      body.push(hint);
    }
    const source = event?.serverId
      ? (visibleSources.find((server) => server.id === event.serverId)?.label ?? event.serverId)
      : undefined;
    return {
      title: event?.message ?? 'Event',
      meta: event
        ? [event.level.toUpperCase(), formatTimestamp(event), source, event.stream].filter(Boolean).join(' · ')
        : undefined,
      body,
    };
  }
  const actionsMenu = createPopover(actionsContainer, elements.moreActions, elements.actionsMenu);
  const actionItems = [
    elements.copyResults,
    elements.export,
    elements.breakOnLogs,
    elements.manage,
    elements.config,
    elements.help,
    elements.takeTour,
    elements.suggestFeature,
    elements.about,
    elements.clear,
  ];
  // Copy filtered results is hidden without a filter; keyboard navigation skips it.
  const shownActions = () => actionItems.filter((item) => !item.hidden);
  menuKeys(actionsContainer, elements.moreActions, elements.actionsMenu, actionsMenu, shownActions);
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
  // The status panel: what is running, each with its switch, and how much memory the logs use.
  const statusPanel = createPopover(
    elements.statusIcon.closest<HTMLElement>('.popover-container')!,
    elements.statusIcon,
    elements.statusPanel,
  );
  scope.listen(elements.counts, 'click', (event) => {
    event.stopPropagation();
    statusPanel.open();
  });
  scope.listen(elements.statusCapture, 'click', () =>
    api.postMessage({
      type: 'toggleTerminalCapture',
      enabled: elements.captureToggle.getAttribute('aria-pressed') !== 'true',
    }),
  );
  scope.listen(elements.statusOtlp, 'click', () => api.postMessage({ type: 'toggleOtlp', enabled: !otlpRunning }));
  scope.listen(elements.statusAgents, 'click', (event) => {
    event.stopPropagation();
    sharePanel.open();
  });
  scope.listen(elements.statusIssues, 'click', () => {
    statusPanel.close();
    openIssues();
  });
  scope.listen(elements.issuesChip, 'click', () => openIssues());
  scope.listen(elements.statusTroubleshoot, 'click', () => {
    statusPanel.close();
    api.postMessage({ type: 'showStatus' });
  });

  // The tour: one stop per area of the panel, from the menu, the guide, or the first-run welcome.
  // Suggest a feature and Vote on what's next, from More actions or the Command Palette.
  const feedback = createFeedbackForm(
    {
      dialog: elements.feedbackDialog,
      form: elements.feedbackForm,
      cancel: elements.feedbackCancel,
      suggestTab: elements.feedbackSuggestTab,
      voteTab: elements.feedbackVoteTab,
      suggest: elements.feedbackSuggest,
      vote: elements.feedbackVote,
      area: elements.feedbackArea,
      text: elements.feedbackText,
      count: elements.feedbackCount,
      preview: elements.feedbackPreview,
      choices: elements.feedbackChoices,
      note: elements.feedbackNote,
      status: elements.feedbackStatus,
      send: elements.feedbackSend,
      github: elements.feedbackGithub,
    },
    api,
    scope,
  );
  const about = createAboutDialog(
    {
      dialog: elements.aboutDialog,
      close: elements.aboutClose,
      version: elements.aboutVersion,
      editor: elements.aboutEditor,
      system: elements.aboutSystem,
      buttons: {
        whatsNew: elements.aboutWhatsNew,
        sponsor: elements.aboutSponsor,
        author: elements.aboutAuthor,
        github: elements.aboutGithub,
        issue: elements.aboutIssue,
        copy: elements.aboutCopy,
      },
    },
    api,
    scope,
  );
  const tour = createTour(scope, {
    prepare: () => {
      if (views.active() !== 'logs') views.show('logs');
      for (const popover of popovers) popover.close();
    },
    ended: (finished) => api.postMessage({ type: 'tourEnded', finished }),
  });
  function startTour(): void {
    elements.tourHint.hidden = true;
    if (elements.welcomeDialog.open) elements.welcomeDialog.close();
    tour.start();
  }
  scope.listen(elements.takeTour, 'click', () => startTour());
  scope.listen(elements.tourHintStart, 'click', () => startTour());
  scope.listen(elements.tourHintDismiss, 'click', () => (elements.tourHint.hidden = true));
  for (const [button, action] of [
    [elements.emptyCapture, 'capture'],
    [elements.emptyOpenFile, 'openFile'],
    [elements.emptyBrowser, 'browser'],
    [elements.emptyAgent, 'agent'],
  ] as const)
    scope.listen(button, 'click', () => api.postMessage({ type: 'emptyAction', action }));
  /** Leave the welcome, remembering it was seen, and do what was chosen. */
  const welcomeChoice = (choice: WelcomeChoice, then: () => void) => () => {
    elements.welcomeDialog.close();
    welcomeAnswered();
    api.postMessage({ type: 'onboardingSeen', choice });
    then();
  };
  scope.listen(
    elements.welcomeTour,
    'click',
    welcomeChoice('tour', () => tour.start()),
  );
  scope.listen(
    elements.welcomeExplore,
    'click',
    welcomeChoice('explore', () => (elements.tourHint.hidden = false)),
  );
  scope.listen(
    elements.welcomeCapture,
    'click',
    welcomeChoice('capture', () => api.postMessage({ type: 'toggleTerminalCapture', enabled: true })),
  );
  scope.listen(
    elements.welcomeImport,
    'click',
    welcomeChoice('import', () => api.postMessage({ type: 'import' })),
  );
  scope.listen(
    elements.welcomeConnection,
    'click',
    welcomeChoice('connection', () => api.postMessage({ type: 'addConnection' })),
  );
  scope.listen(
    elements.welcomeOtel,
    'click',
    welcomeChoice('otel', () => api.postMessage({ type: 'toggleOtlp', enabled: true })),
  );
  // Escape on the welcome counts as exploring: it never shows again.
  scope.listen(elements.welcomeDialog, 'cancel', () => {
    welcomeAnswered();
    api.postMessage({ type: 'onboardingSeen', choice: 'dismissed' });
    elements.tourHint.hidden = false;
  });
  function welcomeAnswered(): void {
    if (!state.welcomeOpen) return;
    state.welcomeOpen = false;
    saveState();
  }
  // The welcome counts as seen once it opens, not when it is answered: hiding the panel, such as by
  // switching to the Terminal tab, rebuilds it, and an unanswered welcome would open again each time.
  // A panel rebuilt while it was still open points to the tour instead, as closing it with Escape does.
  if (document.body?.dataset.firstRun === 'true' && elements.welcomeDialog.showModal) {
    elements.welcomeDialog.showModal();
    state.welcomeOpen = true;
    saveState();
    api.postMessage({ type: 'onboardingSeen' });
  } else if (state.welcomeOpen) {
    // Left without an answer: counted as dismissed, like Escape.
    elements.tourHint.hidden = false;
    welcomeAnswered();
    api.postMessage({ type: 'onboardingSeen', choice: 'dismissed' });
  }
  if (globalThis.innerWidth > 0) api.postMessage({ type: 'panelSize', width: globalThis.innerWidth });
  scope.listen(elements.updateButton, 'click', () => api.postMessage({ type: 'installUpdate' }));
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
  /**
   * Asks the host to analyze the current filter. In the background, as logs arrive, what is
   * shown stays until the answer replaces it.
   */
  function requestAnalysis(background = false) {
    if (!background) {
      analysisStatus = 'loading';
      elements.analysisStatus.textContent = 'Loading analysis…';
    }
    analysisPending = true;
    analysisLoadedAt = Date.now();
    api.postMessage({
      type: 'analysis',
      requestId: ++analysisRequest,
      query: search.query(),
      levels: state.currentLevels(),
      serverId: state.selectedServer || undefined,
      sessionId: state.selectedSession || undefined,
    });
  }
  /** Logs arrived or were cleared while Analyze is shown: analyze again, at most once per interval. */
  function refreshAnalysisSoon() {
    if (analysisRefresh) return;
    analysisRefresh = setTimeout(
      () => {
        analysisRefresh = undefined;
        if (views.active() !== 'analysis') return;
        // An answer still on its way, or a time window being chosen, is not interrupted; the next arrival asks again.
        if (analysisPending || analysis.busy()) analysisStale = true;
        else requestAnalysis(true);
      },
      Math.max(0, analysisLoadedAt + ANALYSIS_REFRESH_MS - Date.now()),
    );
  }
  scope.track(() => clearTimeout(analysisRefresh));

  /** Opens a view from its tab, loading what it shows. */
  function openView(tab: TabName) {
    if (tab === 'analysis') {
      views.show('analysis');
      requestAnalysis();
    } else if (tab === 'traces') traceList.show();
    else if (tab === 'metrics') metricList.show();
    else if (tab === 'compare') compareView.show();
    else if (tab === 'aiCalls') aiCalls.show();
    else if (tab === 'doctor') openIssues();
    else views.show(tab);
  }

  /**
   * Whether a tab can be opened now. The Issues tab is hidden except while its
   * view is open, so it can be opened whenever log doctor is on; every other tab
   * can be opened while it is shown.
   */
  function canOpen(tab: TabName): boolean {
    return tab === 'doctor' ? doctorEnabled : views.available(tab);
  }

  /** Shows log doctor's findings; their tab appears while they are open. */
  function openIssues() {
    if (!doctorEnabled) return;
    elements.doctor.hidden = false;
    views.show('doctor');
  }

  function viewChanged(view: ViewName, previous: ViewName) {
    restoreTab = undefined;
    if (previous === 'metrics') metricList.hide();
    if (previous === 'compare') compareView.hide();
    if (previous === 'aiCalls') aiCalls.hide();
    if (previous === 'traces') traceList.hide();
    if (previous === 'doctor') elements.doctor.hidden = true;
    // A selection belongs to its list; another tab has nothing to show beside it.
    if (view !== 'logs') inspector.close('event');
    if (view !== 'traces') inspector.close('trace');
    if (view !== 'aiCalls') inspector.close('aiCall');
    state.view = tabOf(view);
    tabRail.show(tabOf(view));
    saveState();
  }

  function resumeLive() {
    state.resume();
    saveState();
    table.updateColumns(table.automaticColumns, true);
    updateFollowControl();
    updateModeLabel();
    request(true);
    table.scheduleRenderWindow(true);
  }
  scope.listen(elements.follow, 'click', () => {
    if (!state.following) resumeLive();
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
    if (!state.newestFirst || state.selectedSort) return;
    if (state.following && top > 1) setFollowing(false);
    else if (!state.following && top <= 1 && !wasAtTop && state.page === 0) resumeLive();
  });
  scope.listen(elements.older, 'click', () => {
    if (state.following) setFollowing(false);
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
    inspector.close('event');
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
  scope.listen(elements.openBrowser, 'click', () => api.postMessage({ type: 'openBrowser' }));
  scope.listen(elements.suggestFeature, 'click', () => api.postMessage({ type: 'suggestFeature' }));
  scope.listen(elements.about, 'click', () => api.postMessage({ type: 'showAbout' }));
  // Add logs, on the Sources rail: every way to bring logs in.
  const addContainer = elements.railAdd.closest<HTMLElement>('.popover-container')!;
  const addMenu = createPopover(addContainer, elements.railAdd, elements.railAddMenu);
  const addItems = [
    elements.railAddRun,
    elements.railAddFile,
    elements.openBrowser,
    elements.import,
    elements.railAddConnectionItem,
    elements.railAddOtlp,
  ];
  menuKeys(addContainer, elements.railAdd, elements.railAddMenu, addMenu, () =>
    addItems.filter((item) => !item.hidden),
  );
  for (const item of addItems) scope.listen(item, 'click', () => addMenu.close(true));
  scope.listen(elements.railAddRun, 'click', () => api.postMessage({ type: 'run' }));
  scope.listen(elements.railAddFile, 'click', () => api.postMessage({ type: 'followFile' }));
  scope.listen(elements.railAddConnectionItem, 'click', () => api.postMessage({ type: 'addConnection' }));
  scope.listen(elements.railAddOtlp, 'click', () => api.postMessage({ type: 'toggleOtlp', enabled: true }));
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
    if (canOpen(state.view)) openView(state.view);
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

  /** A menu's keyboard: arrows, Home, and End move between its shown items, and Tab or leaving it closes it. */
  function menuKeys(
    container: HTMLElement,
    trigger: HTMLElement,
    menu: HTMLElement,
    popover: { isOpen(): boolean; open(): void; close(restoreFocus?: boolean): void },
    shownItems: () => HTMLElement[],
  ): void {
    scope.listen(trigger, 'click', () => {
      if (popover.isOpen()) shownItems()[0].focus();
    });
    scope.listen(trigger, 'keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      popover.open();
      const items = shownItems();
      items[event.key === 'ArrowUp' ? items.length - 1 : 0].focus();
    });
    scope.listen(menu, 'keydown', (event) => {
      if (event.key === 'Tab') {
        popover.close(true);
        return;
      }
      const items = shownItems();
      const index = items.indexOf(document.activeElement as HTMLElement);
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
    scope.listen(container, 'focusout', (event) => {
      if (!container.contains(event.relatedTarget as Node | null)) popover.close();
    });
  }

  /** Which tab shows a view panel. */
  function tabForPanel(id: string): TabName | undefined {
    const tabs: Record<string, TabName> = {
      logsView: 'logs',
      analysisView: 'analysis',
      compareView: 'compare',
      tracesView: 'traces',
      metricsView: 'metrics',
      aiCallsView: 'aiCalls',
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
    else if (elements.railAddMenu.contains(element)) addMenu.open();
    else if (elements.statusPanel.contains(element)) statusPanel.open();
    else if (elements.sharePanel.contains(element)) sharePanel.open();
    const panel = element.closest<HTMLElement>('.view-panel');
    if (panel?.classList.contains('view-panel')) {
      const tab = tabForPanel(panel.id);
      if (!tab || !canOpen(tab)) return false;
      if (tabOf(views.active()) !== tab) openView(tab);
    } else if (
      (elements.sourceRail.contains(element) ||
        element.closest('.workspace-main') ||
        element.closest('.search-toolbar')) &&
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
    // The meter shows in the status bar only as the budget fills; the status panel always has it.
    elements.counts.hidden = share < 0.8;
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
    updateCopyResultsControl();
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
    updateCopyResultsControl();
    requestInteraction();
  }

  function selectRun(id: string): void {
    state.selectedSession = id;
    state.page = 0;
    state.lastRows = undefined;
    state.filterChanged();
    saveState();
    rail.selectionChanged();
    updateCopyResultsControl();
    requestInteraction();
  }
}
