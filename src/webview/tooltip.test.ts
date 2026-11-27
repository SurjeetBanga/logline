import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { EventScope } from './event-scope';
import { createTooltips } from './tooltip';

class Fake {
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  isConnected = true;
  textContent = '';
  className = '';
  children: Fake[] = [];
  classes = new Set<string>();
  classList = { toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)) };
  get title() {
    return this.attributes.title ?? '';
  }
  set title(value: string) {
    this.attributes.title = value;
  }
  append(...children: Fake[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {}
  closest() {
    return 'title' in this.attributes || this.dataset.tip !== undefined ? this : null;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, bottom: 0, width: 0, height: 0 };
  }
}

function setup(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tip = new Fake();
  const handlers = new Map<string, (event: unknown) => void>();
  let created = 0;
  Object.assign(globalThis, {
    document: { body: new Fake(), createElement: () => (created++ ? new Fake() : tip) },
    window: { innerHeight: 600, innerWidth: 800 },
  });
  context.after(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
  });
  const scope = {
    track() {},
    listen: (_target: unknown, type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
  } as unknown as EventScope;
  createTooltips(scope);
  const hover = (target: Fake) => {
    handlers.get('pointerdown')!({});
    handlers.get('pointerover')!({ target });
    context.mock.timers.tick(1000);
  };
  return { tip, hover };
}

test('a title that was cleared shows no tooltip, and a new one shows', (context) => {
  const { tip, hover } = setup(context);
  const button = new Fake();
  button.textContent = 'Include';
  button.title = 'This filter is too long.';
  hover(button);
  assert.equal(tip.hidden, false);
  assert.equal(tip.textContent, 'This filter is too long.');

  button.title = '';
  hover(button);
  assert.equal(tip.hidden, true);
  assert.equal(button.dataset.tip, undefined);
  assert.equal(button.attributes['aria-description'], undefined);

  button.title = 'Another reason.';
  hover(button);
  assert.equal(tip.textContent, 'Another reason.');
});

test('a title of labelled lines is set out as a table, with its note across it', (context) => {
  const { tip, hover } = setup(context);
  const button = new Fake();
  button.title = 'Status\trunning\nModel\tclaude-opus-5-5\nCould not read the file';
  hover(button);
  assert.ok(tip.classes.has('tooltip-facts'));
  assert.deepEqual(
    tip.children.map((child) => [child.className, child.textContent]),
    [
      ['tooltip-label', 'Status'],
      ['tooltip-value', 'running'],
      ['tooltip-label', 'Model'],
      ['tooltip-value', 'claude-opus-5-5'],
      ['tooltip-note', 'Could not read the file'],
    ],
  );

  button.title = 'Plain text.';
  hover(button);
  assert.equal(tip.classes.has('tooltip-facts'), false, 'plain text stays plain');
  assert.equal(tip.textContent, 'Plain text.');
});
