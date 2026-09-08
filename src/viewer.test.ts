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
  style = {};
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  value = '';
  open = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 300;
  get firstChild() { return this.children[0]; }
  get classList() { return { contains: (name: string) => this.className.split(' ').includes(name) }; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  addEventListener(name: string, callback: (event?: any) => void) { this.listeners.set(name, callback); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  contains(element: Element) { return this.children.includes(element); }
  closest() { return this; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
  getBoundingClientRect() { return { height: 30 }; }
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
    createElement: () => new Element(), createTextNode: () => new Element(), createDocumentFragment: () => new Element()
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
    page: 0, pages: 2, matched: 100 });
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
