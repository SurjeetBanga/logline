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
  title = '';
  value = '';
  open = false;
  checked = false;
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
  get classList() {
    const names = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (name: string) => names().includes(name),
      add: (name: string) => { if (!names().includes(name)) this.className = [...names(), name].join(' '); },
      remove: (name: string) => { this.className = names().filter(item => item !== name).join(' '); }
    };
  }
  append(...children: Element[]) { for (const child of children) child.parent = this; this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  get parentNode() { return this.parent; }
  get nextSibling() { const siblings = this.parent?.children ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
  removeChild(child: Element) { this.children = this.children.filter(item => item !== child); if (child.parent === this) child.parent = undefined; return child; }
  insertBefore(child: Element, reference: Element | null) {
    this.children = this.children.filter(item => item !== child);
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parent = this;
    return child;
  }
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
  cloneNode(): Element {
    const copy = new Element();
    Object.assign(copy, { className: this.className, textContent: this.textContent, attributes: { ...this.attributes }, dataset: { ...this.dataset } });
    copy.append(...this.children.map(child => child.cloneNode()));
    return copy;
  }
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

test('an invalid saved search leaves the current filters untouched', () => {
  const { app, get, receive } = viewer();
  const before = { query: app.search.query(), server: app.state.selectedServer, levels: [...app.state.checkedLevels] };
  receive({ type: 'searches', searches: { saved: [{ id: 's1', name: 'Bad', query: 'message:/error/v', levels: ['warn'], serverId: 'worker' }] } });
  get('savedSearchList').children[0].querySelector('.search-item')!.listeners.get('click')!();
  assert.equal(app.search.query(), before.query);
  assert.equal(app.state.selectedServer, before.server);
  assert.deepEqual([...app.state.checkedLevels], before.levels);
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

test('More actions supports keyboard navigation and restores focus on dismissal', () => {
  const { get, dom } = viewer();
  get('actionsMenu').hidden = true;
  get('actionsMenu').className = 'actions-menu';
  get('moreActions').listeners.get('click')!({ stopPropagation() { } });
  assert.equal(get('actionsMenu').hidden, false);
  assert.equal(get('actionsMenu').style.position, 'fixed');
  assert.equal(dom.activeElement, get('shareSpecificRuns'));
  const key = (value: string) => get('actionsMenu').listeners.get('keydown')!({ key: value, preventDefault() { } });
  key('ArrowUp');
  assert.equal(dom.activeElement, get('help'));
  key('ArrowDown');
  assert.equal(dom.activeElement, get('shareSpecificRuns'));
  key('End');
  assert.equal(dom.activeElement, get('help'));
  key('Home');
  assert.equal(dom.activeElement, get('shareSpecificRuns'));
  key('ArrowDown');
  assert.equal(dom.activeElement, get('connectAgent'));
  key('Tab');
  assert.equal(get('actionsMenu').hidden, true);
  assert.equal(dom.activeElement, get('moreActions'));
  get('moreActions').listeners.get('keydown')!({ key: 'ArrowUp', preventDefault() { } });
  assert.equal(dom.activeElement, get('help'));
  dom.listeners.get('keydown')!({ key: 'Escape' });
  assert.equal(get('actionsMenu').hidden, true);
  assert.equal(dom.activeElement, get('moreActions'));
});

test('More actions preserves commands and closes after selection or an outside click', () => {
  const { get, dom, messages } = viewer();
  for (const [id, type] of [['export', 'export'], ['import', 'import'], ['manage', 'manageServers'], ['config', 'config'], ['help', 'showGuide']]) {
    get('actionsMenu').hidden = true;
    get('moreActions').listeners.get('click')!({ stopPropagation() { } });
    get(id).listeners.get('click')!();
    assert.equal(messages.at(-1)?.type, type);
    assert.equal(get('actionsMenu').hidden, true);
    assert.equal(get('moreActions').attributes['aria-expanded'], 'false');
    assert.equal(dom.activeElement, get('moreActions'));
  }
  get('moreActions').listeners.get('click')!({ stopPropagation() { } });
  dom.listeners.get('click')!({ target: get('search') });
  assert.equal(get('actionsMenu').hidden, true);
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

test('analysis renders patterns, error groups and anomalies with trends', () => {
  const { get, receive } = viewer();
  receive({
    type: 'analysis', analysis: {
      rate: [{ bucket: 0, count: 1, anomalous: false }, { bucket: 1, count: 40, anomalous: true }],
      errors: [{ bucket: 0, count: 0, anomalous: false }],
      latency: [{ bucket: 0, average: 10, p95: 12, count: 1, anomalous: false }],
      statusCodes: [],
      patterns: [{ key: 'user <n> logged in', message: 'user 1 logged in', pattern: 'user * logged in', level: 'info', count: 3, sampleIds: [1], trend: [1, 2], isNew: true, query: 'message:"user" message:"logged in"' }],
      errorGroups: [{ key: 'paymenterror@/work/billing.ts:55', message: 'Failed to charge card', count: 2, sampleIds: [1], location: '/work/billing.ts:55', trend: [0, 2] }],
      range: {}, summary: { events: 41, errors: 2, sources: 1, outside: 0, latency: { p50: 10, p95: 12, p99: 12, count: 1 } }
    }
  });
  const content = get('analysisContent');
  assert.deepEqual(content.querySelectorAll('.tile-value').map(tile => tile.textContent), ['41', '2', '12 ms']);
  const texts = content.querySelectorAll('.group-text').map(text => text.textContent);
  assert.deepEqual(texts, ['Failed to charge card', 'user * logged in']);
  assert.match(content.querySelectorAll('.group-detail')[0].textContent, /\/work\/billing\.ts:55/);
  assert.equal(content.querySelectorAll('.new-pattern').length, 1);
  assert.equal(content.querySelectorAll('.sparkline-bar').length, 4);
  assert.equal(content.querySelectorAll('.anomalous').length, 1);
  assert.equal(content.querySelectorAll('.anomaly-marker').length, 1);
});

test('analysis rows, values and bars narrow the search to their logs', () => {
  const { get, receive, app } = viewer();
  const from = Date.parse('2026-10-04T12:00:00Z');
  const analyze = () => {
    get('analysisDialog').open = true;
    receive({
      type: 'analysis', analysis: {
        rate: [{ bucket: 0, count: 5, anomalous: false }, { bucket: 1, count: 0, anomalous: false }], errors: [], latency: [],
        statusCodes: [{ code: '200', count: 8 }, { code: '500', count: 2 }],
        patterns: [{ key: 'k', message: 'cache miss 1', pattern: 'cache miss *', level: 'info', count: 2, sampleIds: [], trend: [], query: 'message:"cache miss"' }], errorGroups: [],
        topValues: [{ field: 'serverId', label: 'Source', total: 10, values: [{ value: 'worker', label: 'Worker', count: 4 }] }],
        range: { from, to: from + 60000 }
      }
    });
  };
  const click = (target: Element) => get('analysisContent').listeners.get('click')!({ target });
  analyze();
  const rows = get('analysisContent').querySelectorAll('.bar-row');
  assert.deepEqual(rows.map(row => row.querySelector('.bar-label')!.textContent), ['200', '500', 'Worker']);
  click(rows[1]);
  assert.equal(get('search').value, 'timeout status:500', 'added to the current search');
  assert.equal(get('analysisDialog').open, false);
  analyze();
  click(get('analysisContent').querySelectorAll('.volume-bar')[0]);
  assert.equal(get('search').value, 'timeout status:500 timestamp:[2026-10-04T12:00:00.000Z TO 2026-10-04T12:00:30.000Z]');
  assert.equal(get('analysisContent').querySelectorAll('.volume-bar')[1].dataset.term, undefined, 'an empty bar has nothing to show');
  analyze();
  click(get('analysisContent').querySelectorAll('.group-row')[0]);
  assert.match(get('search').value, / message:"cache miss"$/);
  analyze();
  click(get('analysisContent').querySelectorAll('.bar-row')[2]);
  assert.equal(app.state.selectedServer, 'worker', 'a source is selected exactly, not searched by substring');
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
  app.state.newestFirst = false; // terminal order: these rows are laid out oldest first
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

test('newest first: Live stays at the top, scrolling down holds rows still, and the top resumes Live', () => {
  const { get, app, messages } = viewer();
  const rows = (last: number) => Array.from({ length: last }, (_, i) => ({ id: i + 1, level: 'info', message: 'line ' + i }));
  const ids = () => get('logs').querySelectorAll('.event-row').map(row => Number(row.dataset.id));
  const scroll = (top: number) => { get('viewport').scrollTop = top; get('viewport').listeners.get('scroll')!(); };
  app.table.renderRows(rows(100));
  assert.equal(ids()[0], 100);
  app.table.renderRows(rows(105));
  assert.equal(ids()[0], 105, 'new rows appear on top');
  assert.equal(get('viewport').scrollTop, 0);
  scroll(300);
  assert.equal(app.state.following, false, 'reading older rows leaves Live');
  assert.match(get('mode').textContent, /^Browsing/);
  // Row 95 is at the top of the viewport; five newer rows above must not move it.
  app.table.renderRows(rows(110));
  assert.equal(get('viewport').scrollTop, 450);
  scroll(0);
  assert.equal(app.state.following, true, 'the top resumes Live');
  assert.equal(messages.at(-1)?.type, 'snapshot');
  assert.equal(messages.at(-1)?.before, undefined);
});

test('a partial refresh merges new rows with the held ones, reuses their DOM, and falls back to a full page', () => {
  const { get, messages, receive } = viewer();
  const row = (id: number) => ({ id, message: 'line ' + id, level: 'info', timestamp: '12:00', stream: 'stdout' });
  const ids = () => get('logs').querySelectorAll('.event-row').map(item => Number(item.dataset.id));
  const respond = (extra: Record<string, unknown>) => receive({
    type: 'snapshot', requestId: messages.at(-1)!.requestId, generation: 1, newest: 10, status: 'Running', command: 'node server', running: true,
    total: 10, retained: 10, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0, columns: [], page: 0, pages: 1, matched: 3, ...extra
  });
  receive({ type: 'update' });
  assert.equal(messages.at(-1)!.have, undefined);
  respond({ events: [row(1), row(2), row(3)], rowsVersion: 'v1' });
  assert.deepEqual(ids(), [3, 2, 1]);
  const kept = get('logs').querySelectorAll('.event-row').slice(0, 2);
  receive({ type: 'update' });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)!.have)), { last: 3, count: 3, version: 'v1' });
  respond({ events: [row(4)], keep: 2, keepFirst: 2, rowsVersion: 'v1' });
  assert.deepEqual(ids(), [4, 3, 2]);
  assert.deepEqual(get('logs').querySelectorAll('.event-row').slice(1), kept, 'held rows keep their DOM');
  receive({ type: 'update' });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)!.have)), { last: 4, count: 3, version: 'v1' });
  const sent = messages.length;
  respond({ events: [row(6)], keep: 3, keepFirst: 99, rowsVersion: 'v1' });
  assert.deepEqual(ids(), [4, 3, 2], 'rows that cannot be placed are not shown');
  assert.equal(messages.length, sent + 1);
  assert.equal(messages.at(-1)!.have, undefined, 'the follow-up asks for the whole page');
});

test('in terminal order, Live settles at the new bottom after layout and resumes even when row IDs are unchanged', () => {
  const { get, app, flushFrames } = viewer();
  app.state.newestFirst = false;
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

test('a history reset during inspection is applied once inspection ends', () => {
  const { app, receive } = viewer();
  const snapshot = (generation: number, id: number) => receive({
    type: 'snapshot', generation, newest: id, total: 1, retained: 1, discarded: 0, bytes: 100, maxBytes: 10000,
    columns: [], events: [{ id, level: 'info', message: `line ${id}` }], page: 0, pages: 1, matched: 1
  });
  snapshot(1, 42);
  app.table.toggleExpand(42);
  snapshot(2, 7);
  assert.equal(app.state.selected, 42, 'inspection stays open across the reset');
  assert.equal(app.state.generation, 1, 'the reset is deferred rather than forgotten');
  app.state.resume();
  app.state.page = 3;
  snapshot(2, 7);
  assert.equal(app.state.generation, 2);
  assert.equal(app.state.page, 0, 'the deferred reset clears paging once inspection ends');
});

test('snapshot errors release the bridge and keep the next refresh possible', () => {
  const { app, receive, messages, get } = viewer();
  app.bridge.request();
  const requestId = messages.at(-1)?.requestId;
  assert.equal(app.bridge.pending, true);
  receive({ type: 'snapshotError', requestId, message: 'temporary host failure' });
  assert.equal(app.bridge.pending, false);
  assert.equal(get('status').textContent, 'Snapshot failed: temporary host failure');
  app.bridge.request();
  assert.equal(messages.at(-1)?.type, 'snapshot');
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
  app.state.newestFirst = false; // terminal order: these rows are laid out oldest first
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
  app.state.newestFirst = false; // terminal order: these rows are laid out oldest first
  get('viewport').scrollTop = 0;
  (() => {
    app.state.following = false;
    app.table.renderRows(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, level: "info", message: "line " + i })));
  })();
  const focused = get('logs').querySelector('tr.event-row[data-id="10"] .message-button')!;
  dom.activeElement = get("logs").querySelector('tr.event-row[data-id="10"] .message-button');
  get('viewport').scrollTop = 300;
  app.table.renderWindow();
  // Scrolling keeps rows that stay in the window, so the same button is refocused.
  const kept = get('logs').querySelector('tr.event-row[data-id="10"] .message-button')!;
  assert.equal(kept, focused);
  assert.deepEqual(JSON.parse(JSON.stringify(kept.focusCalls)), [{ preventScroll: true }]);
  assert.equal(get('viewport').scrollTop, 300);
  // A refresh with new row data rebuilds rows; the new button for the same event takes focus.
  dom.activeElement = kept;
  app.table.renderRows(app.table.events.map(event => ({ ...event })));
  const restored = get('logs').querySelector('tr.event-row[data-id="10"] .message-button')!;
  assert.notEqual(restored, focused);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.focusCalls)), [{ preventScroll: true }]);
  assert.equal(get('viewport').scrollTop, 300);
});

test('scrolling builds only the rows entering the window and keeps the others in place', () => {
  const { get, app } = viewer();
  app.state.newestFirst = false; // terminal order: these rows are laid out oldest first
  app.state.following = false;
  get('viewport').scrollTop = 0;
  app.table.renderRows(Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, level: 'info', message: 'line ' + i })));
  const before = new Map(get('logs').querySelectorAll('.event-row').map(row => [row.dataset.id, row]));
  get('viewport').scrollTop = 300;
  app.table.renderWindow();
  const children = get('logs').children;
  const after = get('logs').querySelectorAll('.event-row');
  assert.equal(children[0].className, 'virtual-spacer');
  assert.equal(children.at(-1)!.className, 'virtual-spacer');
  assert.deepEqual(after.map(row => Number(row.dataset.id)), Array.from({ length: after.length }, (_, i) => Number(after[0].dataset.id) + i));
  assert.equal(after.filter(row => before.get(row.dataset.id) !== row).length, 2, 'two rows scrolled into view');
  // A refresh that keeps the same row data keeps the rows; new data rebuilds them.
  const current = get('logs').querySelectorAll('.event-row');
  app.table.renderRows([...app.table.events]);
  assert.deepEqual(get('logs').querySelectorAll('.event-row'), current);
  app.table.renderRows(app.table.events.map(event => ({ ...event })));
  assert.ok(get('logs').querySelectorAll('.event-row').every((row, index) => current[index] !== row));
});

test('keyboard navigation skips a collapsed Source column without measuring cells', () => {
  const { get, app, dom } = viewer();
  get('eventColumns').children.find(col => col.dataset.column === 'base:source')!.style.visibility = 'collapse';
  const measure = Element.prototype.getBoundingClientRect;
  let measured = 0;
  Element.prototype.getBoundingClientRect = function (this: Element) { if (this.dataset.column) measured++; return measure.call(this); };
  try {
    app.table.renderRows([{ id: 1, level: 'info', message: 'first' }, { id: 2, level: 'info', message: 'second' }]);
  } finally { Element.prototype.getBoundingClientRect = measure; }
  assert.equal(measured, 0, 'a refresh does not force layout per cell');
  const cells = get('logs').querySelectorAll('.event-row')[0].children;
  const message = cells.find(cell => cell.dataset.column === 'base:message')!;
  const source = cells.find(cell => cell.dataset.column === 'base:source')!;
  message.focus();
  get('logs').listeners.get('keydown')!({ target: message, key: 'ArrowRight', preventDefault() {} });
  assert.equal(dom.activeElement, message, 'the collapsed Source cell is not a stop');
  assert.equal(source.tabIndex, -1);
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
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1)?.columns)), ['service', 'custom.jobId']);
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

test('stale source and run selections reset when their metadata disappears', () => {
  const { app, messages, receive } = viewer();
  app.state.selectedServer = 'terminal-1';
  app.state.selectedSession = 'run-1';
  app.bridge.pending = false;
  receive({
    type: 'snapshot', generation: 1, newest: 101, total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0,
    servers: [], sessions: [], columns: [], columnFields: [], fields: [], page: 0, pages: 1, matched: 0
  });
  assert.equal(app.state.selectedServer, '');
  assert.equal(app.state.selectedSession, '');
  assert.equal(messages.at(-1)?.type, 'snapshot', 'a follow-up snapshot removes the stale host-side filters');
});

test('the run picker renders one-click stop actions and keeps the menu open', () => {
  const { get, messages, receive, app } = viewer();
  app.state.selectedServer = '';
  get('scopeMenu').hidden = true;
  get('sessionMenu').hidden = true;
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0,
    columns: [], columnFields: [], fields: [], page: 0, pages: 1, matched: 0,
    sessions: [
      { id: 'run-a', serverId: 'api', server: 'API', command: 'npm run api', status: 'running', startedAt: 100, canStop: true },
      { id: 'run-b', serverId: 'api', server: 'API', command: 'npm run worker', status: 'running', startedAt: 200, canStop: true },
      { id: 'terminal-a', serverId: 'terminal-1', server: 'Terminal', command: 'npm test', status: 'running', startedAt: 300, sourceKind: 'terminal', canStop: false },
      { id: 'done', serverId: 'api', server: 'API', command: 'npm run done', status: 'exited', startedAt: 400, canStop: true },
      { id: '5438c7c6b6d137bd', serverId: 'task-build', server: 'build', taskName: 'build', status: 'exited', startedAt: 500, canStop: true }
    ]
  });

  get('server').listeners.get('click')!({ stopPropagation() { } });
  get('runsTab').listeners.get('click')!();
  assert.equal(get('sessionMenu').hidden, false);
  const rows = get('sessionMenu').children;
  assert.equal(rows.length, 6);
  assert.match(rows[5].children[0].textContent, /^Task: build · /, 'a run without a command is named by its task, not its id');
  assert.equal(rows[1].children[1].textContent, 'Stop');
  assert.equal(rows[2].children[1].textContent, 'Stop');
  assert.equal(rows[3].children[1].textContent, 'Capture only');
  assert.equal(rows[4].children.length, 1);

  rows[1].children[1].listeners.get('click')!({ stopPropagation() { } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'stop', serverId: 'api', sessionId: 'run-a' });
  assert.equal(get('sessionMenu').hidden, false);
  rows[2].children[1].listeners.get('click')!({ stopPropagation() { } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'stop', serverId: 'api', sessionId: 'run-b' });
});

test('the run picker selects a run and supports keyboard navigation', () => {
  const { get, messages, receive, dom } = viewer();
  get('scopeMenu').hidden = true;
  get('sessionMenu').hidden = true;
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0,
    columns: [], columnFields: [], fields: [], page: 0, pages: 1, matched: 0,
    sessions: [{ id: 'run-a', serverId: 'api', server: 'API', command: 'npm run api', status: 'running', startedAt: 100, canStop: true }]
  });
  get('runsTab').listeners.get('click')!();
  get('server').listeners.get('keydown')!({ key: 'ArrowDown', preventDefault() { } });
  assert.equal(get('sessionMenu').hidden, false);
  assert.equal(dom.activeElement, get('sessionMenu').children[0]);

  get('sessionMenu').children[1].children[0].listeners.get('click')!();
  assert.equal(get('scopeMenu').hidden, true);
  assert.match(get('server').textContent, /^All sources · npm run api$/);
  assert.equal(messages.at(-1)?.type, 'snapshot');
});

test('the combined scope picker switches between source and run tabs', () => {
  const { get, receive, app } = viewer();
  app.state.selectedServer = '';
  get('scopeMenu').hidden = true;
  receive({
    type: 'snapshot', generation: 1, newest: 100, total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0,
    columns: [], columnFields: [], fields: [], page: 0, pages: 1, matched: 0,
    servers: [
      { id: 'api', label: 'API', status: 'running', activeSessions: 1 },
      { id: 'worker', label: 'Worker', status: 'idle', activeSessions: 0 }
    ],
    sessions: [{ id: 'run-a', serverId: 'api', server: 'API', command: 'npm run api', status: 'running', startedAt: 100, canStop: true }]
  });

  get('server').listeners.get('click')!({ stopPropagation() { } });
  assert.equal(get('scopeMenu').hidden, false);
  assert.equal(get('sourcesTab').attributes['aria-selected'], 'true');
  assert.equal(get('sourceMenu').children.length, 3);

  get('runsTab').listeners.get('click')!();
  assert.equal(get('sourcesTab').attributes['aria-selected'], 'false');
  assert.equal(get('sourceMenu').hidden, true);
  assert.equal(get('sessionMenu').hidden, false);

  get('sourcesTab').listeners.get('click')!();
  get('sourceMenu').children[1].listeners.get('click')!();
  assert.equal(app.state.selectedServer, 'api');
  assert.equal(app.state.selectedSession, '');
  assert.equal(get('scopeMenu').hidden, true);
});

test('the terminal capture toggle exposes explicit state labels', () => {
  const { get, receive } = viewer();
  const snapshot = (captureTerminals: boolean, captureStatus: Record<string, unknown>) => receive({
    type: 'snapshot', generation: 1, newest: 100, total: 100, retained: 100, discarded: 0, bytes: 1000, maxBytes: 10000,
    truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0, captureTerminals, captureStatus
  });
  assert.equal(get('captureToggle').textContent, 'Terminal capture: Off');

  snapshot(false, { state: 'off', detail: 'Terminal capture is off', active: 0, failed: 0 });
  assert.equal(get('captureToggle').attributes['aria-pressed'], 'false');

  snapshot(true, { state: 'waiting', detail: 'Ready for the next supported terminal command', active: 0, failed: 0 });
  assert.equal(get('captureToggle').textContent, 'Terminal capture: On');
  assert.equal(get('captureToggle').attributes['aria-pressed'], 'true');

  snapshot(true, { state: 'capturing', detail: 'Capturing terminal command', active: 1, failed: 0 });
  assert.equal(get('captureToggle').textContent, 'Terminal capture: Capturing…');

  snapshot(true, { state: 'attention', detail: '1 terminal capture failed', active: 0, failed: 1 });
  assert.equal(get('captureToggle').textContent, 'Terminal capture: Needs attention');
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


test('the main sharing button ignores view filters and stops active sharing', () => {
  const { get, messages, receive, app } = viewer();
  app.state.selectedServer = 'api';
  get('server').value = 'api';
  // The run picker is a custom popover; sharing still reads the viewer state
  // independently of the current source/run filters.
  app.state.selectedSession = 'selected-run';
  get('shareAgent').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'shareWithAgent' });
  receive({ type: 'snapshot', generation: 100, newest: 100, events: [], columns: [], total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0, page: 0, pages: 1, matched: 0,
    agentSharing: { active: true, scope: 'all', revision: 1, sources: [] } });
  assert.equal(get('shareAgent').textContent, 'Sharing · Stop');
  assert.equal(get('shareAgent').attributes['aria-pressed'], 'true');
  assert.equal(get('shareScope').hidden, false);
  assert.equal(get('shareScope').textContent, 'Sharing all runs');
  assert.match(get('shareScope').title, /existing and new runs/);
  receive({ type: 'snapshot', generation: 100, newest: 100, events: [], columns: [], total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0, page: 0, pages: 1, matched: 0,
    agentSharing: { active: true, scope: 'all', revision: 1, sources: [] }, agentClients: ['Claude Code', 'Codex'] });
  assert.equal(get('shareScope').textContent, 'Sharing all runs · read by Claude Code, Codex');
  get('shareAgent').listeners.get('click')!();
  assert.equal(messages.at(-1)?.type, 'stopSharing');
  receive({ type: 'snapshot', generation: 101, newest: 100, events: [], columns: [], total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 10000, truncated: 0, page: 0, pages: 1, matched: 0,
    agentSharing: { active: false, revision: 2, sources: [] } });
  assert.equal(get('shareAgent').textContent, 'Share with agent');
  assert.equal(get('shareScope').hidden, true);
});

test('specific run sharing remains available through More actions', () => {
  const { get, messages } = viewer();
  get('actionsMenu').hidden = true;
  get('moreActions').listeners.get('click')!({ stopPropagation() { } });
  get('shareSpecificRuns').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'shareWithAgent', chooseRuns: true });
  assert.equal(get('actionsMenu').hidden, true);
});

test('rows show their code link and log doctor finding, with actions, and the toolbar lists findings', () => {
  const { get, receive, messages, app } = viewer();
  const finding = { siteId: 'src/pay.ts\u00004', code: 'secret', severity: 'warning', message: 'Logged a bearer token.', file: 'src/pay.ts', line: 4 };
  assert.equal(get('doctor').hidden, true, 'no chip while log doctor is off');
  assert.equal(get('rowHint').hidden, false, 'first-run tip explains opening events');
  receive({
    type: 'snapshot', generation: 1, newest: 101, status: 'Running', command: 'node server', running: true,
    total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 43, message: 'charged card', level: 'info', timestamp: '12:01', stream: 'stdout', site: true, finding: { severity: 'warning', message: finding.message } }],
    columns: [], page: 0, pages: 1, matched: 1, doctor: { revision: 3, findings: [finding], total: 1 }
  });
  const row = get('logs').querySelectorAll('.event-row').find(item => String(item.dataset.id) === '43')!;
  const site = row.querySelector('.row-site-button')!;
  const badge = row.querySelector('.row-finding-button')!;
  assert.equal(row.querySelector('.message-button')!.title, '', 'no tooltip repeats the message; clicking the row shows it');
  assert.match(badge.title, /Log doctor: Logged a bearer token/);
  const click = (target: Element, selector: string) => get('logs').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === selector ? target : undefined } });
  click(site, '.row-icon, .row-action');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'openLogSite', id: 43 });
  const slot = row.querySelector('.row-quick')!;
  assert.equal(slot.children.length, 0, 'quick actions are not built until the row is hovered');
  get('logs').listeners.get('pointerover')!({ target: { closest: () => row } });
  assert.deepEqual(slot.children.map(button => button.className.split(' ').at(-1)), ['row-context-button', 'row-break-button']);
  get('logs').listeners.get('pointerover')!({ target: { closest: () => row } });
  assert.equal(slot.children.length, 2, 'hovering again does not add more');
  click(slot.children[1], '.row-icon, .row-action');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'breakOnEvent', id: 43 });
  app.table.resetDetails();
  app.table.renderWindow();
  const rebuilt = get('logs').querySelectorAll('.event-row').find(item => String(item.dataset.id) === '43')!;
  assert.notEqual(rebuilt, row);
  assert.equal(rebuilt.querySelector('.row-quick')!.children.length, 2, 'a re-render under a still pointer keeps the hovered row\'s actions');
  click(badge, '.row-icon, .row-action');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'details', id: 43 }, 'the badge opens the event, where the finding is explained');
  assert.equal(get('rowHint').hidden, false, 'the tip stays until it is dismissed');
  receive({ type: 'details', id: 43, text: 'raw', target: 'main', exceptions: [], site: 'src/pay.ts:4', findings: [finding] });
  assert.match(get('logs').querySelector('.event-finding')!.className, /severity-warning/, 'the expanded event explains the finding');

  assert.equal(get('doctor').hidden, false);
  assert.equal(get('doctorCount').textContent, '1');
  assert.match(get('doctor').className, /has-warnings/);
  const item = get('doctorList').querySelectorAll('.doctor-item')[0];
  assert.equal(item.querySelector('.doctor-location')!.textContent, 'pay.ts:4');
  const fix = item.querySelectorAll('.doctor-action').find(button => button.textContent === 'Fix…')!;
  app.bridge.pending = false;
  app.bridge.request(true);
  assert.equal(messages.at(-1)!.doctorRevision, 3, 'the host can skip a list the view already has');
  receive({
    type: 'snapshot', generation: 1, newest: 102, status: 'Running', command: 'node server', running: true,
    total: 102, retained: 102, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0,
    doctor: { revision: 3, total: 1 }
  });
  assert.equal(get('doctorList').querySelectorAll('.doctor-item').length, 1, 'a snapshot without the list keeps the one shown');
  receive({
    type: 'snapshot', generation: 1, newest: 103, status: 'Running', command: 'node server', running: true,
    total: 103, retained: 103, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0,
    doctor: { revision: 4, total: 0, findings: [] }
  });
  assert.equal(get('doctor').hidden, false, 'with nothing found the chip stays visible');
  assert.match(get('doctor').className, /is-clear/);
  assert.equal(get('doctorCount').hidden, true);
  assert.match(get('doctorList').querySelector('.popover-empty')!.textContent, /No problems found so far/);
  get('doctorPanel').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === '[data-doctor-action]' ? fix : undefined } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'doctorAction', action: 'fix', siteId: finding.siteId });
});

test('a leak in output no statement accounts for names its source and opens an example locally', () => {
  const { get, receive, messages } = viewer();
  const finding = { code: 'secret', severity: 'warning', message: 'Vendor SDK logged a JSON Web Token.', source: 'Vendor SDK', eventId: 77 };
  receive({
    type: 'snapshot', generation: 1, newest: 101, status: 'Running', command: 'node server', running: true,
    total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0,
    doctor: { revision: 1, findings: [finding], total: 1 }
  });
  const item = get('doctorList').querySelectorAll('.doctor-item')[0];
  assert.equal(item.querySelector('.doctor-source')!.textContent, 'Vendor SDK');
  assert.equal(item.querySelectorAll('.doctor-action').length, 1, 'nothing to open or fix in the editor');
  const example = item.querySelector('.doctor-action')!;
  assert.equal(example.dataset.doctorAction, 'example');
  const sent = messages.length;
  get('doctorPanel').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === '[data-doctor-action]' ? example : undefined } });
  assert.equal(get('contextDialog').open, true);
  assert.deepEqual(messages.slice(sent).map(message => [message.type, message.id]), [['context', 77]]);
});

test('an OpenTelemetry convention finding names its service and opens a trace that shows it', () => {
  const { get, receive, messages } = viewer();
  const finding = { code: 'span-name-ids', severity: 'warning', message: 'Names 4 spans with ids in them.', source: 'api', traceId: 'abc123' };
  receive({
    type: 'snapshot', generation: 1, newest: 1, status: 'Running', command: '', running: true,
    total: 0, retained: 0, discarded: 0, bytes: 0, maxBytes: 1, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0,
    doctor: { revision: 1, findings: [finding], total: 1 }
  });
  assert.match(get('doctorList').querySelectorAll('.doctor-group')[0].children[0].textContent, /OpenTelemetry conventions · 1/);
  const item = get('doctorList').querySelectorAll('.doctor-item')[0];
  assert.equal(item.querySelector('.doctor-source')!.textContent, 'api');
  const trace = item.querySelector('.doctor-action')!;
  assert.equal(trace.textContent, 'Show trace');
  get('doctorPanel').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === '[data-doctor-action]' ? trace : undefined } });
  assert.equal(get('traceDialog').open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'trace', traceId: 'abc123' });
});

test('Got it hides the first-run tip for good', () => {
  const { get, receive, savedStates } = viewer();
  assert.equal(get('rowHint').hidden, false);
  get('rowHintDismiss').listeners.get('click')!();
  assert.equal(get('rowHint').hidden, true);
  assert.equal(savedStates.at(-1)!.rowHintDismissed, true);
  receive({
    type: 'snapshot', generation: 1, newest: 101, status: 'Running', command: 'node server', running: true,
    total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 44, message: 'later', level: 'info', timestamp: '12:02', stream: 'stdout' }], columns: [], page: 0, pages: 1, matched: 1
  });
  assert.equal(get('rowHint').hidden, true, 'later snapshots keep it hidden');
});

test('live rows hold while the pointer is over them and catch up when it leaves', () => {
  const { get, receive } = viewer();
  const ids = () => get('logs').querySelectorAll('.event-row').map(row => Number(row.dataset.id));
  assert.deepEqual(ids(), [42]);
  get('viewport').listeners.get('pointerenter')!();
  receive({
    type: 'snapshot', generation: 1, newest: 101, status: 'Running', command: 'node server', running: true,
    total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 42, message: 'timeout', level: 'error', timestamp: '12:00', stream: 'stderr' }, { id: 43, message: 'next', level: 'info', timestamp: '12:01', stream: 'stdout' }],
    columns: [], page: 0, pages: 2, matched: 101
  });
  assert.deepEqual(ids(), [42], 'rows do not move under the pointer');
  assert.match(get('mode').textContent, /held while you point at the table/);
  get('viewport').listeners.get('pointerleave')!();
  assert.deepEqual(ids(), [43, 42], 'the newest row is on top');
  assert.equal(get('mode').textContent, 'Live · newest 1,000');
});

test('a pointer resting on the table stops holding live rows after two seconds', () => {
  const { get, receive, runtime, timers } = viewer();
  let now = 1_000_000;
  runInContext('Date.now = () => globalThis.fakeNow()', runtime);
  (runtime as Record<string, unknown>).fakeNow = () => now;
  const ids = () => get('logs').querySelectorAll('.event-row').map(row => Number(row.dataset.id));
  const snapshot = (extra: number[]) => receive({
    type: 'snapshot', generation: 1, newest: 101, status: 'Running', command: 'node server', running: true,
    total: 101, retained: 101, discarded: 0, bytes: 1000, maxBytes: 10000, truncated: 0,
    events: [{ id: 42, message: 'timeout', level: 'error', timestamp: '12:00', stream: 'stderr' }, ...extra.map(id => ({ id, message: 'next', level: 'info', timestamp: '12:01', stream: 'stdout' }))],
    columns: [], page: 0, pages: 2, matched: 101
  });
  const runTimers = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  get('viewport').listeners.get('pointermove')!();
  snapshot([43]);
  assert.deepEqual(ids(), [42], 'held while the pointer moves');
  now += 1500;
  get('viewport').listeners.get('pointermove')!();
  now += 1500;
  runTimers();
  assert.deepEqual(ids(), [42], 'still held: the pointer moved 1.5 seconds ago');
  now += 600;
  runTimers();
  assert.deepEqual(ids(), [43, 42], 'released after two seconds without movement');
  snapshot([43, 44]);
  assert.deepEqual(ids(), [44, 43, 42], 'a resting pointer no longer holds new rows');
});

test('an expanded event explains log doctor findings on its statement', () => {
  const { renderDetails } = viewer();
  const details = renderDetails(42, 'raw', [], { site: 'src/pay.ts:4', findings: [{ siteId: 's', code: 'secret', severity: 'warning', message: 'Logged a bearer token.', file: 'src/pay.ts', line: 4 }] });
  const banner = details.querySelector('.event-finding')!;
  assert.match(banner.className, /severity-warning/);
  assert.deepEqual(banner.querySelectorAll('.doctor-action').map(button => [button.textContent, button.dataset.doctorAction, button.dataset.siteId]),
    [['Fix…', 'fix', 's'], ['Show events', 'showEvents', 's']]);
  assert.equal(renderDetails(42, 'raw', []).querySelector('.event-finding'), undefined);
});

test('event details link to the log statement and the trace', () => {
  const { get, renderDetails, messages } = viewer();
  const details = renderDetails(42, 'raw', [], { site: 'src/auth.ts:18', traceId: 'abc123' });
  const site = details.querySelector('.log-site-button')!;
  const trace = details.querySelector('.trace-button')!;
  assert.equal(site.querySelector('.event-action-label')!.textContent, 'Open code · auth.ts:18');
  assert.match(site.title, /src\/auth\.ts:18/);
  assert.equal(trace.dataset.traceId, 'abc123');
  const click = (target: Element, selector: string) => get('contextDetails').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === selector ? target : undefined } });
  click(site, '.log-site-button');
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'openLogSite', id: 42 });
  click(trace, '.trace-button');
  assert.equal(get('traceDialog').open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'trace', traceId: 'abc123' });
  // Actions that do not apply stay visible, explain why, and do nothing when clicked.
  const plain = renderDetails(43, 'raw', []);
  const unavailable = plain.querySelector('.trace-button')!;
  assert.match(String(unavailable.dataset.unavailable), /No trace id/);
  assert.equal(unavailable.attributes['aria-disabled'], 'true');
  assert.match(String(plain.querySelector('.log-site-button')!.dataset.unavailable), /No code location/);
  const sent = messages.length;
  get('contextDetails').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === '.event-action' ? plain.querySelector('.log-site-button') : undefined } });
  assert.equal(messages.length, sent);
  assert.equal(get('traceDialog').open, true, 'unchanged');
  assert.match(String(renderDetails(44, undefined, []).querySelector('.trace-button')!.dataset.unavailable), /Checking/, 'unknown while details load');
});

test('a JSON error shows the crash that followed it, and the crash links back', () => {
  const { renderDetails } = viewer();
  const exceptions = [{ title: 'Exception', lines: [{ text: 'TypeError: x' }, { text: '    at f (/srv/a.js:3:7)', source: { file: '/srv/a.js', line: 3, column: 7 } }] }];
  const error = renderDetails(42, '{"level":"error"}', [], { crash: { id: 43, message: 'TypeError: x', exceptions } });
  const note = error.querySelector('.event-attachment')!;
  assert.equal(note.children[1].children[0].textContent, 'A crash followed this error: ');
  assert.equal(note.querySelector('.context-button')!.dataset.id, '43');
  // Frames open from the crash event, which owns them.
  const frame = error.querySelector('.source-link')!;
  assert.deepEqual([frame.dataset.id, frame.dataset.block, frame.dataset.line], ['43', '0', '1']);
  const crash = renderDetails(43, 'TypeError: x', exceptions, { attachedTo: { id: 42, message: 'checkout failed' } });
  const back = crash.querySelector('.event-attachment')!;
  assert.equal(back.children[1].children[0].textContent, 'This crash followed a JSON error: ');
  assert.equal(back.querySelector('.context-button')!.dataset.id, '42');
});

test('an expanded JSON error in the table shows its crash, and the crash row links back', () => {
  const { get, receive, messages } = viewer();
  receive({
    type: 'snapshot', generation: 1, newest: 2, status: 'Running', command: 'npm run dev', running: true,
    total: 2, retained: 2, discarded: 0, bytes: 100, maxBytes: 10000, truncated: 0,
    events: [{ id: 1, message: 'checkout failed', level: 'error', timestamp: '12:01', stream: 'terminal' },
      { id: 2, message: 'TypeError: x', level: 'error', timestamp: '12:01', stream: 'terminal', attachedTo: 1 }],
    columns: [], page: 0, pages: 1, matched: 2
  });
  const rows = get('logs').querySelectorAll('.event-row');
  const crashRow = rows.find(item => String(item.dataset.id) === '2')!;
  const back = crashRow.querySelector('.row-attached-button')!;
  assert.equal(back.dataset.id, '1');
  get('logs').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === '.row-icon, .row-action' ? back : undefined } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'context', id: 1 });
  const errorRow = rows.find(item => String(item.dataset.id) === '1')!;
  get('logs').listeners.get('click')!({ target: { closest: (wanted: string) => wanted === '.message-button' ? errorRow.querySelector('.message-button') : undefined } });
  const exceptions = [{ title: 'Exception', lines: [{ text: 'TypeError: x' }, { text: '    at f (/srv/a.js:3:7)', source: { file: '/srv/a.js', line: 3, column: 7 } }] }];
  receive({ type: 'details', id: 1, text: '{"level":"error"}', target: 'main', exceptions: [], crash: { id: 2, message: 'TypeError: x', exceptions } });
  assert.equal(get('logs').querySelector('.event-attachment')?.querySelector('.context-button')?.dataset.id, '2');
  assert.equal(get('logs').querySelector('.source-link')?.dataset.id, '2');
});

test('the trace dialog renders a waterfall with logs and opens their context', () => {
  const { get, app, receive, messages } = viewer();
  app.traceView.show('ABC123');
  assert.equal(get('traceStatus').textContent, 'Loading…');
  const span = (spanId: string, depth: number, extra: Record<string, unknown> = {}) => ({ spanId, name: `op ${spanId}`, service: 'api', kind: 'server', offsetMs: depth * 10, durationMs: 40, selfMs: 40 - depth * 25, depth, error: false, critical: depth === 0, attributes: { 'http.route': '/x' }, events: [], ...extra });
  receive({ type: 'trace', trace: { traceId: 'other', spans: [], logs: [], services: [], durationMs: 0, errors: 0, omitted: 0, hotspots: [] } });
  assert.equal(get('traceStatus').textContent, 'Loading…', 'responses for another trace are ignored');
  receive({ type: 'trace', trace: {
    traceId: 'abc123', durationMs: 50, services: ['api', 'db'], errors: 1, omitted: 0,
    hotspots: [{ service: 'api', name: 'op a', count: 1, selfMs: 40, share: 0.727, errors: 0 }, { service: 'db', name: 'op b', count: 1, selfMs: 15, share: 0.273, errors: 1 }],
    spans: [span('a', 0), span('b', 1, { error: true, service: 'db', statusMessage: 'timeout' })],
    logs: [{ id: 7, level: 'warn', message: 'slow query', offsetMs: 12, spanId: 'b', server: 'OTel · db' }, { id: 8, level: 'info', message: 'stdout line', offsetMs: 30 }]
  } });
  assert.match(get('traceStatus').textContent, /^2 services · 2 spans · 50 ms · 1 error · 2 logs/);
  const rows = get('traceRows').children;
  assert.deepEqual(rows.map(row => row.className), ['trace-span trace-critical', 'trace-span trace-error', 'trace-log', 'trace-section', 'trace-log']);
  assert.equal(rows[1].children[0].children[0].textContent, '⚠ op b');
  assert.equal(rows[1].children[2].children[0].children[0].style.left, '20%');
  assert.equal(rows[1].children[2].children[0].children[0].style.width, '80%');
  assert.match(rows[1].children[0].attributes.title ?? (rows[1].children[0] as any).title, /Error: timeout/);
  assert.deepEqual([rows[0].children[4].textContent, rows[1].children[4].textContent], ['40 ms', '15 ms'], 'self time excludes children');
  assert.equal(rows[2].children.length, 5, 'log rows keep the column count');

  // Hotspots rank operations by self time and lead to their span.
  assert.equal(get('traceHotspots').hidden, false);
  const hotspots = get('traceHotspotList').children.map(item => item.children[0]);
  assert.deepEqual(hotspots.map(button => button.children[2].textContent), ['40 ms · 73%', '15 ms · 27%']);
  assert.equal(hotspots[1].className, 'trace-hotspot trace-hotspot-error');
  assert.equal(hotspots[1].children[1].children[0].style.width, '37.5%');
  get('traceHotspotList').listeners.get('click')!({ target: { closest: () => hotspots[1] } });
  assert.equal(rows[1].className, 'trace-span trace-error trace-flash');
  assert.equal(rows[1].scrollIntoViewCalls.length, 1);
  const log = rows[2].children[0].children[0];
  get('traceRows').listeners.get('click')!({ target: { closest: (selector: string) => selector === '.trace-log-button' ? log : undefined } });
  assert.equal(get('traceDialog').open, false);
  assert.equal(get('contextDialog').open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'context', id: 7 });
});

test('a trace without spans explains how to collect them, and Filter logs by trace applies a query', () => {
  const { get, app, receive, messages } = viewer();
  app.traceView.show('abc123');
  receive({ type: 'trace', trace: { traceId: 'abc123', durationMs: 0, services: [], errors: 0, omitted: 0, hotspots: [], spans: [], logs: [] } });
  assert.equal(get('traceHotspots').hidden, true);
  assert.match(get('traceStatus').textContent, /Turn on the OpenTelemetry receiver/);
  get('traceFilter').listeners.get('click')!();
  assert.equal(get('traceDialog').open, false);
  assert.equal(app.search.query(), 'traceId:abc123');
  assert.equal(messages.at(-1)?.type, 'snapshot');
});

test('the Traces list shows recent requests and opens a waterfall that can return to the list', () => {
  const { get, app, receive, messages } = viewer();
  get('traces').listeners.get('click')!();
  assert.equal(get('tracesDialog').open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'traces' });
  receive({ type: 'traces', traces: [
    { traceId: 'f1', name: 'POST /checkout', service: 'api', services: ['api', 'payments'], startMs: 1000, durationMs: 120, spans: 3, logs: 4, errors: 1 },
    { traceId: 'f2', name: 'GET /health', service: 'api', services: ['api'], startMs: 900, durationMs: 4, spans: 1, logs: 0, errors: 0 },
    { traceId: 'f3', name: 'job started', service: 'worker', services: ['worker'], startMs: 800, durationMs: 30, spans: 0, logs: 2, errors: 0 }
  ] });
  assert.match(get('tracesStatus').textContent, /^3 recent traces · 1 with errors · 1 from logs only/);
  assert.equal(get('tracesStartReceiver').hidden, true);
  assert.deepEqual(get('tracesRows').children.map(row => row.dataset.traceId), ['f1', 'f2', 'f3']);
  assert.equal(get('tracesRows').children[0].className, 'traces-row trace-error');
  get('tracesErrorsOnly').checked = true;
  get('tracesErrorsOnly').listeners.get('change')!();
  assert.deepEqual(get('tracesRows').children.map(row => row.dataset.traceId), ['f1']);
  const row = get('tracesRows').children[0];
  get('tracesRows').listeners.get('click')!({ target: { closest: () => row } });
  assert.equal(get('tracesDialog').open, false);
  assert.equal(get('traceDialog').open, true);
  assert.equal(get('traceBack').hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'trace', traceId: 'f1' });
  get('traceBack').listeners.get('click')!();
  assert.equal(get('tracesDialog').open, true);
  app.traceView.show('abc');
  assert.equal(get('traceBack').hidden, true, 'a trace opened from a row has no list to return to');
  receive({ type: 'traces', traces: [] });
  assert.match(get('tracesStatus').textContent, /No traces yet. Start the OpenTelemetry receiver/);
  assert.equal(get('tracesStartReceiver').hidden, false);
  receive({
    type: 'snapshot', generation: 1, newest: 100, status: 'Running', command: '', running: false, total: 0, retained: 0, discarded: 0, bytes: 0,
    maxBytes: 1, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0, otlp: { running: true, endpoint: 'http://127.0.0.1:4318' }
  });
  assert.equal(get('tracesStartReceiver').hidden, true, 'a running receiver is not offered again');
  assert.match(get('tracesStatus').textContent, /listening on http:\/\/127\.0\.0\.1:4318/);
});

test('snapshots apply editor requests once and reflect the OpenTelemetry receiver', () => {
  const { get, app, receive, messages } = viewer();
  const snapshot = (extra: Record<string, unknown>) => receive({
    type: 'snapshot', generation: 1, newest: 100, status: 'Running', command: '', running: false, total: 0, retained: 0, discarded: 0, bytes: 0,
    maxBytes: 1, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0, ...extra
  });
  snapshot({ applyQuery: 'message:/user.*logged\\s+in/', otlp: { running: true, endpoint: 'http://127.0.0.1:4318' }, traceCount: 12, status: 'OpenTelemetry receiver on http://127.0.0.1:4318' });
  assert.equal(app.search.query(), 'message:/user.*logged\\s+in/');
  assert.equal(get('otlpStatus').hidden, false);
  assert.equal(get('otlpStatus').textContent, 'OpenTelemetry 127.0.0.1:4318');
  assert.equal(get('status').textContent, 'Ready', 'the chip replaces the receiver status text');
  assert.equal(get('traceCount').textContent, '12');
  get('otlpStatus').listeners.get('click')!();
  assert.equal(get('tracesDialog').open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'traces' });
  assert.equal(get('otlpToggle').textContent, 'Stop OpenTelemetry receiver');
  get('otlpToggle').listeners.get('click')!();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'toggleOtlp', enabled: false });
  snapshot({ openTrace: 'abc123', otlp: { running: false } });
  assert.equal(get('traceDialog').open, true);
  assert.equal(get('otlpStatus').hidden, true);
  assert.equal(get('traceCount').hidden, true);
  assert.equal(get('otlpToggle').textContent, 'Start OpenTelemetry receiver');
});

test('the Metrics button appears once metrics arrive and lists series with their latest values', () => {
  const { get, receive, messages, timers } = viewer();
  const snapshot = (extra: Record<string, unknown>) => receive({
    type: 'snapshot', generation: 1, newest: 100, status: 'Running', command: '', running: false, total: 0, retained: 0, discarded: 0, bytes: 0,
    maxBytes: 1, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0, ...extra
  });
  snapshot({});
  assert.equal(get('metrics').hidden, true, 'no button before any metric arrives');
  snapshot({ metrics: { series: 2, revision: 5 } });
  assert.equal(get('metrics').hidden, false);
  assert.equal(get('metricCount').textContent, '2');
  get('metrics').listeners.get('click')!();
  assert.equal(get('metricsDialog').open, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'metrics' });
  const series = (extra: Record<string, unknown>) => ({ key: String(extra.name), kind: 'gauge', measure: 'value', service: 'api', attributes: [], timeMs: 0,
    points: [{ timeMs: 0, value: 1 }, { timeMs: 5000, value: 3 }], ...extra });
  receive({ type: 'metrics', metrics: [
    series({ name: 'http.server.duration', kind: 'histogram', measure: 'p95', unit: 's', latest: 0.18, attributes: [['http.route', '/orders']] }),
    series({ name: 'orders.placed', kind: 'sum', measure: 'rate', unit: '{order}', latest: 2.5, total: 120, service: 'checkout' })
  ] });
  assert.match(get('metricsStatus').textContent, /2 series from 2 services/);
  const rows = get('metricsRows').children;
  assert.deepEqual(rows.map(row => row.children[3].textContent), ['p95 180 ms', 'rate 2.5 order/s']);
  receive({ type: 'metrics', metrics: [series({ name: 'coarse', kind: 'histogram', measure: 'p95', unit: 's', latest: 0.9, bound: true })] });
  assert.equal(get('metricsRows').children[0].children[3].textContent, 'p95 ≤ 900 ms');
  assert.match(get('metricsRows').children[0].children[3].title, /buckets are too wide/);
  receive({ type: 'metrics', metrics: [
    series({ name: 'http.server.duration', kind: 'histogram', measure: 'p95', unit: 's', latest: 0.18, attributes: [['http.route', '/orders']] }),
    series({ name: 'orders.placed', kind: 'sum', measure: 'rate', unit: '{order}', latest: 2.5, total: 120, service: 'checkout' })
  ] });
  assert.equal(rows[0].children[2].textContent, 'http.route=/orders');
  assert.match(rows[1].children[3].title, /Total 120 order/);
  get('metricsFilter').value = 'checkout';
  get('metricsFilter').listeners.get('input')!();
  assert.equal(get('metricsRows').children.length, 1);
  assert.match(get('metricsStatus').textContent, /1 match/);
  const before = messages.length;
  const refreshes = () => messages.slice(before).filter(message => message.type === 'metrics').length;
  const pending = new Set(timers.keys());
  snapshot({ metrics: { series: 2, revision: 6 } });
  snapshot({ metrics: { series: 2, revision: 7 } });
  assert.equal(refreshes(), 0, 'new points do not reload the list at once');
  const scheduled = [...timers].filter(([id]) => !pending.has(id));
  assert.equal(scheduled.length, 1, 'one refresh is scheduled for both');
  for (const [id, callback] of scheduled) { timers.delete(id); callback(); }
  assert.equal(refreshes(), 1, 'an open list refreshes once per export interval, however many points arrived');
});

test('My changes appears in a git repository and adds or removes changed:true', () => {
  const { get, app, receive } = viewer();
  const snapshot = (extra: Record<string, unknown>) => receive({
    type: 'snapshot', generation: 1, newest: 100, status: 'Running', command: '', running: false, total: 0, retained: 0, discarded: 0, bytes: 0,
    maxBytes: 1, truncated: 0, events: [], columns: [], page: 0, pages: 1, matched: 0, ...extra
  });
  snapshot({});
  assert.equal(get('changedOnly').hidden, true, 'outside a git repository there is nothing to compare with');
  snapshot({ changes: { files: 3 } });
  assert.equal(get('changedOnly').hidden, false);
  assert.equal(get('changedOnly').attributes['aria-pressed'], 'false');
  assert.match(get('changedOnly').title, /3 files/);
  app.search.setQuery('level:error OR timeout', true);
  get('changedOnly').listeners.get('click')!();
  assert.equal(app.search.query(), 'level:error changed:true OR timeout changed:true');
  assert.equal(get('changedOnly').attributes['aria-pressed'], 'true');
  // The term shows as chips in the search box, so it can be seen, edited, and removed there too.
  assert.deepEqual(get('searchChips').children.map(chip => chip.title).filter(Boolean),
    ['level:error', 'changed:true', 'timeout', 'changed:true']);
  get('changedOnly').listeners.get('click')!();
  assert.equal(app.search.query(), 'level:error OR timeout');
  assert.equal(get('changedOnly').attributes['aria-pressed'], 'false');
  // A filter that already uses it keeps the button, so it can be turned off.
  app.search.setQuery('changed:true', true);
  snapshot({});
  assert.equal(get('changedOnly').hidden, false);
  assert.equal(get('changedOnly').attributes['aria-pressed'], 'true');
});
