const vscode = acquireVsCodeApi();
const elements = Object.fromEntries(
  ['logs', 'empty', 'search', 'searchHelp', 'searchHelpPanel', 'levelButton', 'levelMenu', 'server', 'follow',
    'config', 'manage', 'export', 'exportAI', 'import', 'clear', 'stop', 'run', 'status', 'sessions', 'command',
    'older', 'newer', 'page', 'mode', 'counts']
    .map(id => [id, document.getElementById(id)])
);
const scrollViewport = document.querySelector('.table-scroll');
const saved = vscode.getState() ?? {};
elements.search.value = saved.query ?? '';
let paused = false;
let following = true;
let page = 0;
let pages = 1;
let newest = 0;
let before;
let generation;
let pending = false;
let refreshRequested = false;
let lastRows;
let forcedRequest = false;
let selected;
let selectedDetailText;
let selectedServer = saved.server ?? '';
let serverSignature = '';
let searchDebounce;

// A checkbox per level (any combination, Kayak-filter style) rather than a
// single "at least X" choice, so e.g. Info + Error but not Warn is possible.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_LABELS = { trace: 'Trace', debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error', fatal: 'Fatal' };
let checkedLevels = new Set(Array.isArray(saved.levels) ? saved.levels : LEVELS);

function updateLevelButtonLabel() {
  if (checkedLevels.size === LEVELS.length) elements.levelButton.textContent = 'All levels';
  else if (checkedLevels.size === 0) elements.levelButton.textContent = 'No levels';
  else if (checkedLevels.size === 1) elements.levelButton.textContent = `${LEVEL_LABELS[[...checkedLevels][0]]} only`;
  else elements.levelButton.textContent = `${checkedLevels.size} levels`;
}

function setAllLevels(value) {
  checkedLevels = value ? new Set(LEVELS) : new Set();
  buildLevelMenu();
  updateLevelButtonLabel();
  filterChanged();
}

function buildLevelMenu() {
  const actions = document.createElement('div');
  actions.className = 'level-actions';
  for (const [label, value] of [['All', true], ['None', false]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => setAllLevels(value));
    actions.append(button);
  }
  const labels = LEVELS.map(level => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checkedLevels.has(level);
    input.addEventListener('change', () => {
      if (input.checked) checkedLevels.add(level); else checkedLevels.delete(level);
      updateLevelButtonLabel();
      filterChanged();
    });
    label.append(input, document.createTextNode(' ' + LEVEL_LABELS[level]));
    return label;
  });
  elements.levelMenu.replaceChildren(actions, ...labels);
}

// Omitting `levels` entirely (the default, everything checked) lets the
// store skip building a filter set at all; an empty array is a distinct,
// deliberate "nothing checked", which is a real choice, not "no filter".
function currentLevels() {
  return checkedLevels.size === LEVELS.length ? undefined : [...checkedLevels];
}

// A handful of toolbar buttons open a small panel (level filter, search
// syntax help). Only one is open at a time, and clicking outside or pressing
// Escape closes whichever is open.
const popovers = [];
function createPopover(container, button, panel) {
  const api = {
    isOpen: () => !panel.hidden,
    close() { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); },
    open() {
      for (const other of popovers) if (other !== api) other.close();
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    }
  };
  button.addEventListener('click', event => {
    event.stopPropagation();
    api.isOpen() ? api.close() : api.open();
  });
  popovers.push({ container, ...api });
  return api;
}
document.addEventListener('click', event => {
  for (const popover of popovers) if (popover.isOpen() && !popover.container.contains(event.target)) popover.close();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  for (const popover of popovers) if (popover.isOpen()) popover.close();
});

// Only one page may be in flight. Pausing never queues incoming events.
function request(force = false) {
  if (document.hidden) return;
  if (pending) { refreshRequested ||= force; return; }
  pending = true;
  forcedRequest = force;
  vscode.postMessage({ type: 'snapshot', query: elements.search.value, serverId: selectedServer || undefined,
    levels: currentLevels(), page, before, statsOnly: paused && !force });
}

window.addEventListener('message', ({ data }) => {
  // Pushed by the extension whenever retained data or status actually
  // changes, coalesced on its side. This replaces polling on a fixed
  // interval, so an idle server costs nothing here.
  if (data.type === 'update') { request(); return; }
  if (data.type === 'serversChanged') { serverSignature = ''; request(true); return; }
  if (data.type === 'details') {
    if (data.id === selected) {
      selectedDetailText = data.text;
      renderWindow();
      elements.logs.querySelector('.detail-row')?.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (data.type !== 'snapshot') return;
  pending = false;
  if (generation !== undefined && generation !== data.generation) {
    before = undefined;
    page = 0;
    lastRows = undefined;
    selected = undefined;
    selectedDetailText = undefined;
    virtualEvents = [];
    renderWindow();
    refreshRequested = true;
  }
  generation = data.generation;
  if (data.timezone && data.timezone !== displayTimezone) { displayTimezone = data.timezone; lastRows = undefined; }
  newest = data.newest;
  elements.status.textContent = data.status;
  elements.command.textContent = data.command;
  elements.command.title = data.command;
  elements.stop.disabled = !data.running;
  elements.stop.textContent = selectedServer ? 'Stop server' : 'Stop all';
  const activeSessions = Array.isArray(data.sessions) ? data.sessions.filter(session =>
    ['starting', 'running', 'stopping'].includes(session.status)) : [];
  elements.sessions.textContent = activeSessions.length
    ? `${activeSessions.length} active session${activeSessions.length === 1 ? '' : 's'}` : 'No active sessions';
  if (data.servers) {
    const signature = JSON.stringify(data.servers.map(server => [server.id, server.label, server.status, server.activeSessions]));
    if (signature !== serverSignature) {
      serverSignature = signature;
      const activeCount = data.servers.reduce((sum, server) => sum + (server.activeSessions || 0), 0);
      const options = [document.createElement('option'), ...data.servers.map(() => document.createElement('option'))];
      options[0].textContent = activeCount ? `All servers · ${activeCount} active` : 'All servers';
      options[0].value = '';
      data.servers.forEach((server, index) => {
        const state = server.status === 'idle' ? '' : ` · ${server.status}`;
        const activity = server.activeSessions > 1 ? ` (${server.activeSessions} active)` : '';
        options[index + 1].textContent = `${server.label}${state}${activity}`;
        options[index + 1].value = server.id;
        options[index + 1].title = server.lastSession ? `Session ${server.lastSession}` : server.status;
      });
      elements.server.replaceChildren(...options);
      elements.server.value = data.servers.some(server => server.id === selectedServer) ? selectedServer : '';
      selectedServer = elements.server.value;
    }
  }
  const number = value => value.toLocaleString();
  const budget = Number.isFinite(data.maxBytes) ? (data.maxBytes / 1048576).toFixed(0) : '?';
  elements.counts.textContent = `${number(data.total)} received · ${number(data.retained)} retained · ${number(data.discarded)} discarded · ${(data.bytes / 1048576).toFixed(1)} / ${budget} MiB · ${data.truncated} truncated`;
  updateModeLabel();
  if (data.columns) updateColumns(data.columns);
  if (data.events && !refreshRequested && (!paused || forcedRequest)) {
    page = data.page;
    pages = data.pages;
    elements.page.textContent = `Page ${page + 1} of ${pages} · ${number(data.matched)} matches`;
    elements.older.disabled = page >= pages - 1;
    elements.newer.disabled = page === 0;
    const signature = data.events.map(event => event.id).join(',');
    if (signature !== lastRows) {
      lastRows = signature;
      renderRows(data.events);
    }
    elements.empty.hidden = data.events.length > 0;
    elements.empty.textContent = data.total ? 'No matching events in retained history.' : 'Run a server command to see its logs here.';
  }
  if (refreshRequested) {
    refreshRequested = false;
    request(true);
  }
});

function cell(text, className) {
  const element = document.createElement('td');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function totalColumnCount() { return 4 + currentColumns.length; }

function buildRow(event) {
  const row = document.createElement('tr');
  row.className = 'event-row';
  row.dataset.id = event.id;
  const messageCell = cell('');
  const button = document.createElement('button');
  button.className = 'message-button';
  button.textContent = `${event.message}${event.truncated ? ' [truncated]' : ''}`;
  button.title = event.message;
  button.setAttribute('aria-expanded', String(event.id === selected));
  messageCell.append(button);
  row.append(cell(formatTimestamp(event), 'time'), cell(event.level, `level ${event.level}`), messageCell, cell(event.stream, 'source'));
  for (const column of currentColumns) row.append(cell(event.fields?.[column] ?? ''));
  return row;
}

function buildDetailRow(event) {
  const details = document.createElement('tr');
  details.className = 'detail-row';
  const container = cell('', 'detail-cell');
  container.colSpan = totalColumnCount();
  const copy = document.createElement('button');
  copy.className = 'copy-button';
  copy.textContent = 'Copy event';
  copy.dataset.id = event.id;
  const pre = document.createElement('pre');
  pre.textContent = selectedDetailText ?? 'Loading…';
  container.append(copy, pre);
  details.append(container);
  return details;
}

// Only the rows scrolled into view are ever built, bracketed by two
// height-only spacer rows that stand in for the rest of the page. That keeps
// the DOM cost of a refresh bounded by the viewport instead of by how many of
// the page's up-to-1,000 events are retained.
let virtualEvents = [];
let rowHeight = 30;
let rowHeightMeasured = false;
let topSpacer;
let bottomSpacer;

function ensureSpacers() {
  if (topSpacer) return;
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
  if (rowHeightMeasured) return;
  const probe = buildRow({ id: -1, timestamp: '00:00:00.000', message: 'sample', level: 'info', stream: '', fields: {} });
  probe.style.visibility = 'hidden';
  elements.logs.append(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  if (measured > 0) { rowHeight = measured; rowHeightMeasured = true; }
}

function renderWindow() {
  ensureSpacers();
  ensureRowHeight();
  const total = virtualEvents.length;
  const overscan = 8;
  const visibleCount = Math.max(1, Math.ceil(scrollViewport.clientHeight / rowHeight)) + overscan * 2;
  let start = Math.floor(scrollViewport.scrollTop / rowHeight) - overscan;
  start = Math.max(0, Math.min(start, Math.max(0, total - visibleCount)));
  const end = Math.min(total, start + visibleCount);
  const totalCols = totalColumnCount();
  topSpacer.firstChild.colSpan = totalCols;
  topSpacer.firstChild.style.height = `${start * rowHeight}px`;
  bottomSpacer.firstChild.colSpan = totalCols;
  bottomSpacer.firstChild.style.height = `${(total - end) * rowHeight}px`;
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const event = virtualEvents[i];
    fragment.append(buildRow(event));
    if (event.id === selected) fragment.append(buildDetailRow(event));
  }
  // Rebuilding replaces the focused button's element out from under it, which
  // (besides dropping keyboard focus) makes Chrome yank the scroll position
  // once focus falls back to <body>. Re-focus the same row's new button.
  const focusedRow = elements.logs.contains(document.activeElement) ? document.activeElement.closest('tr') : undefined;
  const refocusId = focusedRow?.classList.contains('event-row') ? focusedRow.dataset.id : undefined;
  elements.logs.replaceChildren(topSpacer, fragment, bottomSpacer);
  if (refocusId !== undefined) elements.logs.querySelector(`tr.event-row[data-id="${refocusId}"] .message-button`)?.focus();
}

let windowRenderQueued = false;
function scheduleRenderWindow() {
  if (windowRenderQueued) return;
  windowRenderQueued = true;
  requestAnimationFrame(() => { windowRenderQueued = false; renderWindow(); });
}
scrollViewport.addEventListener('scroll', scheduleRenderWindow);
new ResizeObserver(scheduleRenderWindow).observe(scrollViewport);

function renderRows(events) {
  virtualEvents = events;
  renderWindow();
  if (following && !paused) {
    // Spacers above now size scrollHeight to the full list; scroll to the
    // true bottom, then re-render so the visible window matches.
    scrollViewport.scrollTop = scrollViewport.scrollHeight;
    renderWindow();
  }
}

let displayTimezone = 'local';
let cachedFormatter;
let cachedFormatterTimezone;
function timestampFormatter() {
  if (cachedFormatter !== undefined && cachedFormatterTimezone === displayTimezone) return cachedFormatter;
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false };
  if (displayTimezone === 'utc') options.timeZone = 'UTC';
  else if (displayTimezone && displayTimezone !== 'local') options.timeZone = displayTimezone;
  try { cachedFormatter = new Intl.DateTimeFormat(undefined, options); } catch { cachedFormatter = null; }
  cachedFormatterTimezone = displayTimezone;
  return cachedFormatter;
}
function formatTimestamp(event) {
  if (!Number.isFinite(event.timestampMs)) return event.timestamp;
  const formatter = timestampFormatter();
  return formatter ? formatter.format(event.timestampMs) : event.timestamp;
}

let currentColumns = [];
function updateColumns(columns) {
  const next = Array.isArray(columns) ? columns : [];
  if (JSON.stringify(next) === JSON.stringify(currentColumns)) return;
  currentColumns = next;
  const head = document.getElementById('head-row');
  head.replaceChildren(...['Time', 'Level', 'Message', 'Source', ...currentColumns].map(label => {
    const th = document.createElement('th'); th.textContent = label;
    if (label === 'Message') th.title = 'Click a message to expand it';
    return th;
  }));
  lastRows = undefined;
}

function toggleExpand(id) {
  if (selected === id) {
    selected = undefined;
    selectedDetailText = undefined;
  } else {
    selected = id;
    selectedDetailText = undefined;
    // Keep the page still while inspecting an event; collection continues.
    paused = true;
    vscode.postMessage({ type: 'details', id });
  }
  updateFollowControl();
  updateModeLabel();
  renderWindow();
}

function updateFollowControl() {
  if (paused) {
    elements.follow.setAttribute('aria-pressed', 'false');
    elements.follow.setAttribute('aria-label', 'Resume live updates');
    elements.follow.title = 'Resume live updates';
    elements.follow.textContent = 'Resume';
    return;
  }
  elements.follow.setAttribute('aria-pressed', String(following));
  elements.follow.setAttribute('aria-label', following ? 'Live updates' : 'Browse retained history');
  elements.follow.title = following ? 'Live updates' : 'Browse retained history';
  elements.follow.textContent = following ? 'Live' : 'Browse';
}

function updateModeLabel() {
  elements.mode.textContent = paused ? 'Paused — collection continues' : following ? 'Live · newest 1,000' : 'Browsing retained history';
  elements.mode.className = following && !paused ? 'live-mode' : '';
}

function setFollowing(value) {
  following = value;
  before = value ? undefined : newest;
  updateFollowControl();
  updateModeLabel();
}

function saveState() {
  vscode.setState({ query: elements.search.value, levels: [...checkedLevels], server: selectedServer });
}

function filterChanged() {
  page = 0;
  lastRows = undefined;
  saveState();
  request(true);
}

elements.logs.addEventListener('click', event => {
  const copyButton = event.target.closest('.copy-button');
  if (copyButton) { vscode.postMessage({ type: 'copy', id: Number(copyButton.dataset.id) }); return; }
  const button = event.target.closest('.message-button');
  if (!button) return;
  toggleExpand(Number(button.closest('tr').dataset.id));
});
elements.search.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(filterChanged, 150);
});
buildLevelMenu();
updateLevelButtonLabel();
updateFollowControl();
updateModeLabel();
createPopover(elements.levelButton.closest('.popover-container'), elements.levelButton, elements.levelMenu);
createPopover(elements.searchHelp.closest('.popover-container'), elements.searchHelp, elements.searchHelpPanel);
elements.server.addEventListener('change', () => {
  selectedServer = elements.server.value;
  page = 0;
  lastRows = undefined;
  saveState();
  request(true);
});
elements.follow.addEventListener('click', () => {
  if (paused) {
    paused = false;
    following = true;
    page = 0;
    before = undefined;
    updateFollowControl();
    updateModeLabel();
    request(true);
    return;
  }
  setFollowing(!following);
  if (following) {
    page = 0;
    paused = false;
  }
  updateFollowControl();
  request(true);
});
elements.older.addEventListener('click', () => {
  if (following) setFollowing(false);
  page = Math.min(pages - 1, page + 1);
  request(true);
});
elements.newer.addEventListener('click', () => { page = Math.max(0, page - 1); request(true); });
elements.clear.addEventListener('click', () => {
  vscode.postMessage({ type: 'clear' });
  request(true);
});
elements.stop.addEventListener('click', () => vscode.postMessage({ type: 'stop', serverId: selectedServer || undefined }));
elements.config.addEventListener('click', () => vscode.postMessage({ type: 'config' }));
elements.manage.addEventListener('click', () => vscode.postMessage({ type: 'manageServers' }));
function exportRequest(type) {
  vscode.postMessage({ type, query: elements.search.value, levels: currentLevels(), serverId: selectedServer || undefined });
}
elements.export.addEventListener('click', () => exportRequest('export'));
elements.exportAI.addEventListener('click', () => exportRequest('exportForAI'));
elements.import.addEventListener('click', () => vscode.postMessage({ type: 'import' }));
elements.run.addEventListener('click', () => vscode.postMessage({ type: 'run', serverId: elements.server.value || undefined }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) request(); });
// A push should arrive whenever data actually changes; this is only a
// safety net in case one is ever missed.
setInterval(() => request(), 5000);
request();
