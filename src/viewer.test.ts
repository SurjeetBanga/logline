import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { afterEach, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import type { buildEventDetails } from './webview/inspection/details';
import type { createViewer } from './webview/viewer';

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
  parent?: Element;
  height = 30;
  focusCalls: unknown[] = [];
  scrollIntoViewCalls: unknown[] = [];
  onFocus?: (options?: { preventScroll?: boolean; }) => void;
  get firstChild() { return this.children[0]; }
  get classList() { return { contains: (name: string) => this.className.split(' ').includes(name) }; }
  append(...children: Element[]) { for (const child of children) child.parent = this; this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  addEventListener(name: string, callback: (event?: any) => void, options?: AddEventListenerOptions) {
    this.listeners.set(name, callback);
    if (options?.signal) setMaxListeners(0, options.signal);
    options?.signal?.addEventListener('abort', () => this.removeEventListener(name, callback), { once: true });
  }
  removeEventListener(name: string, callback: (event?: any) => void) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; if (name === 'class') this.className = value; }
  contains(element: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
  closest(selector: string): Element | undefined {
    if (selector === 'tr') return this.classList.contains('event-row') || this.classList.contains('detail-row') ? this : this.parent?.closest(selector);
    return this;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string): Element | undefined {
    const row = selector.match(/^tr.event-row\[data-id="(\d+)"\] .message-button$/);
    if (row) return this.querySelectorAll('.event-row').find(element => String(element.dataset.id) === row[1])?.querySelector('.message-button');
    return this.querySelectorAll(selector)[0];
  }
  getBoundingClientRect() { return { height: this.height, width: 140 }; }
  remove() { }
  focus(options?: { preventScroll?: boolean; }) { this.focusCalls.push(options); this.onFocus?.(options); }
  scrollIntoView(options?: unknown) { this.scrollIntoViewCalls.push(options); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
}

const disposables: { dispose(): void; }[] = [];
afterEach(() => { for (const item of disposables.splice(0)) item.dispose(); });
const bundle = buildSync({ stdin: { contents: "export { createViewer } from './src/webview/viewer'; export { buildEventDetails } from './src/webview/inspection/details';", resolveDir: process.cwd() }, bundle: true, format: 'cjs', platform: 'browser', write: false }).outputFiles[0].text;
function viewer() {
  const frames: (() => void)[] = [];
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const messages: Record<string, any>[] = [];
  const window = new Element();
  const document = Object.assign(new Element(), {
    activeElement: undefined as Element | undefined, getElementById: get, querySelector: () => get('viewport'),
    createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: () => new Element(), createDocumentFragment: () => new Element()
  });
  const runtime = createContext({
    document, window, Intl, console, AbortController, cancelAnimationFrame() { }, clearInterval() { }, module: { exports: {} },
    acquireVsCodeApi: () => ({
      getState: () => ({ query: 'timeout', levels: ['error'], server: 'api' }), setState() { },
      postMessage: (message: Record<string, any>) => messages.push(message)
    }),
    ResizeObserver: class { observe() { } disconnect() { } }, requestAnimationFrame: (callback: () => void) => frames.push(callback), setInterval() { }, setTimeout() { }, clearTimeout() { }
  });
  runInContext(bundle, runtime);
  const exports = runtime.module.exports as { createViewer: typeof createViewer; buildEventDetails: typeof buildEventDetails; };
  const app = exports.createViewer(runtime.acquireVsCodeApi());
  disposables.push(app);
  const renderDetails = (...args: Parameters<typeof buildEventDetails>) => exports.buildEventDetails(...args) as unknown as Element;
  const receive = (data: Record<string, unknown>) => window.listeners.get('message')!({ data });
  receive({
    type: 'snapshot', generation: 1, newest: 100, status: 'Running', command: 'node server', running: true,
    total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 42, message: 'timeout', level: 'error', timestamp: '12:00', stream: 'stderr' }],
    columns: [], page: 0, pages: 2, matched: 100
  });
  const flushFrames = () => { let count = 0; while (frames.length && count++ < 10) frames.shift()!(); assert.ok(count < 10, 'rendering settles without a scroll loop'); };
  return { get, messages, app, runtime, dom: document, renderDetails, receive, flushFrames };
}

test('context preserves search, levels, server, paging, pause state and scroll position', () => {
  const { get, app, receive, messages } = viewer();
  get('older').listeners.get('click')!();
  app.table.toggleExpand(42);
  get('viewport').scrollTop = 450;
  const state = () => JSON.stringify({ page: app.state.page, before: app.state.before, following: app.state.following, paused: app.state.paused, selected: app.state.selected, selectedServer: app.state.selectedServer, levels: [...app.state.checkedLevels], query: get("search").value });
  const original = state();
  app.inspection.showContext(42);
  assert.equal(get('contextDialog').open, true);
  assert.equal(messages.at(-1)?.type, 'context');
  receive({
    type: 'context', id: 42, server: 'API', missing: false, events: [
      { id: 41, message: 'Preparing', level: 'debug', timestamp: '12:00', stream: 'stdout' },
      { id: 42, message: 'timeout', level: 'error', timestamp: '12:00', stream: 'stderr' }
    ]
  });
  assert.equal(get('contextLogs').children.length, 2);
  assert.equal(messages.at(-1)?.target, 'context');
  app.inspection.selectContextEvent(41);
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
  const { get, app, renderDetails, receive, messages } = viewer();
  (() => {
    app.table.toggleExpand(42);
    app.inspection.showContext(42);
  })();
  receive({ type: 'context', id: 42, missing: true, events: [] });
  assert.match(get('contextStatus').textContent, /discarded/);
  assert.equal(get('contextLogs').children.length, 0);
  const details = renderDetails(42, 'raw', [{
    title: '<script>unsafe</script>', lines: [
      { text: '    at run (src/main.ts:42:9)', source: { file: 'src/main.ts', line: 42, column: 9 } }
    ]
  }]) as Element;
  assert.equal(details.querySelector('.exception-block')?.children[0].textContent, '<script>unsafe</script>');
  const source = details.querySelector('.source-link')!;
  get('contextDetails').listeners.get('click')!({ target: { closest: (selector: string) => selector === '.source-link' ? source : undefined } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'openSource', id: 42, block: 0, line: 0 });
});

test('plain logs initialize interactive headers and sorting toggles the displayed source field', () => {
  const { get, app, messages } = viewer();
  assert.equal(get('head-row').children.length, 4);
  const sourceHeader = () => get('head-row').children.find(header => header.dataset.column === 'base:source')!;
  sourceHeader().querySelector('.column-sort')!.listeners.get('click')!();
  assert.equal(messages.at(-1)?.sort, 'stream');
  assert.equal(messages.at(-1)?.sortDirection, 'desc');
  assert.equal(sourceHeader().attributes['aria-sort'], 'descending');
  assert.equal(get('viewport').scrollTop, 0);
  app.bridge.pending = false;
  sourceHeader().querySelector('.column-sort')!.listeners.get('click')!();
  assert.equal(messages.at(-1)?.sortDirection, 'asc');
  assert.equal(sourceHeader().attributes['aria-sort'], 'ascending');
  app.table.renderRows(app.table.events);
  assert.equal(get('viewport').scrollTop, 0, 'live updates must not scroll a sorted result to the bottom');
  assert.equal(get('older').textContent, 'Next →');
});

test('resize updates the actual table column and preserves its width after column reorder', () => {
  const { get, app, dom, messages } = viewer();
  const timeHeader = get('head-row').children[0];
  const messageCount = messages.length;
  timeHeader.querySelector('.resize-handle')!.listeners.get('pointerdown')!({ clientX: 100, button: 0 });
  dom.listeners.get('pointermove')!({ clientX: 180 });
  assert.equal(get('eventColumns').children[0].style.width, '220px');
  assert.equal(get('eventsTable').style.width, '1000px');
  dom.listeners.get('pointerup')!();
  assert.equal(dom.listeners.has('pointermove'), false);
  assert.equal(messages.length, messageCount, 'resizing must not issue a sort request');
  (() => {
    app.state.columnOrder = ['base:message', 'base:level', 'base:source', 'base:time'];
    app.table.updateColumns([], true);
  })();
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
  get('saveSearchForm').listeners.get('submit')!({ preventDefault() { } });
  assert.equal(get('saveSearchDialog').open, false);
  const saved = messages.find(message => message.type === 'saveSearch');
  assert.equal(saved?.name, 'Timeouts');
  assert.equal(saved?.query, 'timeout');
});

test('analysis renders log patterns with a trend sparkline, flags anomalous chart buckets, and shows error-group stack locations', () => {
  const { get, receive } = viewer();
  receive({
    type: 'analysis', analysis: {
      rate: [{ bucket: 0, count: 1, anomalous: false }, { bucket: 1, count: 40, anomalous: true }],
      errors: [{ bucket: 0, count: 0, anomalous: false }],
      latency: [{ bucket: 0, average: 10, p95: 12, count: 1, anomalous: false }],
      statusCodes: [],
      patterns: [{ key: 'user <n> logged in', message: 'user 1 logged in', level: 'info', count: 3, sampleIds: [1], trend: [1, 2] }],
      errorGroups: [{ key: 'paymenterror@/work/billing.ts:55', message: 'Failed to charge card', count: 2, sampleIds: [1], location: '/work/billing.ts:55' }],
      range: {}
    }
  });
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
  receive({
    type: 'analysis', analysis: {
      rate: [], errors: [], latency: [], statusCodes: [{ code: '200', count: 8 }, { code: '500', count: 2 }],
      patterns: [], errorGroups: [],
      range: {}
    }
  });
  const content = get('analysisContent').children[0];
  const statusSection = content.children[2];
  assert.deepEqual(statusSection.children.slice(1).map(p => p.textContent), ['200: 8', '500: 2']);
});

test('facets popover requests values for the selected field and a value click inserts a filter', () => {
  const { get, app, messages, receive } = viewer();
  app.search.requestFacets();
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

test('Live settles at the new bottom after layout and resumes even when row IDs are unchanged', () => {
  const { get, app, flushFrames } = viewer();
  app.table.renderRows(Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, level: "info", message: "line " + i })));
  get('viewport').scrollHeight = 32000; // layout finishes after the initial render
  flushFrames();
  assert.equal(get('viewport').scrollTop, 32000);
  (() => {
    app.state.paused = true;
    app.state.following = false;
    app.state.before = 50;
    app.state.page = 3;
    app.state.selectedSort = "message";
    app.state.selected = 42;
  })();
  get('viewport').scrollTop = 100;
  get('follow').listeners.get('click')!();
  flushFrames();
  assert.equal(get('viewport').scrollTop, 32000);
  assert.equal(app.state.following && !app.state.paused && app.state.page === 0 && app.state.before === undefined && app.state.selectedSort === "" && app.state.selected === undefined, true);
  assert.equal(app.state.lastRows, undefined, 'the same result IDs must still be rendered after resuming');
});

test('scrolling past expanded details keeps their DOM state and does not repeatedly replace rows', () => {
  const { get, app, flushFrames, receive } = viewer();
  get('viewport').scrollTop = 0;
  (() => {
    app.state.following = false;
    app.table.renderRows(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, level: "info", message: "line " + i })));
    app.table.toggleExpand(10);
  })();
  receive({ type: 'details', id: 10, text: 'large payload', exceptions: [] });
  const detail = get('logs').querySelector('.detail-row')!;
  detail.height = 350;
  detail.querySelector('.event-details')!.scrollTop = 200;
  flushFrames();
  const children = get('logs').children;
  get('viewport').scrollTop = 1;
  app.table.renderWindow();
  assert.equal(get('logs').children, children, 'a scroll within the same virtual window preserves the DOM');
  assert.equal(detail.scrollIntoViewCalls.length, 0, 'detail responses must not yank the viewport');
  get('viewport').scrollTop = 2300; app.table.renderWindow();
  assert.equal(get('viewport').scrollTop, 2300);
  get('viewport').scrollTop = 0; app.table.renderWindow();
  assert.equal(get('logs').querySelector('.detail-row'), detail);
  assert.equal(detail.querySelector('.event-details')!.scrollTop, 200);
  assert.equal(app.table.expandedHeight, 350);
});

test('restoring row focus during scrolling uses preventScroll', () => {
  const { get, app, dom } = viewer();
  get('viewport').scrollTop = 0;
  (() => {
    app.state.following = false;
    app.table.renderRows(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, level: "info", message: "line " + i })));
  })();
  const focused = get('logs').querySelector('tr.event-row[data-id="10"] .message-button')!;
  dom.activeElement = get("logs").querySelector('tr.event-row[data-id="10"] .message-button');
  get('viewport').scrollTop = 300;
  app.table.renderWindow();
  const restored = get('logs').querySelector('tr.event-row[data-id="10"] .message-button')!;
  assert.notEqual(restored, focused);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.focusCalls)), [{ preventScroll: true }]);
  assert.equal(get('viewport').scrollTop, 300);
});

test('Columns exposes additional payload fields and requests their values when selected', () => {
  const { get, receive, messages, app } = viewer();
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service', 'custom.jobId', 'attempt'], fields: ['service', 'custom.jobId', 'attempt']
  });
  const custom = get('fieldList').children.find(row => row.dataset.field === 'custom.jobId')!;
  assert.ok(custom);
  const checkbox = custom.children[0] as Element & { checked: boolean; };
  assert.equal(checkbox.checked, false);
  checkbox.checked = true; checkbox.listeners.get('change')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.columns)), ['custom.jobId']);
  assert.equal(app.table.currentColumns.includes("custom.jobId"), true);
  const updated = get('fieldList').children.find(row => row.dataset.field === 'custom.jobId')!.children[0] as Element & { checked: boolean; };
  assert.equal(updated.checked, true);
  updated.checked = false; updated.listeners.get('change')!();
  assert.equal(app.table.currentColumns.includes("custom.jobId"), false);
});

test('an update received during a snapshot queues another request without hiding the current rows', () => {
  const { receive, messages, app } = viewer();
  app.bridge.request();
  const count = messages.length;
  receive({ type: 'update' });
  assert.equal(messages.length, count, 'only one snapshot is in flight');
  receive({
    type: 'snapshot', generation: 1, newest: 101, total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: [], events: [{ id: 101, level: 'error', message: 'latest' }], page: 0, pages: 1, matched: 1
  });
  assert.equal(app.table.events[0].id, 101);
  assert.equal(messages.length, count + 1);
  assert.equal(messages.at(-1)?.type, 'snapshot');
});

test('unchanged snapshot controls preserve their DOM and update when metadata changes', () => {
  const { get, app } = viewer();
  const render = () => (() => {
    app.search.renderSearchState({ saved: [{ id: 'saved', name: 'Errors', query: 'error', createdAt: 0, lastUsedAt: 0 }] });
    app.search.populateFacetFields(['custom']);
    app.state.columnFields = ['custom'];
    app.table.renderFieldList();
  })();
  render();
  const search = get('savedSearchList').firstChild;
  const facet = get('facetField').firstChild;
  const field = get('fieldList').firstChild;
  get('facetField').value = 'custom';
  render();
  assert.equal(get('savedSearchList').firstChild, search);
  assert.equal(get('facetField').firstChild, facet);
  assert.equal(get('facetField').value, 'custom');
  assert.equal(get('fieldList').firstChild, field);
  (() => {
    app.search.renderSearchState({ saved: [] });
    app.search.populateFacetFields(['next']);
    app.state.columnFields = ['next'];
    app.table.renderFieldList();
  })();
  assert.notEqual(get('savedSearchList').firstChild, search);
  assert.notEqual(get('facetField').firstChild, facet);
  assert.notEqual(get('fieldList').firstChild, field);
  const unchecked = get('fieldList').firstChild;
  app.table.updateColumns(['next'], true);
  assert.notEqual(get('fieldList').firstChild, unchecked);
  assert.equal((get('fieldList').firstChild.firstChild as Element & { checked: boolean; }).checked, true);
});


test('disposing a viewer removes host listeners and cancels queued rendering', () => {
  const { app, get, receive, flushFrames } = viewer();
  app.table.scheduleRenderWindow(true);
  const scroll = get('viewport').scrollTop;
  app.dispose();
  flushFrames();
  assert.equal(get('viewport').scrollTop, scroll);
  assert.throws(() => receive({ type: 'update' }), /is not a function/);
});

test('the packaged browser entry starts and renders without a module loader', () => {
  const { app, runtime, get, messages, receive } = viewer();
  app.dispose(); messages.length = 0;
  runInContext(readFileSync(path.join(__dirname, '../media/viewer.js'), 'utf8'), runtime);
  assert.equal(messages[0]?.type, 'snapshot');
  receive({ type: 'snapshot', generation: 1, newest: 7, status: 'Running', command: 'smoke', running: true,
    total: 1, retained: 1, discarded: 0, bytes: 100, maxBytes: 1000, truncated: 0,
    columns: [], events: [{ id: 7, level: 'info', message: 'Packaged viewer ready' }], page: 0, pages: 1, matched: 1 });
  assert.equal(get('status').textContent, 'Running');
  assert.equal(get('logs').querySelector('.message-button')?.textContent, 'Packaged viewer ready');
});
