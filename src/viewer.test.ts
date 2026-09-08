import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import * as path from 'node:path';

// A minimal DOM adapter checks the real webview's message/state transitions.
// It does not simulate layout; visual verification still needs a browser.
class Element {
  children: Element[] = [];
  listeners = new Map<string, (event?: any) => void>();
  dataset: Record<string, unknown> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  value = '';
  open = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 300;
  clientWidth = 1000;
  get firstChild() { return this.children[0]; }
  get classList() { return { contains: (name: string) => this.className.split(' ').includes(name) }; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  addEventListener(name: string, callback: (event?: any) => void) { this.listeners.set(name, callback); }
  removeEventListener(name: string, callback: (event?: any) => void) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; if (name === 'class') this.className = value; }
  contains(element: Element) { return this.children.includes(element); }
  closest() { return this; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
  getBoundingClientRect() { return { height: 30, width: 140 }; }
  remove() {}
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
}

function viewer() {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const messages: Record<string, any>[] = [];
  const window = new Element();
  const document = Object.assign(new Element(), {
    getElementById: get, querySelector: () => get('viewport'),
    createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: () => new Element(), createDocumentFragment: () => new Element()
  });
  const runtime = createContext({ document, window, Intl, console,
    acquireVsCodeApi: () => ({ getState: () => ({ query: 'timeout', levels: ['error'], server: 'api' }), setState() {},
      postMessage: (message: Record<string, any>) => messages.push(message) }),
    ResizeObserver: class { observe() {} }, requestAnimationFrame() {}, setInterval() {}, setTimeout() {}, clearTimeout() {}
  });
  runInContext(readFileSync(path.join(__dirname, '../media/viewer.js'), 'utf8'), runtime);
  const run = (script: string) => runInContext(script, runtime);
  const receive = (data: Record<string, unknown>) => window.listeners.get('message')!({ data });
  receive({ type: 'snapshot', generation: 1, newest: 100, status: 'Running', command: 'node server', running: true,
    total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 42, message: 'timeout', level: 'error', timestamp: '12:00', stream: 'stderr' }],
    columns: [], page: 0, pages: 2, matched: 100 });
  return { get, messages, run, receive };
}

test('context preserves search, levels, server, paging, pause state and scroll position', () => {
  const { get, run, receive, messages } = viewer();
  get('older').listeners.get('click')!();
  run('toggleExpand(42)');
  get('viewport').scrollTop = 450;
  const state = () => run('JSON.stringify({ page, before, following, paused, selected, selectedServer, levels: [...checkedLevels], query: elements.search.value })');
  const original = state();
  run('showContext(42)');
  assert.equal(get('contextDialog').open, true);
  assert.equal(messages.at(-1)?.type, 'context');
  receive({ type: 'context', id: 42, server: 'API', missing: false, events: [
    { id: 41, message: 'Preparing', level: 'debug', timestamp: '12:00', stream: 'stdout' },
    { id: 42, message: 'timeout', level: 'error', timestamp: '12:00', stream: 'stderr' }
  ] });
  assert.equal(get('contextLogs').children.length, 2);
  assert.equal(messages.at(-1)?.target, 'context');
  run('selectContextEvent(41)');
  receive({ type: 'details', target: 'context', id: 42, text: 'stale', exceptions: [] });
  assert.equal(get('contextDetails').textContent, 'Loading…');
  get('viewport').scrollTop = 10;
  get('contextClose').listeners.get('click')!();
  assert.equal(get('contextDialog').open, false);
  assert.equal(get('viewport').scrollTop, 450);
  assert.equal(state(), original);
  receive({ type: 'context', id: 42, missing: false, events: [{ id: 99 }] });
  assert.equal(get('contextLogs').children.length, 0, 'late responses cannot reopen a closed context');
});

test('context handles evicted anchors and source links send only frame coordinates', () => {
  const { get, run, receive, messages } = viewer();
  run('toggleExpand(42); showContext(42)');
  receive({ type: 'context', id: 42, missing: true, events: [] });
  assert.match(get('contextStatus').textContent, /discarded/);
  assert.equal(get('contextLogs').children.length, 0);
  const details = run(`buildEventDetails(42, 'raw', [{ title: '<script>unsafe</script>', lines: [
    { text: '    at run (src/main.ts:42:9)', source: { file: 'src/main.ts', line: 42, column: 9 } }
  ] }])`) as Element;
  assert.equal(details.querySelector('.exception-block')?.children[0].textContent, '<script>unsafe</script>');
  const source = details.querySelector('.source-link')!;
  get('contextDetails').listeners.get('click')!({ target: { closest: (selector: string) => selector === '.source-link' ? source : undefined } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'openSource', id: 42, block: 0, line: 0 });
});

test('plain logs initialize interactive headers and sorting toggles the displayed source field', () => {
  const { get, run, messages } = viewer();
  assert.equal(get('head-row').children.length, 4);
  const sourceHeader = () => get('head-row').children.find(header => header.dataset.column === 'base:source')!;
  sourceHeader().querySelector('.column-sort')!.listeners.get('click')!();
  assert.equal(messages.at(-1)?.sort, 'stream');
  assert.equal(messages.at(-1)?.sortDirection, 'desc');
  assert.equal(sourceHeader().attributes['aria-sort'], 'descending');
  assert.equal(get('viewport').scrollTop, 0);
  run('pending = false');
  sourceHeader().querySelector('.column-sort')!.listeners.get('click')!();
  assert.equal(messages.at(-1)?.sortDirection, 'asc');
  assert.equal(sourceHeader().attributes['aria-sort'], 'ascending');
  run('renderRows(virtualEvents)');
  assert.equal(get('viewport').scrollTop, 0, 'live updates must not scroll a sorted result to the bottom');
  assert.equal(get('older').textContent, 'Next →');
});

test('resize updates the actual table column and preserves its width after column reorder', () => {
  const { get, run, messages } = viewer();
  const timeHeader = get('head-row').children[0];
  const messageCount = messages.length;
  timeHeader.querySelector('.resize-handle')!.listeners.get('pointerdown')!({ clientX: 100, button: 0 });
  run("document.listeners.get('pointermove')({ clientX: 180 })");
  assert.equal(get('eventColumns').children[0].style.width, '220px');
  assert.equal(get('eventsTable').style.width, '1000px');
  run("document.listeners.get('pointerup')()");
  assert.equal(run("document.listeners.has('pointermove')"), false);
  assert.equal(messages.length, messageCount, 'resizing must not issue a sort request');
  run("columnOrder = ['base:message', 'base:level', 'base:source', 'base:time']; updateColumns([], true)");
  assert.equal(get('head-row').children[3].dataset.column, 'base:time');
  assert.equal(get('eventColumns').children[3].style.width, '220px');
  assert.equal(get('head-row').children[0].querySelector('.column-grip')!.listeners.has('dragstart'), true);
});

test('saved searches restore visible filter controls and expose useful empty states', () => {
  const { get, receive } = viewer();
  receive({ type: 'searches', searches: { saved: [] } });
  assert.match(get('savedSearchList').children[0].textContent, /Save a search/);
  receive({ type: 'searches', searches: { saved: [{ id: 's1', name: 'Warnings', query: 'slow', levels: ['warn'], serverId: 'worker' }] } });
  get('savedSearchList').children[0].querySelector('.search-item')!.listeners.get('click')!();
  assert.equal(get('search').value, 'slow');
  assert.equal(get('server').value, 'worker');
  assert.equal(get('levelButton').textContent, 'Warn only');
  assert.equal(get('searchToolsPanel').hidden, true);
});

test('save current opens a dialog (not window.prompt, which webviews block) and posts the entered name', () => {
  const { get, messages } = viewer();
  get('search').value = 'timeout';
  get('saveSearch').listeners.get('click')!();
  assert.equal(get('saveSearchDialog').open, true);
  assert.equal(get('saveSearchName').value, 'timeout');
  get('saveSearchName').value = 'Timeouts';
  get('saveSearchForm').listeners.get('submit')!({ preventDefault() {} });
  assert.equal(get('saveSearchDialog').open, false);
  const saved = messages.find(message => message.type === 'saveSearch');
  assert.equal(saved?.name, 'Timeouts');
  assert.equal(saved?.query, 'timeout');
});

test('analysis renders log patterns with a trend sparkline, flags anomalous chart buckets, and shows error-group stack locations', () => {
  const { get, receive } = viewer();
  receive({ type: 'analysis', analysis: {
    rate: [{ bucket: 0, count: 1, anomalous: false }, { bucket: 1, count: 40, anomalous: true }],
    errors: [{ bucket: 0, count: 0, anomalous: false }],
    latency: [{ bucket: 0, average: 10, p95: 12, count: 1, anomalous: false }],
    statusCodes: [],
    patterns: [{ key: 'user <n> logged in', message: 'user 1 logged in', level: 'info', count: 3, sampleIds: [1], trend: [1, 2] }],
    errorGroups: [{ key: 'paymenterror@/work/billing.ts:55', message: 'Failed to charge card', count: 2, sampleIds: [1], location: '/work/billing.ts:55' }],
    range: {}
  } });
  const content = get('analysisContent');
  const patternRow = content.querySelectorAll('.pattern-row')[0];
  assert.match(patternRow.querySelector('.pattern-text')!.textContent, /3 × user 1 logged in/);
  assert.equal(content.querySelectorAll('.sparkline-bar').length, 2);
  assert.equal(content.querySelectorAll('.anomalous').length, 1);
  assert.equal(content.querySelectorAll('.anomaly-marker').length, 1);
  const groupsSection = content.children[0].children[4];
  assert.match(groupsSection.children[1].textContent, /2 × Failed to charge card — \/work\/billing\.ts:55/);
});

test('analysis renders status codes', () => {
  const { get, receive } = viewer();
  receive({ type: 'analysis', analysis: {
    rate: [], errors: [], latency: [], statusCodes: [{ code: '200', count: 8 }, { code: '500', count: 2 }],
    patterns: [], errorGroups: [],
    range: {}
  } });
  const content = get('analysisContent').children[0];
  const statusSection = content.children[2];
  assert.deepEqual(statusSection.children.slice(1).map(p => p.textContent), ['200: 8', '500: 2']);
});

test('facets popover requests values for the selected field and a value click inserts a filter', () => {
  const { get, run, messages, receive } = viewer();
  run('requestFacets()');
  const request = messages.at(-1)!;
  assert.equal(request.type, 'facets');
  assert.equal(request.field, 'level');
  receive({ type: 'facets', field: 'level', values: [{ value: 'error', count: 5 }] });
  const button = get('facetValues').children[0];
  assert.equal(button.querySelector('.facet-count')!.textContent, '5');
  button.listeners.get('click')!();
  assert.equal(get('search').value, 'level:"error"');
  receive({ type: 'facets', field: 'level', values: [] });
  assert.match(get('facetValues').children[0].textContent, /No values found/);
});

test('autocomplete suggestions list known field names alongside matching values', () => {
  const { get, receive } = viewer();
  receive({ type: 'autocomplete', fields: ['service', 'status'], values: [{ value: 'api', count: 4 }] });
  assert.deepEqual(get('fieldSuggestions').children.map(option => option.value), ['service', 'status', 'api']);
});
