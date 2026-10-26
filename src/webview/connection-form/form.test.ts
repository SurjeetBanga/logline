import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftSecretKey, emptyDraft, type FormRequest, type FormUpdate } from '../../core/connection-form';

// A minimal DOM adapter, enough for the form's elements, events, and selectors. It does not
// simulate layout; the page's look still needs a real webview.
class Node {
  children: Node[] = [];
  parent?: Node;
  attributes: Record<string, string> = {};
  listeners = new Map<string, ((event: unknown) => void)[]>();
  className = '';
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  private text = '';
  constructor(readonly tagName = '#text') {}
  get id() {
    return this.attributes.id ?? '';
  }
  get dataset() {
    return Object.fromEntries(
      Object.entries(this.attributes)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()), value]),
    );
  }
  get textContent(): string {
    return this.text || this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }
  get classList() {
    const names = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (name: string) => names().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !names().includes(name);
        this.className = [...names().filter((item) => item !== name), ...(on ? [name] : [])].join(' ');
      },
    };
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, ...event });
  }
  append(...children: Node[]) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children: Node[]) {
    this.text = '';
    this.children = [];
    this.append(...children);
  }
  focus() {
    focused = this;
  }
  private matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.'))
      return selector
        .slice(1)
        .split('.')
        .every((name) => this.className.split(' ').includes(name));
    const attribute = /^\[([\w-]+)\]$/.exec(selector);
    if (attribute) return attribute[1] in this.attributes;
    return this.tagName === selector;
  }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): Node | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

let focused: Node | undefined;
const root = new Node('div');
Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => Object.assign(new Node(), { textContent: text }),
    getElementById: (id: string) => root.querySelector(`#${id}`),
  },
});

// Loaded after the adapter, since the module reads `document` only when the form is made.
const { createConnectionForm } = require('./form') as typeof import('./form');

function setup() {
  const sent: FormRequest[] = [];
  root.replaceChildren();
  const form = createConnectionForm({ postMessage: (message) => sent.push(message) }, root as unknown as HTMLElement);
  const $ = (selector: string) => root.querySelector(selector)!;
  const steps = () => root.querySelectorAll('section');
  const button = (label: RegExp) => root.querySelectorAll('button').find((node) => label.test(node.textContent))!;
  const type = (selector: string, value: string) => {
    $(selector).value = value;
    $(selector).fire('input');
  };
  const choose = (selector: string, value: string) => {
    $(selector).value = value;
    $(selector).fire('change');
  };
  const receive = (update: FormUpdate) => form.receive(update);
  const init = (fields: Partial<Extract<FormUpdate, { type: 'init' }>> = {}) =>
    receive({
      type: 'init',
      mode: 'add',
      draft: emptyDraft(),
      secret: false,
      profiles: [],
      sites: ['datadoghq.com'],
      ...fields,
    });
  const note = () => $('.footer-note').textContent;
  const save = () => $('footer').querySelectorAll('button').at(-1)!;
  /** The radio button of a choice, such as the Fields of Enter the server as. */
  const radio = (name: string, value: string) =>
    root.querySelectorAll('input').find((input) => input.attributes.name === name && input.value === value)!;
  return { sent, $, steps, button, type, choose, receive, init, note, save, radio, root: () => root };
}

test('a Postgres URL fills the form, a test unlocks the tables, and Save waits for the time column', () => {
  const form = setup();
  assert.equal(form.steps()[0].hidden, true, 'nothing shows before the extension fills it in');
  form.init();
  assert.equal(form.steps()[0].hidden, false);
  assert.equal(form.root().querySelectorAll('.type-card').length, 5);
  assert.ok(form.$('.type-card.selected').textContent.startsWith('Postgres'));
  assert.equal(form.save().disabled, true);
  assert.equal(form.note(), 'Test the connection to continue.');
  assert.ok(form.steps()[2].classList.contains('locked'));

  // A pasted URL's password moves to its own field; the name follows the database.
  form.type('#field-url-entry', ['postgres://dev', 'pw@db.local:6543/orders?sslmode=require'].join(':'));
  assert.equal(form.$('#field-password').value, 'pw');
  assert.equal(form.$('#field-url-entry').value, 'postgres://dev@db.local:6543/orders?sslmode=require');
  assert.equal(form.$('#field-label').value, 'orders');
  form.$('#field-url-entry').fire('keydown', { key: 'Enter' });
  const request = form.sent.at(-1) as Extract<FormRequest, { type: 'test' }>;
  assert.equal(request.type, 'test');
  assert.deepEqual(
    [
      request.draft.host,
      request.draft.port,
      request.draft.user,
      request.draft.database,
      request.draft.ssl,
      request.draft.password,
    ],
    ['db.local', '6543', 'dev', 'orders', true, 'pw'],
  );
  assert.equal(form.button(/Testing/).disabled, true);

  form.receive({ type: 'tested', ok: true, detail: 'Postgres 16.2 · 2 tables', tables: ['events', 'users'] });
  assert.equal(form.$('.test-status').textContent, '✓ Connected · Postgres 16.2 · 2 tables');
  assert.equal(form.steps()[2].classList.contains('locked'), false);
  // A database needs no log table: it starts as None, ready to save.
  assert.equal(
    form
      .$('#field-table')
      .querySelectorAll('option')
      .find((option) => 'selected' in option.attributes)?.value,
    '\0none',
  );
  assert.equal(form.note(), '');
  assert.equal(form.save().disabled, false);
  form.choose('#field-table', 'events');
  assert.deepEqual(form.sent.at(-1), { type: 'table', table: 'events' });
  assert.equal(form.note(), 'Reading events…');

  form.receive({
    type: 'columns',
    table: 'events',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'severity', type: 'text' },
      { name: 'msg', type: 'text' },
    ],
    suggested: { level: 'severity', message: 'msg' },
    rows: [{ id: '1', severity: 'ERROR', msg: 'payment gateway timed out' }],
  });
  assert.equal(
    form
      .$('#map-level')
      .querySelectorAll('option')
      .find((option) => 'selected' in option.attributes)?.value,
    'severity',
  );
  const mapped = form
    .root()
    .querySelectorAll('th')
    .filter((header) => header.classList.contains('mapped'));
  assert.deepEqual(
    mapped.map((header) => header.textContent),
    ['severityLevel', 'msgMessage'],
  );
  assert.equal(form.note(), 'Choose the time column.');
  assert.equal(form.save().disabled, true);
  form.choose('#map-timestamp', 'id');
  assert.equal(form.save().disabled, false);
  assert.equal(form.note(), '');
  form.save().fire('click');
  const saved = form.sent.at(-1) as Extract<FormRequest, { type: 'save' }>;
  assert.equal(saved.type, 'save');
  assert.equal(saved.draft.label, 'orders');
  assert.deepEqual(saved.mapping, { table: 'events', timestamp: 'id', level: 'severity', message: 'msg' });
  assert.equal(form.save().textContent, 'Saving…');
  form.receive({ type: 'saveFailed', error: 'Settings could not be written.' });
  assert.equal(form.note(), 'Settings could not be written.');
  assert.equal(form.save().disabled, false);
});

test('a failed test keeps what was typed, and a change after a good test asks for another', () => {
  const form = setup();
  form.init();
  form.radio('entry', 'fields').fire('change');
  form.button(/Test connection/).fire('click');
  // Incomplete: the form says what is missing without asking the extension.
  assert.equal(form.sent.filter((message) => message.type === 'test').length, 0);
  assert.equal(form.$('.test-status').textContent, 'Enter the user to sign in as');
  form.type('#field-user', 'dev');
  form.type('#field-database', 'orders');
  assert.equal(form.$('.url-preview').textContent, 'postgres://dev@localhost/orders');
  form.button(/Test connection/).fire('click');
  form.receive({ type: 'tested', ok: false, error: 'connect ECONNREFUSED 127.0.0.1:5432' });
  assert.equal(form.$('.test-status').textContent, 'connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(form.$('#field-user').value, 'dev');
  form.button(/Test connection/).fire('click');
  form.receive({ type: 'tested', ok: true, detail: 'Postgres 16 · 0 tables', tables: [] });
  form.choose('#field-table', '\0none');
  assert.equal(form.save().disabled, false);
  form.type('#field-port', '5433');
  assert.equal(form.$('.test-status').textContent, 'Changed since the last test. Test again to continue.');
  assert.equal(form.save().disabled, true);
  assert.ok(form.steps()[2].classList.contains('locked'));
});

test('editing tests the saved connection at once, keeps its type, and chooses its saved columns again', () => {
  const form = setup();
  const billing = {
    ...emptyDraft('mysql'),
    label: 'Billing',
    host: 'db.local',
    port: '3306',
    user: 'app',
    database: 'billing',
  };
  form.init({
    mode: 'edit',
    draft: billing,
    mapping: { table: 'logs', timestamp: 'at', level: 'lvl' },
    secret: true,
    secretKey: draftSecretKey(billing),
  });
  assert.equal(form.$('h1').textContent, 'Edit Billing');
  assert.equal(form.save().textContent, 'Save changes');
  assert.equal(form.$('#field-password').getAttribute('placeholder'), 'Saved · leave empty to keep');
  assert.equal(form.root().querySelectorAll('.type-card.disabled').length, 4, 'only MySQL can be chosen');
  assert.equal(form.sent.at(-1)?.type, 'test');
  form.receive({ type: 'tested', ok: true, detail: 'MySQL 8 · 2 tables', tables: ['logs', 'users'] });
  assert.deepEqual(form.sent.at(-1), { type: 'table', table: 'logs' });
  form.receive({
    type: 'columns',
    table: 'logs',
    columns: [
      { name: 'at', type: 'datetime' },
      { name: 'lvl', type: 'varchar' },
      { name: 'message', type: 'text' },
    ],
    suggested: { timestamp: 'at', message: 'message' },
    rows: [],
  });
  // The saved choice, not the guess: no message column was saved.
  const selected = (id: string) =>
    form
      .$(id)
      .querySelectorAll('option')
      .find((option) => 'selected' in option.attributes)?.value;
  assert.equal(selected('#map-level'), 'lvl');
  assert.equal(selected('#map-message'), '');
  assert.equal(form.$('.logs').textContent.includes('logs is empty'), true);
  form.save().fire('click');
  const saved = form.sent.at(-1) as Extract<FormRequest, { type: 'save' }>;
  assert.equal(saved.draft.label, 'Billing');
  assert.deepEqual(saved.mapping, { table: 'logs', timestamp: 'at', level: 'lvl' });
});

test('a saved password is kept only for its own server, and can be forgotten', () => {
  const form = setup();
  const orders = { ...emptyDraft('postgres'), label: 'Orders', host: 'db.local', user: 'app', database: 'orders' };
  form.init({ mode: 'edit', draft: orders, secret: true, secretKey: draftSecretKey(orders) });
  form.receive({ type: 'tested', ok: true, detail: 'Postgres 16', tables: [] });
  const placeholder = () => form.$('#field-password').getAttribute('placeholder') ?? '';
  assert.equal(placeholder(), 'Saved · leave empty to keep');
  form.type('#field-host', 'other.local');
  assert.equal(placeholder(), '', 'another server does not get the saved password');
  form.type('#field-host', 'db.local');
  assert.equal(placeholder(), 'Saved · leave empty to keep');
  const forget = form.$('#field-forgetSecret');
  forget.checked = true;
  forget.fire('change');
  assert.equal(placeholder(), '');
  form.button(/Test connection/).fire('click');
  const request = form.sent.at(-1) as Extract<FormRequest, { type: 'test' }>;
  assert.equal(request.draft.forgetSecret, true);
});

test('a preview that cannot be read still lets the table be mapped', () => {
  const form = setup();
  form.init();
  form.type('#field-url-entry', 'postgres://dev@db.local/orders');
  form.button(/Test connection/).fire('click');
  form.receive({ type: 'tested', ok: true, detail: 'Postgres 16', tables: ['events'] });
  form.choose('#field-table', 'events');
  form.receive({
    type: 'columns',
    table: 'events',
    columns: [{ name: 'at', type: 'timestamp' }],
    suggested: { timestamp: 'at' },
    rows: [],
    previewError: 'permission denied for column secret',
  });
  assert.match(form.$('.logs').textContent, /Could not preview events: permission denied/);
  assert.equal(form.save().disabled, false);
});

test('a URL that stops parsing is not tested with the one before it', () => {
  const form = setup();
  form.init();
  form.type('#field-url-entry', 'postgres://dev@db-a.local/orders');
  form.type('#field-url-entry', 'postgres://dev@db-b.local:54x/orders');
  form.button(/Test connection/).fire('click');
  assert.equal(form.sent.filter((message) => message.type === 'test').length, 0);
  assert.equal(form.$('.test-status').textContent, 'Enter a URL Logline can read, or use Fields.');
});

test('None chosen while editing stays None after another test', () => {
  const form = setup();
  const billing = { ...emptyDraft('mysql'), label: 'Billing', host: 'db.local', user: 'app', database: 'billing' };
  form.init({ mode: 'edit', draft: billing, mapping: { table: 'logs', timestamp: 'at' }, secret: false });
  form.receive({ type: 'tested', ok: true, detail: 'MySQL 8', tables: ['logs'] });
  form.receive({ type: 'columns', table: 'logs', error: 'permission denied' });
  form.choose('#field-table', '\0none');
  form.button(/Test again/).fire('click');
  form.receive({ type: 'tested', ok: true, detail: 'MySQL 8', tables: ['logs'] });
  assert.notDeepEqual(form.sent.at(-1), { type: 'table', table: 'logs' });
  form.save().fire('click');
  assert.equal((form.sent.at(-1) as Extract<FormRequest, { type: 'save' }>).mapping, null);
});

test('a name typed before the form came back is kept', () => {
  const form = setup();
  form.init({ draft: { ...emptyDraft(), host: 'h', user: 'u', database: 'orders', label: 'prod-replica' } });
  assert.equal(form.$('#field-label').value, 'prod-replica');
});

test('a stray % in a URL leaves the form working', () => {
  const form = setup();
  form.init();
  form.type('#field-url-entry', 'postgres://dev:50%off@db.local/orders');
  assert.equal(form.$('#field-password').value, '50%off');
  assert.equal(form.$('#field-label').value, 'orders');
});

test('Datadog needs no table, SQLite browses for its file, and Cancel asks to close', () => {
  const form = setup();
  form.init();
  form.radio('type', 'datadog').fire('change');
  assert.ok(form.$('.type-card.selected').textContent.startsWith('Datadog'));
  assert.equal(form.$('#field-label').value, 'prod');
  form.type('#field-apiKey', ['dd', 'api'].join('-'));
  form.type('#field-appKey', ['dd', 'app'].join('-'));
  form.button(/Test connection/).fire('click');
  form.receive({ type: 'tested', ok: true, detail: 'Datadog · datadoghq.com' });
  assert.match(form.$('.logs').textContent, /need no table/);
  assert.equal(form.save().disabled, false);

  form.radio('type', 'sqlite').fire('change');
  assert.equal(form.save().disabled, true, 'a new type needs its own test');
  form.button(/Browse/).fire('click');
  assert.deepEqual(form.sent.at(-1), { type: 'browse' });
  form.receive({ type: 'file', path: '/tmp/app.db', outside: true });
  assert.equal(form.$('#field-path').value, '/tmp/app.db');
  assert.equal(form.$('#field-label').value, 'app');
  assert.match(form.$('.details').textContent, /outside the workspace/);
  form.button(/Cancel/).fire('click');
  assert.deepEqual(form.sent.at(-1), { type: 'cancel' });
});

test('a field changed while a test runs makes its answer stale, and a name does not', () => {
  const form = setup();
  form.init();
  form.type('#field-url-entry', 'postgres://dev@db.local/orders');
  form.button(/Test connection/).fire('click');
  form.type('#field-label', 'Orders');
  form.receive({ type: 'tested', ok: true, detail: 'Postgres 16 · 1 table', tables: ['events'] });
  assert.equal(
    form.$('.test-status').textContent,
    '✓ Connected · Postgres 16 · 1 table',
    'a new name needs no new test',
  );
  form.button(/Test again/).fire('click');
  form.type('#field-url-entry', 'postgres://dev@db.local/billing');
  form.receive({ type: 'tested', ok: true, detail: 'Postgres 16 · 1 table', tables: ['events'] });
  assert.equal(form.$('.test-status').textContent, 'Changed since the last test. Test again to continue.');
  assert.ok(form.steps()[2].classList.contains('locked'));
  assert.equal(form.save().disabled, true);
});

test('MongoDB asks for its database only when the URL does not end with one', () => {
  const form = setup();
  form.init();
  form.radio('type', 'mongodb').fire('change');
  form.type('#field-url', 'mongodb://reader@host/app');
  assert.equal(form.$('#field-database').parent!.hidden, true);
  form.type('#field-url', ['mongodb://reader', 'pw@host/?authSource=admin'].join(':'));
  assert.equal(form.$('#field-url').value, 'mongodb://reader@host/?authSource=admin');
  assert.equal(form.$('#field-password').value, 'pw');
  assert.equal(form.$('#field-database').parent!.hidden, false);
  form.type('#field-database', 'events');
  assert.equal(form.$('#field-label').value, 'events');
  form.button(/Test connection/).fire('click');
  const sent = form.sent.at(-1) as Extract<FormRequest, { type: 'test' }>;
  assert.equal(sent.draft.database, 'events');
});
