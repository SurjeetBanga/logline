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
  handlers = new Map<string, Set<(event?: any) => void>>();
  dataset: Record<string, unknown> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  value = '';
  open = false;
  hidden = false;
  disabled = false;
  tabIndex = -1;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 300;
  clientWidth = 1000;
  parent?: Element;
  height = 30;
  width = 140;
  focusCalls: unknown[] = [];
  scrollIntoViewCalls: unknown[] = [];
  onFocus?: (options?: { preventScroll?: boolean; }) => void;
  get firstChild() { return this.children[0]; }
  get classList() { return { contains: (name: string) => this.className.split(' ').includes(name) }; }
  append(...children: Element[]) { for (const child of children) child.parent = this; this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  addEventListener(name: string, callback: (event?: any) => void, options?: AddEventListenerOptions) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(callback);
    this.listeners.set(name, event => { for (const handler of [...this.handlers.get(name) ?? []]) handler(event); });
    if (options?.signal) setMaxListeners(0, options.signal);
    options?.signal?.addEventListener('abort', () => this.removeEventListener(name, callback), { once: true });
  }
  removeEventListener(name: string, callback: (event?: any) => void) {
    this.handlers.get(name)?.delete(callback);
    if (!this.handlers.get(name)?.size) this.listeners.delete(name);
  }
  removeAttribute(name: string) { delete this.attributes[name]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; if (name === 'class') this.className = value; }
  contains(element: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
  closest(selector: string): Element | undefined {
    if (selector === 'tr' || selector === 'tr.event-row') return this.classList.contains('event-row') ? this : selector === 'tr' && this.classList.contains('detail-row') ? this : this.parent?.closest(selector);
    if (selector === 'td[data-column]') return this.dataset.column ? this : this.parent?.closest(selector);
    return this;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
      ...(selector === 'td[data-column]' && child.dataset.column ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string): Element | undefined {
    const row = selector.match(/^tr.event-row\[data-id="(\d+)"\] .message-button$/);
    if (row) return this.querySelectorAll('.event-row').find(element => String(element.dataset.id) === row[1])?.querySelector('.message-button');
    return this.querySelectorAll(selector)[0];
  }
  getBoundingClientRect() { return { height: this.height, width: this.width, top: 0, left: 0, bottom: this.height, right: this.width }; }
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
  const makeElement = () => { const element = new Element(); element.onFocus = () => { document.activeElement = element; }; return element; };
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id)!; };
  const messages: Record<string, any>[] = [];
  const savedStates: Record<string, any>[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const window = Object.assign(new Element(), { innerWidth: 1000, innerHeight: 600 });
  const document = Object.assign(new Element(), {
    activeElement: undefined as Element | undefined, getElementById: get, querySelector: () => get('viewport'),
    createElement: makeElement, createElementNS: makeElement, createTextNode: makeElement, createDocumentFragment: makeElement
  });
  get('cellFilterMenu').append(get('cellFilterLabel'), get('cellFilterInclude'), get('cellFilterExclude'), get('cellFilterReason'));
  const runtime = createContext({
    document, window, Intl, console, AbortController, cancelAnimationFrame() { }, clearInterval() { }, module: { exports: {} },
    acquireVsCodeApi: () => ({
      getState: () => ({ query: 'timeout', levels: ['error'], server: 'api' }), setState: (state: Record<string, any>) => savedStates.push(state),
      postMessage: (message: Record<string, any>) => messages.push(message)
    }),
    ResizeObserver: class { observe() { } disconnect() { } }, requestAnimationFrame: (callback: () => void) => frames.push(callback), setInterval() { }, setTimeout(callback: () => void) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id: number) { timers.delete(id); }
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
  return { get, messages, savedStates, timers, app, runtime, dom: document, renderDetails, receive, flushFrames };
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

test('plain startup output does not lock out columns from later structured logs', () => {
  const { app, receive } = viewer();
  receive({ type: 'snapshot', generation: 1, newest: 101, status: 'Running', running: true,
    total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 101, level: 'info', message: 'request', fields: { service: 'api' } }],
    columns: ['service'], columnFields: ['service'], page: 0, pages: 1, matched: 1 });
  assert.deepEqual([...app.table.currentColumns], ['service']);
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
  const messageHeader = get('head-row').children.find(header => header.dataset.column === 'base:message')!;
  messageHeader.querySelector('.resize-handle')!.listeners.get('pointerdown')!({ clientX: 100, button: 0 });
  dom.listeners.get('pointermove')!({ clientX: 140 });
  dom.listeners.get('pointerup')!();
  assert.equal(get('eventsTable').style.width, '1000px', 'a narrowed message column must not leave empty right-edge space');
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

test('toolbar popovers escape the horizontal search scroller', () => {
  const { get } = viewer();
  get('levelMenu').className = 'level-menu';
  get('levelMenu').hidden = true;
  get('levelButton').listeners.get('click')!({ stopPropagation() { } });
  assert.equal(get('levelMenu').hidden, false);
  assert.equal(get('levelMenu').style.position, 'fixed');

  get('searchToolsPanel').className = 'saved-searches';
  get('searchToolsPanel').hidden = true;
  get('searchTools').listeners.get('click')!({ stopPropagation() { } });
  assert.equal(get('searchToolsPanel').hidden, false);
  assert.equal(get('searchToolsPanel').style.position, 'fixed');
});

test('saved searches refresh Copy results visibility', () => {
  const { get, receive } = viewer();
  assert.equal(get('copyResults').hidden, false, 'the initial timeout filter exposes Copy results');

  receive({ type: 'searches', searches: { saved: [{ id: 'all', name: 'Everything', query: '' }] } });
  get('savedSearchList').children[0].querySelector('.search-item')!.listeners.get('click')!();
  assert.equal(get('copyResults').hidden, true);

  receive({ type: 'searches', searches: { saved: [{ id: 'errors', name: 'Errors', query: 'failure', levels: ['error'] }] } });
  get('savedSearchList').children[0].querySelector('.search-item')!.listeners.get('click')!();
  assert.equal(get('copyResults').hidden, false);
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

test('autocomplete suggestions list known field names alongside matching values', () => {
  const { get, receive } = viewer();
  receive({ type: 'autocomplete', input: 'timeout', serverId: 'api', fields: ['service', 'status'], values: [{ value: 'api', count: 4 }] });
  assert.deepEqual(get('fieldSuggestions').children.map(option => option.value), ['service:', 'status:']);
  assert.equal(get('search').attributes.list, 'fieldSuggestions');
});

test('Clear removes stale autocomplete suggestions', () => {
  const { get, receive } = viewer();
  receive({ type: 'autocomplete', input: 'timeout', serverId: 'api', fields: ['service'], values: [{ value: 'api', count: 4 }] });

  get('clear').listeners.get('click')!();

  assert.equal(get('fieldSuggestions').children.length, 0);
});

test('clearing Search logs removes column suggestions and ignores an in-flight autocomplete response', () => {
  const { get, receive } = viewer();
  receive({ type: 'autocomplete', input: 'timeout', serverId: 'api', fields: ['service'], values: [{ value: 'api', count: 4 }] });
  assert.equal(get('fieldSuggestions').children.length, 1);

  get('search').value = '';
  get('search').listeners.get('input')!();
  receive({ type: 'autocomplete', input: 'timeout', serverId: 'api', fields: ['service'], values: [{ value: 'api', count: 4 }] });

  assert.equal(get('fieldSuggestions').children.length, 0);
});

test('new autocomplete suggestions restore the search datalist after it was cleared', () => {
  const { get, receive } = viewer();
  get('search').removeAttribute('list');

  receive({ type: 'autocomplete', input: 'timeout', serverId: 'api', fields: ['service'], values: [] });

  assert.equal(get('search').attributes.list, 'fieldSuggestions');
});

test('search drafts become removable include and exclude chips when applied', () => {
  const { get, app, messages } = viewer();
  get('searchClear').listeners.get('click')!({ stopPropagation() { } });
  const snapshots = () => messages.filter(message => message.type === 'snapshot');
  const before = snapshots().length;
  get('search').value = 'service:api';
  get('search').listeners.get('input')!();
  assert.equal(snapshots().length, before, 'typing keeps the current filter until Enter');
  get('search').listeners.get('keydown')!({ key: 'Enter', preventDefault() { } });
  assert.equal(app.search.query(), 'service:api');
  assert.equal(get('searchChips').children.length, 1);
  const chip = get('searchChips').children[0];
  assert.equal(chip.className, 'filter-chip');
  chip.children[1].listeners.get('click')!({ stopPropagation() { } });
  assert.equal(app.search.query(), '');
  assert.equal(get('searchChips').children.length, 0);
  get('search').value = 'first';
  get('search').listeners.get('keydown')!({ key: 'Enter', preventDefault() { } });
  get('search').value = 'OR second';
  get('search').listeners.get('keydown')!({ key: 'Enter', preventDefault() { } });
  assert.equal(app.search.query(), 'first OR second');
  get('searchClear').listeners.get('click')!({ stopPropagation() { } });
  get('search').value = '-status:500';
  get('search').listeners.get('keydown')!({ key: 'Enter', preventDefault() { } });
  assert.equal(app.search.query(), '-status:500');
  assert.match(get('searchChips').children[0].className, /exclude/);
});

test('clicking a chip edits its value inline', () => {
  const { get, app } = viewer();
  get('searchClear').listeners.get('click')!({ stopPropagation() { } });
  get('search').value = 'service:api';
  get('search').listeners.get('keydown')!({ key: 'Enter', preventDefault() { } });
  get('searchChips').children[0].children[0].listeners.get('click')!({ stopPropagation() { } });
  const editor = get('searchChips').children[0].children[0];
  assert.equal(editor.className, 'filter-chip-input');
  assert.equal(editor.value, 'service:api');
  editor.value = 'service:web';
  editor.listeners.get('keydown')!({ key: 'Enter', preventDefault() { } });
  assert.equal(app.search.query(), 'service:web');
});

test('Copy results appears for an active filter and requests the filtered rows', () => {
  const { get, messages } = viewer();
  assert.equal(get('copyResults').hidden, false);
  get('copyResults').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: 'copyFiltered', query: 'timeout', levels: ['error'], serverId: 'api'
  });
  assert.equal(get('copyResults').textContent, 'Copied');
});

test('right-clicking a table value offers an additional field-value filter', () => {
  const { get, messages } = viewer();
  const row = get('logs').querySelectorAll('.event-row').find(row => String(row.dataset.id) === '42')!;
  const levelCell = row.children.find(cell => cell.dataset.column === 'base:level')!;
  let prevented = false;
  get('logs').listeners.get('contextmenu')!({ target: levelCell, clientX: 20, clientY: 20, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(get('cellFilterMenu').hidden, false);
  assert.equal(get('cellFilterLabel').textContent, 'level: "error"');
  get('cellFilterInclude').listeners.get('click')!();
  assert.equal(get('search').value, 'timeout level:"error"');
  assert.equal(messages.at(-1)?.type, 'snapshot');
  assert.equal(messages.at(-1)?.query, 'timeout level:"error"');
});

test('Exclude saves the narrowed query and preserves scope while leaving inspection', () => {
  const { get, app, messages, savedStates, timers, receive } = viewer();
  get('search').value = 'service:api OR service:worker';
  get('search').listeners.get('input')!();
  assert.equal(timers.size, 2);
  app.table.toggleExpand(42);
  app.state.page = 1;
  const row = get('logs').querySelectorAll('.event-row')[0];
  const cell = row.children.find(cell => cell.dataset.column === 'base:level')!;
  get('logs').listeners.get('contextmenu')!({ target: cell, clientX: 20, clientY: 20, preventDefault() {} });
  get('cellFilterExclude').listeners.get('click')!();
  const expected = 'service:api -level:"error" OR service:worker -level:"error"';
  assert.equal(get('search').value, expected);
  assert.equal(savedStates.at(-1)?.query, expected);
  assert.equal(messages.at(-1)?.query, expected);
  assert.equal(messages.at(-1)?.serverId, 'api');
  assert.deepEqual([...messages.at(-1)?.levels], ['error']);
  assert.equal(app.state.page, 0);
  assert.equal(app.state.following, false);
  assert.equal(app.state.paused, false);
  assert.equal(app.state.selected, undefined);
  assert.equal(get('cellFilterMenu').hidden, true);
  assert.equal(timers.size, 0);
  assert.equal(get('fieldSuggestions').children.length, 0);
  receive({ type: 'autocomplete', input: 'service:api OR service:worker', serverId: 'api', fields: ['service'], values: [] });
  assert.equal(get('fieldSuggestions').children.length, 0);
});

test('cell menu explains disabled actions and revalidates against the current search', () => {
  const { get, app, messages } = viewer();
  app.table.updateColumns(['bad-key', 'empty']);
  app.table.renderRows([{ id: 43, level: 'info', fields: { 'bad-key': 'x', empty: '' } }]);
  const open = (column: string) => {
    const cell = get('logs').querySelectorAll('.event-row')[0].children.find(cell => cell.dataset.column === column)!;
    get('logs').listeners.get('contextmenu')!({ target: cell, clientX: 20, clientY: 20, preventDefault() {} });
  };
  for (const column of ['field:bad-key', 'field:empty', 'base:message']) {
    open(column);
    assert.equal(get('cellFilterInclude').disabled, true);
    assert.equal(get('cellFilterExclude').disabled, true);
    assert.match(get('cellFilterReason').textContent, column === 'field:bad-key' ? /field name/ : /no value/);
  }
  open('base:level');
  assert.equal(get('cellFilterInclude').disabled, false);
  get('search').value = 'x'.repeat(256);
  const count = messages.length;
  get('cellFilterInclude').listeners.get('click')!();
  assert.equal(messages.length, count);
  assert.equal(get('search').value, 'x'.repeat(256));
  assert.match(get('cellFilterReason').textContent, /256-character/);
  assert.equal(get('cellFilterInclude').disabled, true);
});

test('cell menu fits viewport edges and dismisses on outside click, scroll and row replacement', () => {
  const { get, app, dom, runtime } = viewer();
  runtime.window.innerWidth = 220;
  runtime.window.innerHeight = 150;
  get('cellFilterMenu').width = 180;
  get('cellFilterMenu').height = 120;
  const open = () => {
    const cell = get('logs').querySelectorAll('.event-row')[0].children[1];
    get('logs').listeners.get('contextmenu')!({ target: cell, clientX: 215, clientY: 145, preventDefault() {} });
  };
  open();
  assert.equal(get('cellFilterMenu').style.left, '32px');
  assert.equal(get('cellFilterMenu').style.top, '22px');
  dom.listeners.get('click')!({ target: get('search') });
  assert.equal(get('cellFilterMenu').hidden, true);
  open();
  dom.listeners.get('scroll')!({ target: get('viewport') });
  assert.equal(get('cellFilterMenu').hidden, true);
  open();
  app.table.renderRows([{ id: 99, level: 'info' }]);
  assert.equal(get('cellFilterMenu').hidden, true);
  assert.equal(dom.activeElement, get('logs').querySelectorAll('.event-row')[0].children[0]);
});

test('roving table focus opens keyboard actions, navigates them and restores focus on Escape', () => {
  const { get, app, dom } = viewer();
  app.table.renderRows([{ id: 42, level: 'error', message: 'timeout' }, { id: 43, level: 'info' }]);
  const rows = get('logs').querySelectorAll('.event-row');
  const all = rows.flatMap(row => row.children);
  assert.equal(all.filter(cell => cell.tabIndex === 0).length, 1);
  assert.equal(rows[0].children[0].tabIndex, 0);
  const key = (target: Element, key: string, shiftKey = false) => {
    get('logs').listeners.get('keydown')!({ target, key, shiftKey, preventDefault() {} });
  };
  rows[0].children[0].focus();
  key(rows[0].children[0], 'ArrowRight');
  assert.equal(dom.activeElement, rows[0].children[1]);
  key(rows[0].children[1], 'ArrowDown');
  assert.equal(dom.activeElement, rows[1].children[1]);
  key(rows[1].children[1], 'ArrowUp');
  assert.equal(dom.activeElement, rows[0].children[1]);
  key(rows[0].children[1], 'F10', true);
  assert.equal(dom.activeElement, get('cellFilterInclude'));
  get('cellFilterMenu').listeners.get('keydown')!({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(dom.activeElement, get('cellFilterExclude'));
  dom.listeners.get('keydown')!({ key: 'Escape', preventDefault() {} });
  assert.equal(get('cellFilterMenu').hidden, true);
  assert.equal(dom.activeElement, rows[0].children[1]);
  assert.equal(all.filter(cell => cell.tabIndex === 0).length, 1);
  key(rows[0].children[1], 'F10', true);
  get('cellFilterMenu').listeners.get('keydown')!({ key: 'ArrowDown', preventDefault() {} });
  get('cellFilterMenu').listeners.get('keydown')!({ key: 'Enter', preventDefault() {} });
  assert.equal(get('search').value, 'timeout -level:"error"');
});

test('a refreshed table restores the focused cell and keeps one tab stop', () => {
  const { get, app, dom } = viewer();
  const row = get('logs').querySelectorAll('.event-row')[0];
  const cell = row.children[1];
  cell.focus();
  get('logs').listeners.get('focusin')!({ target: cell });
  app.table.renderRows(app.table.events);
  const newCells = get('logs').querySelectorAll('.event-row').flatMap(row => row.children);
  assert.equal(dom.activeElement, newCells[1]);
  assert.equal(newCells.filter(cell => cell.tabIndex === 0).length, 1);
  assert.equal(newCells[1].tabIndex, 0);
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

test('opening a live row freezes its result set while a snapshot is in flight', () => {
  const { app, receive } = viewer();
  app.table.toggleExpand(42);
  receive({
    type: 'snapshot', generation: 1, newest: 101, total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: [], events: [{ id: 101, level: 'info', message: 'new line' }], page: 0, pages: 1, matched: 101
  });
  assert.equal(app.state.selected, 42);
  assert.equal(app.table.events[0].id, 42, 'the selected row remains available until Live is resumed');
});

test('explicit paging, filtering, sorting and column selection leave inspection in Browse', () => {
  for (const action of ['page', 'filter', 'sort', 'columns']) {
    const { app, get, receive, messages } = viewer();
    app.table.toggleExpand(42);
    if (action === 'page') get('older').listeners.get('click')!();
    if (action === 'filter') get('levelMenu').children[0].children[0].listeners.get('click')!({ stopPropagation() {} });
    if (action === 'sort') get('head-row').children[0].querySelector('.column-sort')!.listeners.get('click')!();
    if (action === 'columns') get('fieldsAll').listeners.get('click')!();
    const request = messages.at(-1)!;
    assert.equal(request.type, 'snapshot', action);
    assert.equal(request.statsOnly, false, action);
    assert.equal(request.before, 100, action);
    assert.equal(app.state.paused, false, action);
    assert.equal(app.state.following, false, action);
    assert.equal(app.state.selected, undefined, action);
    receive({ type: 'snapshot', generation: 1, newest: 110, status: 'Running', running: true,
      total: 110, retained: 110, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
      events: [{ id: 43, level: 'info', message: 'new result' }], columns: [], page: 0, pages: 1, matched: 1 });
    assert.equal(app.table.events[0].id, 43, action);
  }
});

test('autocomplete ignores changed input or server and inserts a complete query', () => {
  const { get, app, receive } = viewer();
  get('search').value = 'level:error service:a';
  const response = { type: 'autocomplete', input: 'level:error service:a', serverId: 'api', fields: ['service'], values: [{ value: 'API west', count: 1 }] };
  receive(response);
  assert.equal(get('fieldSuggestions').children[0].value, 'level:error service:"API west"');
  assert.equal(get('fieldSuggestions').children[0].attributes.label, 'level:error service:a');
  get('search').value = 'level:error service:b';
  get('search').listeners.get('input')!();
  receive(response);
  assert.equal(get('fieldSuggestions').children.length, 0);
  get('search').value = response.input; app.state.selectedServer = 'worker';
  receive(response);
  assert.equal(get('fieldSuggestions').children.length, 0);
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

test('checking a column keeps its position in the Columns picker', () => {
  const { get, receive } = viewer();
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service', 'custom.jobId', 'attempt'], fields: ['service', 'custom.jobId', 'attempt']
  });
  const fields = () => get('fieldList').children.map(row => row.dataset.field);
  assert.deepEqual(JSON.parse(JSON.stringify(fields())), ['service', 'custom.jobId', 'attempt']);

  const attempt = get('fieldList').children.find(row => row.dataset.field === 'attempt')!;
  const checkbox = attempt.children[0] as Element & { checked: boolean; };
  checkbox.checked = true; checkbox.listeners.get('change')!();

  assert.deepEqual(JSON.parse(JSON.stringify(fields())), ['service', 'custom.jobId', 'attempt']);
});

test('Columns All and None apply to every field offered by the picker', () => {
  const { get, app, receive } = viewer();
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service', 'custom.jobId', 'attempt'], fields: ['service', 'custom.jobId', 'attempt']
  });
  get('fieldsAll').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(app.table.currentColumns)), ['service', 'custom.jobId', 'attempt']);
  get('fieldsNone').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(app.table.currentColumns)), []);
});

test('Clear immediately removes payload fields from the Columns picker', () => {
  const { get, receive } = viewer();
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service', 'custom.jobId'], fields: ['service', 'custom.jobId']
  });
  assert.equal(get('fieldList').children.length, 2);

  get('clear').listeners.get('click')!();

  assert.equal(get('fieldList').children.some(row => row.dataset.field), false);
});

test('Clear ignores an in-flight pre-clear snapshot so it cannot restore Columns fields', () => {
  const { app, get, messages, receive } = viewer();
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service'], fields: ['service']
  });
  app.bridge.request();
  get('clear').listeners.get('click')!();

  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service'], fields: ['service']
  });

  assert.equal(get('fieldList').children.some(row => row.dataset.field), false);
  assert.equal(messages.at(-1)?.type, 'snapshot', 'the queued post-clear snapshot is requested');

  receive({
    type: 'snapshot', generation: 2, newest: 100, total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000,
    columns: [], columnFields: [], fields: []
  });
  assert.equal(get('fieldList').children.some(row => row.dataset.field), false);
});

test('automatic columns settle after the first useful schema while later fields remain opt-in', () => {
  const { app, get } = viewer();
  app.state.columnFields = ['service', 'status'];
  app.table.resetAutomaticColumns();
  app.table.updateColumns(['service'], true);
  app.table.lockAutomaticColumns();
  app.table.updateColumns(['service', 'status'], true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.table.currentColumns)), ['service']);
  assert.ok(get('fieldList').children.some(row => row.dataset.field === 'status'));
});

test('an empty snapshot does not lock automatic columns before structured logs arrive', () => {
  const { app, receive } = viewer();
  app.table.resetAutomaticColumns();
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: [], columnFields: [], fields: [], events: [], page: 0, pages: 1, matched: 0
  });
  receive({
    type: 'snapshot', generation: 1, newest: 101, total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000,
    columns: ['service'], columnFields: ['service'], fields: ['service'],
    events: [{ id: 101, level: 'info', message: 'ready', fields: { service: 'api' } }], page: 0, pages: 1, matched: 1
  });
  assert.deepEqual(JSON.parse(JSON.stringify(app.table.currentColumns)), ['service']);
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
    app.state.columnFields = ['custom'];
    app.table.renderFieldList();
  })();
  render();
  const search = get('savedSearchList').firstChild;
  const field = get('fieldList').firstChild;
  render();
  assert.equal(get('savedSearchList').firstChild, search);
  assert.equal(get('fieldList').firstChild, field);
  (() => {
    app.search.renderSearchState({ saved: [] });
    app.state.columnFields = ['next'];
    app.table.renderFieldList();
  })();
  assert.notEqual(get('savedSearchList').firstChild, search);
  assert.notEqual(get('fieldList').firstChild, field);
  const unchecked = get('fieldList').firstChild;
  app.table.resetAutomaticColumns();
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

test('Help opens What’s new for unread highlights and the guide after acknowledgement', () => {
  const { get, receive, messages } = viewer();
  receive({ type: 'guideStatus', version: '1.7.0', unread: true });
  get('help').listeners.get('click')!();
  assert.equal(messages.at(-1)?.type, 'showGuide');
  assert.equal(messages.at(-1)?.section, 'whatsNew');
  receive({ type: 'guideStatus', version: '1.7.0', unread: false });
  get('help').listeners.get('click')!();
  assert.equal(messages.at(-1)?.type, 'showGuide');
  assert.equal(messages.at(-1)?.section, 'guide');
});
