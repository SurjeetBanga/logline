const vscode = acquireVsCodeApi();
const elements = Object.fromEntries(
  ['logs', 'empty', 'search', 'fieldSuggestions', 'searchHelp', 'searchHelpPanel', 'searchTools', 'searchToolsPanel', 'saveSearch', 'savedSearchList',
    'facetButton', 'facetPanel', 'facetField', 'facetValues', 'fieldsButton', 'fieldsPanel', 'fieldList', 'analyze', 'analysisDialog', 'analysisClose', 'analysisStatus', 'analysisContent',
    'levelButton', 'levelMenu', 'server', 'follow',
    'config', 'manage', 'export', 'import', 'clear', 'stop', 'run', 'status', 'sessions', 'command',
    'older', 'newer', 'page', 'mode', 'counts', 'contextDialog', 'contextClose', 'contextExport', 'contextStatus', 'contextLogs', 'contextDetails',
    'saveSearchDialog', 'saveSearchForm', 'saveSearchName', 'saveSearchCancel']
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
let selectedExceptions = [];
let contextAnchor;
let contextSelected;
let contextScrollTop = 0;
let contextEvents = [];
let selectedServer = saved.server ?? '';
let selectedSort = saved.sort ?? '';
let selectedSortDirection = saved.sortDirection === 'asc' ? 'asc' : 'desc';
let sortFields = [];
let allFields = [];
let columnWidths = saved.columnWidths && typeof saved.columnWidths === 'object' ? saved.columnWidths : {};
let serverSignature = '';
let searchDebounce;
let autocompleteDebounce;

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
    button.addEventListener('click', event => {
      // buildLevelMenu() below replaces this button's DOM node, detaching it
      // before the document-level click listener runs in the bubble phase —
      // without stopping propagation here, container.contains(event.target)
      // would then see a detached node and incorrectly close the popover.
      event.stopPropagation();
      setAllLevels(value);
    });
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
    close(restoreFocus = false) {
      panel.hidden = true; button.setAttribute('aria-expanded', 'false');
      if (restoreFocus) button.focus();
    },
    open() {
      for (const other of popovers) if (other !== api) other.close();
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // Keep menus inside the panel even when their trigger wraps to a new row.
      panel.style.left = '0px';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.maxHeight = '';
      const bounds = panel.getBoundingClientRect();
      if (Number.isFinite(bounds.left) && Number.isFinite(window.innerWidth)) {
        panel.style.left = `${Math.max(14 - bounds.left, Math.min(0, window.innerWidth - 14 - bounds.right))}px`;
      }
      // A panel that runs past the bottom of a short viewport (e.g. a docked
      // VS Code panel) would otherwise grow the document's scroll area,
      // shrinking the viewport width and shifting the whole layout. Flip it
      // above the trigger when there's more room there, and cap its height
      // to whichever side it lands on so it always fits without scrolling
      // the page.
      const margin = 8;
      // No lower floor: the panel must always fit fully on screen (its own
      // overflow-y handles the rest), otherwise a forced minimum here would
      // push it past the opposite edge in a very short viewport.
      const cap = value => Math.max(0, Math.min(value, window.innerHeight * 0.65));
      const spaceBelow = window.innerHeight - bounds.bottom - margin;
      const spaceAbove = button.getBoundingClientRect().top - margin;
      if (spaceBelow < 80 && spaceAbove > spaceBelow) {
        panel.style.top = '';
        panel.style.bottom = 'calc(100% + 4px)';
        panel.style.maxHeight = `${cap(spaceAbove)}px`;
      } else {
        panel.style.maxHeight = `${cap(spaceBelow)}px`;
      }
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
  for (const popover of popovers) if (popover.isOpen()) popover.close(true);
});
window.addEventListener('resize', () => { for (const popover of popovers) popover.close(); });

// Only one page may be in flight. Pausing never queues incoming events.
function request(force = false) {
  if (document.hidden) return;
  if (pending) { refreshRequested ||= force; return; }
  pending = true;
  forcedRequest = force;
  vscode.postMessage({ type: 'snapshot', query: elements.search.value, serverId: selectedServer || undefined,
    levels: currentLevels(), page, before, sort: selectedSort || undefined, sortDirection: selectedSortDirection,
    statsOnly: paused && !force });
}

window.addEventListener('message', ({ data }) => {
  // Pushed by the extension whenever retained data or status actually
  // changes, coalesced on its side. This replaces polling on a fixed
  // interval, so an idle server costs nothing here.
  if (data.type === 'update') { request(); return; }
  if (data.type === 'serversChanged') { serverSignature = ''; request(true); return; }
  if (data.type === 'context') {
    if (!elements.contextDialog.open || data.id !== contextAnchor) return;
    elements.contextStatus.textContent = data.missing
      ? 'This event has been discarded from retained history. Close this view to return to your results.'
      : `${data.server || 'Source'} · Same session · All levels and captured streams · Up to 25 retained events before and after · Snapshot in capture order`;
    contextEvents = data.events ?? [];
    elements.contextLogs.replaceChildren(...data.events.map(event => {
      const row = document.createElement('tr');
      row.dataset.id = event.id;
      row.className = event.id === contextAnchor ? 'context-anchor' : '';
      const message = cell('');
      const button = document.createElement('button');
      button.className = 'context-event';
      button.dataset.id = event.id;
      button.textContent = `${event.id === contextAnchor ? 'Selected: ' : ''}${event.message ?? ''}${event.truncated ? ' [truncated]' : ''}`;
      message.append(button);
      row.append(cell(formatTimestamp(event), 'time'), cell(event.level, `level ${event.level}`), message, cell(event.stream, 'source'));
      return row;
    }));
    elements.contextLogs.querySelector('.context-anchor')?.scrollIntoView({ block: 'center' });
    if (!data.missing) selectContextEvent(contextAnchor);
    return;
  }
  if (data.type === 'details') {
    if (data.target === 'context') {
      if (elements.contextDialog.open && data.id === contextSelected) {
        elements.contextDetails.replaceChildren(buildEventDetails(data.id, data.text, data.exceptions ?? []));
      }
      return;
    }
    if (data.id === selected) {
      selectedDetailText = data.text;
      selectedExceptions = data.exceptions ?? [];
      renderWindow();
      elements.logs.querySelector('.detail-row')?.scrollIntoView({ block: 'nearest' });
    }
    return;
  }
  if (data.type === 'autocomplete') { renderAutocomplete(data); return; }
  if (data.type === 'facets') { renderFacets(data); return; }
  if (data.type === 'analysis') { elements.analysisStatus.textContent = 'Analysis of the current retained filter'; renderAnalysis(data.analysis); return; }
  if (data.type === 'searches') { renderSearchState(data.searches); return; }
  if (data.type !== 'snapshot') return;
  pending = false;
  if (generation !== undefined && generation !== data.generation) {
    before = undefined;
    page = 0;
    lastRows = undefined;
    selected = undefined;
    selectedDetailText = undefined;
    selectedExceptions = [];
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
    ['running', 'stopping'].includes(session.status)) : [];
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
        options[index + 1].className = `server-status-${server.status}`;
        options[index + 1].title = [server.lastSession ? `Session ${server.lastSession}` : undefined,
          server.taskName ? `Task ${server.taskName}${server.taskType ? ` (${server.taskType})` : ''}` : undefined,
          server.dependencyState ? `Dependencies: ${server.dependencies?.join(', ') || 'none'} (${server.dependencyState})` : undefined,
          server.exitReason ? `Exit: ${server.exitReason}` : undefined].filter(Boolean).join(' · ') || server.status;
      });
      elements.server.replaceChildren(...options);
      elements.server.value = data.servers.some(server => server.id === selectedServer) ? selectedServer : '';
      const selected = data.servers.find(server => server.id === elements.server.value);
      elements.server.className = selected ? `server-status-${selected.status}` : '';
      selectedServer = elements.server.value;
    }
  }
  const number = value => value.toLocaleString();
  const budget = Number.isFinite(data.maxBytes) ? (data.maxBytes / 1048576).toFixed(0) : '?';
  elements.counts.textContent = `${number(data.total)} received · ${number(data.retained)} retained · ${number(data.discarded)} discarded · ${(data.bytes / 1048576).toFixed(1)} / ${budget} MiB · ${data.truncated} truncated`;
  updateModeLabel();
  updateColumns(data.columns ?? []);
  if (Array.isArray(data.fields)) { allFields = data.fields; updateSortOptions(data.fields); populateFacetFields(data.fields); }
  if (data.searches) renderSearchState(data.searches);
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

function renderSearchState(searches) {
  const makeButton = (item, label, removable = false) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'search-item'; button.textContent = label;
    button.title = item.query || item.serverId || '';
    button.addEventListener('click', () => {
      elements.search.value = item.query || '';
      selectedServer = item.serverId || '';
      checkedLevels = new Set(Array.isArray(item.levels) ? item.levels : LEVELS);
      elements.server.value = selectedServer;
      buildLevelMenu(); updateLevelButtonLabel();
      for (const popover of popovers) popover.close();
      elements.search.focus();
      page = 0; before = undefined; lastRows = undefined; saveState(); request(true);
    });
    if (!removable) return button;
    const row = document.createElement('div'); row.className = 'search-item-row'; row.append(button);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'search-remove'; remove.textContent = '×'; remove.title = 'Delete saved search';
    remove.setAttribute('aria-label', `Delete saved search: ${item.name}`);
    remove.addEventListener('click', event => { event.stopPropagation(); vscode.postMessage({ type: 'deleteSavedSearch', id: item.id }); });
    row.append(remove); return row;
  };
  const savedItems = (searches.saved ?? []).map(item => makeButton(item, item.name, true));
  elements.savedSearchList?.replaceChildren(...(savedItems.length ? savedItems : [emptyMessage('Save a search to reuse it here.')]));
}

function emptyMessage(text) {
  const message = document.createElement('p'); message.className = 'popover-empty'; message.textContent = text; return message;
}

function renderAutocomplete(data) {
  if (!elements.fieldSuggestions) return;
  elements.fieldSuggestions.replaceChildren(...[...(data.fields ?? []), ...(data.values ?? []).map(value => value.value)].map(value => {
    const option = document.createElement('option'); option.value = value; return option;
  }));
}

function populateFacetFields(columns = allFields.length ? allFields : currentColumns) {
  if (!elements.facetField) return;
  const names = [...new Set(['level', 'service', 'status', 'statusCode', 'durationMs', 'traceId', 'spanId', ...columns])];
  const current = elements.facetField.value;
  elements.facetField.replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  elements.facetField.value = names.includes(current) ? current : names[0];
}

function requestFacets() {
  const field = elements.facetField?.value;
  if (!field) return;
  elements.facetValues.replaceChildren(emptyMessage('Loading values…'));
  vscode.postMessage({ type: 'facets', field, query: elements.search.value, serverId: selectedServer || undefined });
}

function renderFacets(data) {
  if (!elements.facetValues) return;
  const values = (data.values ?? []).map(value => {
    const button = document.createElement('button'); button.className = 'facet-value'; button.type = 'button';
    const label = document.createElement('span'); label.className = 'facet-label'; label.textContent = value.value; button.title = value.value;
    const count = document.createElement('span'); count.className = 'facet-count'; count.textContent = String(value.count);
    button.append(label, count);
    button.addEventListener('click', () => {
      elements.search.value = `${data.field}:"${value.value}"`;
      for (const popover of popovers) popover.close();
      elements.search.focus(); filterChanged();
    });
    return button;
  });
  elements.facetValues.replaceChildren(...(values.length ? values : [emptyMessage('No values found for this field in the current results.')]));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function timeAxisFormatter(spanMs) {
  const options = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (spanMs !== undefined && spanMs < 3 * 60 * 1000) options.second = '2-digit';
  if (displayTimezone === 'utc') options.timeZone = 'UTC';
  else if (displayTimezone && displayTimezone !== 'local') options.timeZone = displayTimezone;
  try { return new Intl.DateTimeFormat(undefined, options); } catch { return null; }
}

// Real clock time for a bucket, so the x-axis reads like a timeline instead of an
// abstract 1..30 index - that's what made the previous version illegible.
function bucketTime(range, bucketCount, index) {
  if (range?.from === undefined || range?.to === undefined || !bucketCount) return undefined;
  const bucketSize = Math.max(1, (range.to - range.from) / bucketCount);
  return range.from + index * bucketSize;
}
function formatClock(ms, range) {
  const span = range?.from !== undefined && range?.to !== undefined ? range.to - range.from : undefined;
  const formatter = timeAxisFormatter(span);
  return formatter ? formatter.format(ms) : new Date(ms).toLocaleTimeString();
}

function chartLegend(items) {
  const legend = document.createElement('div'); legend.className = 'chart-legend';
  for (const item of items) {
    const entry = document.createElement('span'); entry.className = 'chart-legend-item';
    const swatch = document.createElement('span'); swatch.className = `chart-legend-swatch ${item.className}`;
    entry.append(swatch, document.createTextNode(item.label));
    legend.append(entry);
  }
  return legend;
}

function emptySection(title) {
  const section = document.createElement('section'); section.className = 'chart-section chart-wide';
  const heading = document.createElement('h3'); heading.textContent = title; section.append(heading);
  const empty = document.createElement('p'); empty.textContent = 'No data in this range.'; section.append(empty);
  return section;
}

function xAxisTicks(svg, bucketCount, range, xFor, height) {
  const tickEvery = Math.max(1, Math.round(bucketCount / 6));
  for (let index = 0; index < bucketCount; index += tickEvery) {
    const time = bucketTime(range, bucketCount, index);
    if (time === undefined) continue;
    const label = svgEl('text', { x: xFor(index), y: height - 4, class: 'chart-axis-label' });
    label.textContent = formatClock(time, range);
    svg.append(label);
  }
}

// Log volume over time with the error share stacked in red inside each bar - the
// standard "log histogram" view from tools like Kibana/Grafana, so a spike or an
// error-heavy period is visible at a glance instead of as two separate number lists.
function volumeChart(rate, errors, range) {
  const bucketCount = rate.length;
  if (!bucketCount || !rate.some(item => item.count > 0)) return emptySection('Event volume');
  const section = document.createElement('section'); section.className = 'chart-section chart-wide';
  const heading = document.createElement('h3'); heading.textContent = 'Event volume'; section.append(heading);
  const width = 720, height = 130, padTop = 10, padBottom = 18;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(1, ...rate.map(item => item.count));
  const barGap = 2;
  const barWidth = Math.max(1, width / bucketCount - barGap);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'volume-chart', role: 'img', 'aria-label': 'Event volume over time, with errors highlighted' });
  const maxLabel = svgEl('text', { x: 2, y: padTop, class: 'chart-axis-label' }); maxLabel.textContent = String(max);
  svg.append(maxLabel);
  rate.forEach((item, index) => {
    const errorCount = Math.min(item.count, errors[index]?.count ?? 0);
    const okCount = item.count - errorCount;
    const x = index * (barWidth + barGap);
    const okHeight = okCount / max * plotHeight;
    const errorHeight = errorCount / max * plotHeight;
    const anomalous = item.anomalous || errors[index]?.anomalous;
    const group = svgEl('g', { class: anomalous ? 'volume-bar anomalous' : 'volume-bar' });
    if (okHeight > 0) group.append(svgEl('rect', { x, width: barWidth, y: padTop + plotHeight - okHeight - errorHeight, height: okHeight, class: 'volume-bar-ok' }));
    if (errorHeight > 0) group.append(svgEl('rect', { x, width: barWidth, y: padTop + plotHeight - errorHeight, height: Math.max(1, errorHeight), class: 'volume-bar-error' }));
    const time = bucketTime(range, bucketCount, index);
    const title = svgEl('title');
    title.textContent = `${time !== undefined ? formatClock(time, range) + '\n' : ''}${item.count} event${item.count === 1 ? '' : 's'}${errorCount ? `, ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}`;
    group.append(title);
    if (anomalous) {
      const dot = svgEl('circle', { cx: x + barWidth / 2, cy: padTop - 5, r: 2.5, class: 'anomaly-marker' });
      const dotTitle = svgEl('title'); dotTitle.textContent = 'Unusually high compared to the rest of this range'; dot.append(dotTitle);
      group.append(dot);
    }
    svg.append(group);
  });
  xAxisTicks(svg, bucketCount, range, index => index * (barWidth + barGap) + barWidth / 2, height);
  section.append(svg, chartLegend([{ className: 'swatch-ok', label: 'events' }, { className: 'swatch-error', label: 'errors' }]));
  return section;
}

// Average + p95 latency over the same time axis as the volume chart, rather than two
// separate bar lists - this is how APM tools (Datadog, Grafana) conventionally pair
// a mean line with a percentile line so tail latency is visible alongside the average.
function latencyChart(latency, range) {
  const bucketCount = latency.length;
  if (!bucketCount || !latency.some(item => item.count > 0)) return emptySection('Latency (ms)');
  const section = document.createElement('section'); section.className = 'chart-section chart-wide';
  const heading = document.createElement('h3'); heading.textContent = 'Latency (ms)'; section.append(heading);
  const width = 720, height = 110, padTop = 10, padBottom = 18;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(1, ...latency.map(item => Math.max(item.average, item.p95)));
  const step = bucketCount > 1 ? width / (bucketCount - 1) : 0;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'latency-chart', role: 'img', 'aria-label': 'Average and p95 latency over time' });
  const maxLabel = svgEl('text', { x: 2, y: padTop, class: 'chart-axis-label' }); maxLabel.textContent = `${Math.round(max)}ms`;
  svg.append(maxLabel);
  const pathFor = key => {
    let d = ''; let drawing = false;
    latency.forEach((item, index) => {
      const x = index * step;
      if (item.count === 0) { drawing = false; return; }
      const y = padTop + plotHeight - item[key] / max * plotHeight;
      d += drawing ? ` L ${x} ${y}` : ` M ${x} ${y}`;
      drawing = true;
    });
    return d.trim();
  };
  svg.append(svgEl('path', { d: pathFor('p95'), class: 'latency-line latency-p95' }));
  svg.append(svgEl('path', { d: pathFor('average'), class: 'latency-line latency-average' }));
  latency.forEach((item, index) => {
    if (item.count === 0) return;
    const x = index * step;
    const y = padTop + plotHeight - item.average / max * plotHeight;
    const dot = svgEl('circle', { cx: x, cy: y, r: item.anomalous ? 2.5 : 1.5, class: item.anomalous ? 'latency-point anomalous' : 'latency-point' });
    const time = bucketTime(range, bucketCount, index);
    const title = svgEl('title');
    title.textContent = `${time !== undefined ? formatClock(time, range) + '\n' : ''}average ${Math.round(item.average)}ms, p95 ${Math.round(item.p95)}ms`;
    dot.append(title);
    svg.append(dot);
  });
  xAxisTicks(svg, bucketCount, range, index => index * step, height);
  section.append(svg, chartLegend([{ className: 'swatch-average', label: 'average' }, { className: 'swatch-p95', label: 'p95' }]));
  return section;
}

function sparkline(values) {
  const el = document.createElement('span'); el.className = 'sparkline';
  const max = Math.max(1, ...values);
  for (const value of values) {
    const bar = document.createElement('span'); bar.className = 'sparkline-bar'; bar.style.height = `${Math.max(8, value / max * 100)}%`;
    el.append(bar);
  }
  return el;
}

function renderAnalysis(analysis) {
  if (!elements.analysisContent) return;
  const content = document.createDocumentFragment();
  content.append(volumeChart(analysis.rate ?? [], analysis.errors ?? [], analysis.range));
  content.append(latencyChart(analysis.latency ?? [], analysis.range));
  const status = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = 'Status codes'; status.append(heading);
  for (const item of analysis.statusCodes ?? []) { const p = document.createElement('p'); p.textContent = `${item.code}: ${item.count}`; status.append(p); }
  content.append(status);
  const patterns = document.createElement('section'); const patternHeading = document.createElement('h3'); patternHeading.textContent = 'Log patterns'; patterns.append(patternHeading);
  for (const item of analysis.patterns ?? []) {
    const row = document.createElement('div'); row.className = 'pattern-row';
    const level = document.createElement('span'); level.className = `level ${item.level}`; level.textContent = item.level;
    const text = document.createElement('span'); text.className = 'pattern-text'; text.textContent = `${item.count} × ${item.message}`; text.title = item.message;
    row.append(level, text, sparkline(item.trend)); patterns.append(row);
  }
  if (!patterns.querySelector('.pattern-row')) { const empty = document.createElement('p'); empty.textContent = 'No data in this range.'; patterns.append(empty); }
  content.append(patterns);
  const groups = document.createElement('section'); const groupHeading = document.createElement('h3'); groupHeading.textContent = 'Error groups'; groups.append(groupHeading);
  for (const item of analysis.errorGroups ?? []) {
    const p = document.createElement('p');
    p.textContent = item.location ? `${item.count} × ${item.message} — ${item.location}` : `${item.count} × ${item.message}`;
    p.title = item.key; groups.append(p);
  }
  content.append(groups);
  elements.analysisContent.replaceChildren(content);
}


function totalColumnCount() { return displayedColumns.length; }

function buildRow(event) {
  const row = document.createElement('tr');
  row.className = 'event-row';
  row.dataset.id = event.id;
  const messageCell = cell('');
  const messageContent = document.createElement('div');
  messageContent.className = 'message-content';
  const button = document.createElement('button');
  button.className = 'message-button';
  button.textContent = `${event.message}${event.truncated ? ' [truncated]' : ''}`;
  button.title = event.message;
  button.setAttribute('aria-expanded', String(event.id === selected));
  messageContent.append(button);
  messageCell.append(messageContent);
  for (const column of displayedColumns) {
    if (column.key === 'base:time') row.append(cell(formatTimestamp(event), 'time'));
    else if (column.key === 'base:level') row.append(cell(event.level, `level ${event.level}`));
    else if (column.key === 'base:message') row.append(messageCell);
    else if (column.key === 'base:source') row.append(cell(event.stream, 'source'));
    else row.append(cell(event.fields?.[column.label] ?? ''));
  }
  return row;
}

function buildDetailRow(event) {
  const details = document.createElement('tr');
  details.className = 'detail-row';
  const container = cell('', 'detail-cell');
  container.colSpan = totalColumnCount();
  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const context = document.createElement('button');
  context.textContent = 'Show context';
  context.className = 'context-button';
  context.dataset.id = event.id;
  actions.append(context);
  container.append(actions, buildEventDetails(event.id, selectedDetailText, selectedExceptions));
  details.append(container);
  return details;
}

function buildEventDetails(id, text, exceptions) {
  const container = document.createElement('div');
  container.className = 'event-details';
  const copy = document.createElement('button');
  copy.className = 'copy-button';
  copy.textContent = 'Copy event';
  copy.dataset.id = id;
  container.append(copy);
  exceptions.forEach((exception, blockIndex) => {
    const section = document.createElement('section');
    section.className = 'exception-block';
    const title = document.createElement('strong');
    title.textContent = exception.title;
    const stack = document.createElement('div');
    stack.className = 'exception-stack';
    exception.lines.forEach((line, lineIndex) => {
      const element = document.createElement(line.source ? 'button' : 'div');
      element.textContent = line.text || ' ';
      if (line.source) {
        element.className = 'source-link';
        element.dataset.id = id;
        element.dataset.block = blockIndex;
        element.dataset.line = lineIndex;
        element.title = `Open ${line.source.file}:${line.source.line}`;
      }
      stack.append(element);
    });
    section.append(title, stack);
    container.append(section);
  });
  const pre = document.createElement('pre');
  pre.textContent = text ?? 'Loading…';
  if (exceptions.length) {
    const raw = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Original event';
    raw.append(summary, pre);
    container.append(raw);
  } else container.append(pre);
  return container;
}

function showContext(id) {
  contextAnchor = id;
  contextSelected = undefined;
  contextScrollTop = scrollViewport.scrollTop;
  elements.contextStatus.textContent = 'Loading…';
  elements.contextLogs.replaceChildren();
  elements.contextDetails.replaceChildren();
  contextEvents = [];
  elements.contextDialog.showModal();
  vscode.postMessage({ type: 'context', id });
}

function selectContextEvent(id) {
  contextSelected = id;
  elements.contextDetails.textContent = 'Loading…';
  for (const button of elements.contextLogs.querySelectorAll('.context-event')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.id) === id));
  }
  vscode.postMessage({ type: 'details', id, target: 'context' });
}

elements.contextClose.addEventListener('click', () => elements.contextDialog.close());
elements.contextExport?.addEventListener('click', () => vscode.postMessage({ type: 'exportContext', ids: contextEvents.map(event => event.id) }));
elements.contextDialog.addEventListener('close', () => {
  contextAnchor = undefined;
  contextSelected = undefined;
  elements.contextLogs.replaceChildren();
  elements.contextDetails.replaceChildren();
  contextEvents = [];
  scrollViewport.scrollTop = contextScrollTop;
});
elements.contextLogs.addEventListener('click', event => {
  const button = event.target.closest('.context-event');
  if (button) selectContextEvent(Number(button.dataset.id));
});
elements.contextDetails.addEventListener('click', handleDetailAction);

function handleDetailAction(event) {
  const source = event.target.closest('.source-link');
  if (source) {
    vscode.postMessage({ type: 'openSource', id: Number(source.dataset.id), block: Number(source.dataset.block), line: Number(source.dataset.line) });
    return true;
  }
  const copy = event.target.closest('.copy-button');
  if (copy) { vscode.postMessage({ type: 'copy', id: Number(copy.dataset.id) }); return true; }
  const context = event.target.closest('.context-button');
  if (context) { showContext(Number(context.dataset.id)); return true; }
  return false;
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
let expandedHeight = 0;

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
  const selectedIndex = virtualEvents.findIndex(event => event.id === selected);
  if (selectedIndex < 0) expandedHeight = 0;
  else {
    const detail = elements.logs.querySelector('.detail-row');
    if (detail) expandedHeight = detail.getBoundingClientRect().height;
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
  topSpacer.firstChild.colSpan = totalCols;
  topSpacer.firstChild.style.height = `${start * rowHeight + (selectedIndex >= 0 && selectedIndex < start ? expandedHeight : 0)}px`;
  bottomSpacer.firstChild.colSpan = totalCols;
  bottomSpacer.firstChild.style.height = `${(total - end) * rowHeight + (selectedIndex >= end ? expandedHeight : 0)}px`;
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
new ResizeObserver(() => { layoutColumns(); scheduleRenderWindow(); }).observe(scrollViewport);

function renderRows(events) {
  virtualEvents = events;
  renderWindow();
  if (following && !paused && !selectedSort) {
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
const baseColumns = [
  { key: 'base:time', label: 'Time' }, { key: 'base:level', label: 'Level' },
  { key: 'base:message', label: 'Message' }, { key: 'base:source', label: 'Source' }
];
let displayedColumns = [...baseColumns];
let availableColumns = [];
let columnOrder = Array.isArray(saved.columnOrder) ? saved.columnOrder : [];
let hiddenColumns = new Set(Array.isArray(saved.hiddenColumns) ? saved.hiddenColumns : []);
let draggedColumn;
let columnsInitialized = false;
let columnElements = new Map();
function updateColumns(columns, force = false) {
  const next = Array.isArray(columns) ? columns : [];
  if (columnsInitialized && !force && JSON.stringify(next) === JSON.stringify(availableColumns)) return;
  columnsInitialized = true;
  availableColumns = next;
  currentColumns = next.filter(label => !hiddenColumns.has(`field:${label}`));
  const allColumns = [...baseColumns, ...currentColumns.map(label => ({ key: `field:${label}`, label }))];
  const known = new Map(allColumns.map(column => [column.key, column]));
  displayedColumns = [...columnOrder.map(key => known.get(key)).filter(Boolean), ...allColumns.filter(column => !columnOrder.includes(column.key))];
  columnOrder = displayedColumns.map(column => column.key);
  columnElements = new Map(displayedColumns.map(column => [column.key, document.createElement('col')]));
  document.getElementById('eventColumns').replaceChildren(...columnElements.values());
  layoutColumns();
  const head = document.getElementById('head-row');
  head.replaceChildren(...displayedColumns.map(column => {
    const { key, label } = column;
    const th = document.createElement('th');
    const grip = document.createElement('span'); grip.className = 'column-grip'; grip.textContent = '⠿'; grip.title = `Drag to move ${label}`; grip.draggable = true; th.append(grip);
    const sortButton = document.createElement('button'); sortButton.type = 'button'; sortButton.className = 'column-sort';
    const labelText = document.createElement('span'); labelText.className = 'column-label'; labelText.textContent = label; sortButton.append(labelText);
    const sortKey = key === 'base:time' ? 'timestampMs' : key === 'base:level' ? 'level' : key === 'base:message' ? 'message' : key === 'base:source' ? 'stream' : label;
    const indicator = document.createElement('span'); indicator.className = 'sort-indicator';
    indicator.textContent = selectedSort === sortKey ? (selectedSortDirection === 'asc' ? '↑' : '↓') : '↕';
    indicator.setAttribute('aria-hidden', 'true');
    sortButton.append(indicator); th.append(sortButton);
    th.setAttribute('aria-sort', selectedSort === sortKey ? (selectedSortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    sortButton.title = `Sort by ${label}${selectedSort === sortKey ? (selectedSortDirection === 'asc' ? ' descending' : ' ascending') : ''}`;
    sortButton.setAttribute('aria-label', sortButton.title);
    th.dataset.column = key;
    sortButton.addEventListener('click', () => {
      selectedSortDirection = selectedSort === sortKey && selectedSortDirection === 'asc' ? 'desc' : 'asc';
      if (selectedSort !== sortKey) { selectedSort = sortKey; selectedSortDirection = 'desc'; }
      page = 0; lastRows = undefined; saveState(); updateColumns(availableColumns, true); updateModeLabel(); request(true);
      scrollViewport.scrollTop = 0;
      head.querySelectorAll('.column-sort')[displayedColumns.findIndex(column => column.key === key)]?.focus();
    });
    grip.addEventListener('dragstart', event => {
      draggedColumn = key; th.classList.add?.('column-dragging');
      event.dataTransfer?.setData('text/plain', key); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    th.addEventListener('dragover', event => { if (draggedColumn && draggedColumn !== key) { event.preventDefault(); th.classList.add('column-drop-target'); } });
    th.addEventListener('dragleave', () => th.classList.remove?.('column-drop-target'));
    th.addEventListener('drop', event => {
      event.preventDefault(); th.classList.remove?.('column-drop-target');
      const source = draggedColumn || event.dataTransfer?.getData('text/plain');
      if (!source || source === key) return;
      const order = displayedColumns.map(item => item.key); const from = order.indexOf(source); const to = order.indexOf(key);
      if (from < 0 || to < 0) return;
      order.splice(from, 1); order.splice(to, 0, source); columnOrder = order; saveState(); updateColumns(availableColumns, true); renderWindow();
    });
    grip.addEventListener('dragend', () => { draggedColumn = undefined; th.classList.remove?.('column-dragging', 'column-drop-target'); for (const item of head.querySelectorAll?.('.column-drop-target') ?? []) item.classList.remove?.('column-drop-target'); });
    const handle = document.createElement('span'); handle.className = 'resize-handle'; handle.dataset.column = key; handle.setAttribute('aria-label', `Resize ${label} column`);
    handle.title = `Drag to resize ${label}`;
    handle.draggable = false;
    handle.addEventListener('pointerdown', event => { event.stopPropagation?.(); resizeFromPointer(event, key, th); });
    handle.addEventListener('click', event => event.stopPropagation?.());
    th.append(handle);
    if (key.startsWith('field:')) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-column'; remove.textContent = '×'; remove.title = `Remove ${label} column`; remove.setAttribute('aria-label', `Remove ${label} column`);
      remove.addEventListener('click', event => { event.stopPropagation?.(); hiddenColumns.add(key); columnOrder = columnOrder.filter(item => item !== key); saveState(); updateColumns(availableColumns, true); renderWindow(); });
      th.append(remove);
    }
    return th;
  }));
  renderFieldList();
  populateFacetFields(allFields.length ? allFields : currentColumns);
  lastRows = undefined;
}

function layoutColumns() {
  if (!columnElements.size) return;
  const defaults = { 'base:time': 140, 'base:level': 110, 'base:source': 110 };
  const messageFloor = 300;
  const minWidth = 72;
  const isExplicit = key => Number.isFinite(Number(columnWidths[key]));
  const widthFor = key => {
    const savedWidth = Number(columnWidths[key]);
    return Number.isFinite(savedWidth) ? Math.max(minWidth, Math.min(1600, savedWidth)) : defaults[key] || 160;
  };
  const available = scrollViewport.clientWidth || 0;
  const fullOtherWidth = displayedColumns.filter(column => column.key !== 'base:message').reduce((sum, column) => sum + widthFor(column.key), 0);
  // Degrade gracefully in a narrow panel by collapsing the least essential
  // column (Source) instead of forcing horizontal scrolling.
  const sourceElement = columnElements.get('base:source');
  const collapseSource = Boolean(sourceElement) && available > 0 && fullOtherWidth + messageFloor > available;
  if (sourceElement) sourceElement.style.visibility = collapseSource ? 'collapse' : '';
  const columns = displayedColumns.filter(column => !(collapseSource && column.key === 'base:source'));
  const explicitWidth = columns.filter(column => isExplicit(column.key)).reduce((sum, column) => sum + widthFor(column.key), 0);
  // Columns without a manually-dragged width are free to shrink (down to the
  // same floor manual resizing enforces) so adding or removing columns keeps
  // everything fitting the panel instead of only the message column ever
  // reacting and the rest just forcing a horizontal scrollbar.
  const autoOthers = columns.filter(column => column.key !== 'base:message' && !isExplicit(column.key));
  const autoOthersNatural = autoOthers.reduce((sum, column) => sum + widthFor(column.key), 0);
  const remaining = available > 0 ? available - explicitWidth : -Infinity;
  let messageWidth;
  let shrinkRatio = 1;
  if (isExplicit('base:message')) {
    messageWidth = widthFor('base:message');
  } else if (remaining >= messageFloor + autoOthersNatural) {
    messageWidth = remaining - autoOthersNatural;
  } else {
    messageWidth = messageFloor;
    const minTotal = autoOthers.length * minWidth;
    const remainingForOthers = remaining - messageFloor;
    shrinkRatio = remainingForOthers > minTotal && autoOthersNatural > minTotal
      ? (remainingForOthers - minTotal) / (autoOthersNatural - minTotal) : 0;
  }
  let total = 0;
  for (const { key } of columns) {
    const width = key === 'base:message' ? messageWidth
      : isExplicit(key) ? widthFor(key)
      : Math.round(minWidth + (widthFor(key) - minWidth) * shrinkRatio);
    columnElements.get(key).style.width = `${width}px`;
    total += width;
  }
  document.getElementById('eventsTable').style.width = `${total}px`;
}

function resizeFromPointer(event, key, header) {
  if (event.button !== undefined && event.button !== 0) return;
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  const startX = event.clientX; const startWidth = header.getBoundingClientRect().width || Number(columnWidths[key]) || 80;
  const move = pointer => {
    const width = Math.max(72, Math.min(1600, startWidth + pointer.clientX - startX));
    columnWidths[key] = Math.round(width); layoutColumns();
  };
  const finish = () => {
    document.removeEventListener?.('pointermove', move);
    document.removeEventListener?.('pointerup', finish);
    document.removeEventListener?.('pointercancel', finish);
    saveState();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish, { once: true });
  document.addEventListener('pointercancel', finish, { once: true });
  event.preventDefault?.(); event.stopPropagation?.();
}

function updateSortOptions(fields) {
  sortFields = [...new Set(fields ?? [])];
}

function renderFieldList() {
  if (!elements.fieldList) return;
  if (!availableColumns.length) {
    elements.fieldList.replaceChildren(emptyMessage('Additional fields will appear when structured logs are received.'));
    return;
  }
  elements.fieldList.replaceChildren(...availableColumns.map(label => {
    const row = document.createElement('label'); row.className = 'field-toggle';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !hiddenColumns.has(`field:${label}`);
    input.addEventListener('change', () => { const key = `field:${label}`; if (input.checked) hiddenColumns.delete(key); else hiddenColumns.add(key); saveState(); updateColumns(availableColumns, true); renderWindow(); });
    row.append(input, document.createTextNode(label)); return row;
  }));
}

function toggleExpand(id) {
  expandedHeight = 0;
  selectedExceptions = [];
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
  elements.older.textContent = selectedSort ? 'Next →' : '← Older';
  elements.newer.textContent = selectedSort ? '← Previous' : 'Newer →';
  elements.mode.textContent = paused ? 'Paused — collection continues' : selectedSort
    ? `Sorted ${selectedSortDirection === 'asc' ? 'ascending' : 'descending'}${following ? ' · Live updates' : ''}`
    : following ? 'Live · newest 1,000' : 'Browsing retained history';
  elements.mode.className = following && !paused ? 'live-mode' : '';
}

function setFollowing(value) {
  following = value;
  before = value ? undefined : newest;
  updateFollowControl();
  updateModeLabel();
}

function saveState() {
  vscode.setState({ query: elements.search.value, levels: [...checkedLevels], server: selectedServer, sort: selectedSort, sortDirection: selectedSortDirection, columnWidths, columnOrder, hiddenColumns: [...hiddenColumns] });
}

function filterChanged() {
  page = 0;
  lastRows = undefined;
  saveState();
  request(true);
}

elements.logs.addEventListener('click', event => {
  if (handleDetailAction(event)) return;
  const button = event.target.closest('.message-button');
  if (!button) return;
  toggleExpand(Number(button.closest('tr').dataset.id));
});
elements.search.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(filterChanged, 150);
  clearTimeout(autocompleteDebounce);
  autocompleteDebounce = setTimeout(() => {
    vscode.postMessage({ type: 'autocomplete', input: elements.search.value, serverId: selectedServer || undefined });
  }, 150);
});
buildLevelMenu();
updateLevelButtonLabel();
updateFollowControl();
updateModeLabel();
createPopover(elements.levelButton.closest('.popover-container'), elements.levelButton, elements.levelMenu);
createPopover(elements.searchHelp.closest('.popover-container'), elements.searchHelp, elements.searchHelpPanel);
createPopover(elements.searchTools.closest('.popover-container'), elements.searchTools, elements.searchToolsPanel);
createPopover(elements.facetButton.closest('.popover-container'), elements.facetButton, elements.facetPanel);
createPopover(elements.fieldsButton.closest('.popover-container'), elements.fieldsButton, elements.fieldsPanel);
elements.facetButton.addEventListener('click', () => { if (!elements.facetPanel.hidden) requestFacets(); });
populateFacetFields();
elements.facetField?.addEventListener('change', requestFacets);
elements.saveSearch?.addEventListener('click', () => {
  for (const popover of popovers) popover.close();
  elements.saveSearchName.value = elements.search.value || '';
  elements.saveSearchDialog.showModal();
  elements.saveSearchName.select?.();
});
elements.saveSearchCancel?.addEventListener('click', () => elements.saveSearchDialog.close());
elements.saveSearchForm?.addEventListener('submit', event => {
  event.preventDefault();
  const name = elements.saveSearchName.value;
  elements.saveSearchDialog.close();
  vscode.postMessage({ type: 'saveSearch', name, query: elements.search.value, levels: currentLevels(), serverId: selectedServer || undefined });
});
elements.analyze?.addEventListener('click', () => {
  elements.analysisDialog.showModal();
  elements.analysisStatus.textContent = 'Loading analysis…';
  vscode.postMessage({ type: 'analysis', query: elements.search.value, levels: currentLevels(), serverId: selectedServer || undefined });
});
elements.analysisClose?.addEventListener('click', () => elements.analysisDialog.close());
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
    // The button promises to resume live updates, so jump back to the live
    // tail even if the pause happened while browsing older retained history.
    if (!following) { setFollowing(true); page = 0; }
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
elements.import.addEventListener('click', () => vscode.postMessage({ type: 'import' }));
elements.run.addEventListener('click', () => vscode.postMessage({ type: 'run', serverId: elements.server.value || undefined }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) request(); });
// A push should arrive whenever data actually changes; this is only a
// safety net in case one is ever missed.
setInterval(() => request(), 5000);
request();
