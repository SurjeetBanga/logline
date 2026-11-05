import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  get title() {
    return this.attributes.title ?? '';
  }
  set title(value: string) {
    this.attributes.title = value;
  }
  append() {}
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

test('a title that was cleared shows no tooltip, and a new one shows', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tip = new Fake();
  const handlers = new Map<string, (event: unknown) => void>();
  Object.assign(globalThis, {
    document: { body: new Fake(), createElement: () => tip },
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
