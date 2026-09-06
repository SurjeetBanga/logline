const vscode = acquireVsCodeApi();
const elements = Object.fromEntries(
  ['logs', 'empty', 'search', 'level', 'server', 'follow', 'config', 'manage', 'clear', 'stop', 'run',
    'status', 'command', 'older', 'newer', 'page', 'mode', 'counts']
    .map(id => [id, document.getElementById(id)])
);
const saved = vscode.getState() ?? {};
elements.search.value = saved.query ?? '';
elements.level.value = saved.level ?? 'trace';
let paused = false;
let following = true;
let page = 0;
let pages = 1;
let newest = 0;
let before;
let generation;
let pending = false;
let timer;
let refreshRequested = false;
let lastRows;
let forcedRequest = false;
let selected;
let detailPre;
let selectedServer = saved.server ?? '';
let serverSignature = '';
let searchDebounce;
let refreshIntervalMs = 250;

// Only one page may be in flight. Pausing never queues incoming events.
function request(force = false) {
  clearTimeout(timer);
  if (document.hidden) return;
  if (pending) { refreshRequested ||= force; return; }
  pending = true;
  forcedRequest = force;
  vscode.postMessage({ type: 'snapshot', query: `${selectedServer ? `serverId:${selectedServer} ` : ''}${elements.search.value}`,
    level: elements.level.value, page, before, statsOnly: paused && !force });
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'serversChanged') { serverSignature = ''; request(true); return; }
  if (data.type === 'details') {
    if (data.id === selected && detailPre) {
      detailPre.textContent = data.text;
      document.querySelector('.detail-row')?.scrollIntoView({ block: 'nearest' });
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
    elements.logs.replaceChildren();
    refreshRequested = true;
  }
  generation = data.generation;
  if (data.timezone && data.timezone !== displayTimezone) { displayTimezone = data.timezone; lastRows = undefined; }
  if (Number.isFinite(data.refreshIntervalMs)) refreshIntervalMs = data.refreshIntervalMs;
  newest = data.newest;
  elements.status.textContent = data.status;
  elements.command.textContent = data.command;
  elements.command.title = data.command;
  elements.stop.disabled = !data.running;
  elements.stop.textContent = selectedServer ? 'Stop server' : 'Stop all';
  if (data.servers) {
    const signature = JSON.stringify(data.servers.map(server => [server.id, server.label]));
    if (signature !== serverSignature) {
      serverSignature = signature;
      const options = [document.createElement('option'), ...data.servers.map(() => document.createElement('option'))];
      options[0].textContent = 'All servers';
      options[0].value = '';
      data.servers.forEach((server, index) => {
        options[index + 1].textContent = server.label;
        options[index + 1].value = server.id;
      });
      elements.server.replaceChildren(...options);
      elements.server.value = data.servers.some(server => server.id === selectedServer) ? selectedServer : '';
      selectedServer = elements.server.value;
    }
  }
  const number = value => value.toLocaleString();
  const budget = Number.isFinite(data.maxBytes) ? (data.maxBytes / 1048576).toFixed(0) : '?';
  elements.counts.textContent = `${number(data.total)} received · ${number(data.retained)} retained · ${number(data.discarded)} discarded · ${(data.bytes / 1048576).toFixed(1)} / ${budget} MiB · ${data.truncated} truncated`;
  elements.mode.textContent = paused ? 'Paused — collection continues' : following ? 'Live · newest 1,000' : 'Browsing retained history';
  elements.mode.className = following && !paused ? 'live-mode' : '';
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
  } else {
    timer = setTimeout(() => request(), paused ? Math.max(refreshIntervalMs, 1000) : refreshIntervalMs);
  }
});

function cell(text, className) {
  const element = document.createElement('td');
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderRows(events) {
  const fragment = document.createDocumentFragment();
  selected = undefined;
  detailPre = undefined;
  for (const event of events) {
    const row = document.createElement('tr');
    row.className = 'event-row';
    const messageCell = cell('');
    const button = document.createElement('button');
    button.className = 'message-button';
    button.textContent = `${event.message}${event.truncated ? ' [truncated]' : ''}`;
    button.title = event.message;
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => expand(event.id, row, button));
    messageCell.append(button);
    row.append(cell(formatTimestamp(event), 'time'), cell(event.level, `level ${event.level}`), messageCell, cell(event.stream, 'source'));
    for (const column of currentColumns) row.append(cell(event.fields?.[column] ?? ''));
    fragment.append(row);
  }
  elements.logs.replaceChildren(fragment);
  if (following && !paused) {
    const scroll = document.querySelector('.table-scroll');
    scroll.scrollTop = scroll.scrollHeight;
  }
}

let displayTimezone = 'local';
function formatTimestamp(event) {
  if (!Number.isFinite(event.timestampMs)) return event.timestamp;
  const date = new Date(event.timestampMs);
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false };
  if (displayTimezone === 'utc') options.timeZone = 'UTC';
  else if (displayTimezone && displayTimezone !== 'local') options.timeZone = displayTimezone;
  try { return new Intl.DateTimeFormat(undefined, options).format(date); } catch { return event.timestamp; }
}

let currentColumns = [];
function updateColumns(columns) {
  const next = Array.isArray(columns) ? columns : [];
  if (JSON.stringify(next) === JSON.stringify(currentColumns)) return;
  currentColumns = next;
  const head = document.getElementById('head-row');
  head.replaceChildren(...['Time', 'Level', 'Message · click to expand', 'Source', ...currentColumns].map(label => {
    const th = document.createElement('th'); th.textContent = label; return th;
  }));
  lastRows = undefined;
}

function expand(id, row, button) {
  const wasSelected = selected === id;
  document.querySelector('.detail-row')?.remove();
  for (const toggle of elements.logs.querySelectorAll('[aria-expanded="true"]')) toggle.setAttribute('aria-expanded', 'false');
  selected = undefined;
  detailPre = undefined;
  if (wasSelected) return;
  // Keep the page still while inspecting an event; collection continues.
  paused = true;
  selected = id;
  button.setAttribute('aria-expanded', 'true');
  const details = document.createElement('tr');
  details.className = 'detail-row';
  const container = cell('', 'detail-cell');
  container.colSpan = 4 + currentColumns.length;
  const copy = document.createElement('button');
  copy.textContent = 'Copy event';
  copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', id }));
  detailPre = document.createElement('pre');
  detailPre.textContent = 'Loading…';
  container.append(copy, detailPre);
  details.append(container);
  row.after(details);
  vscode.postMessage({ type: 'details', id });
}

function setFollowing(value) {
  following = value;
  before = value ? undefined : newest;
  elements.follow.setAttribute('aria-pressed', String(value));
  elements.follow.textContent = value ? 'Live' : 'Browse';
}

function saveState() {
  vscode.setState({ query: elements.search.value, level: elements.level.value, server: selectedServer });
}

function filterChanged() {
  page = 0;
  lastRows = undefined;
  saveState();
  request(true);
}

elements.search.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(filterChanged, 150);
});
elements.level.addEventListener('change', filterChanged);
elements.server.addEventListener('change', () => {
  selectedServer = elements.server.value;
  page = 0;
  lastRows = undefined;
  saveState();
  request(true);
});
elements.follow.addEventListener('click', () => {
  setFollowing(!following);
  if (following) {
    page = 0;
    paused = false;
  }
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
elements.run.addEventListener('click', () => vscode.postMessage({ type: 'run', serverId: elements.server.value || undefined }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) request(); else clearTimeout(timer); });
request();
