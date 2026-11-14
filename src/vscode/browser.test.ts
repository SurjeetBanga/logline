import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { BrowserCapture } from '../capture/browser-capture';
import { Ingestion } from '../capture/ingestion';
import { RuntimeState } from '../capture/runtime-state';
import { SessionRegistry } from '../capture/session-registry';
import { LogStore } from '../core/log-store';
import { fakeSpawner } from '../test/fake-browser';
import { withVscode } from '../test/vscode-mock';

const ui = {
  warnings: [] as string[],
  errors: [] as string[],
  asked: [] as string[],
  inputs: [] as { value?: string; validateInput?: (value: string) => string | undefined }[],
  commands: [] as unknown[][],
  answer: undefined as string | undefined,
  typed: undefined as string | undefined,
};
const mock = {
  env: { remoteName: undefined as string | undefined },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { toString: () => 'file:///work/shop' } }] as unknown[] | undefined,
  },
  window: {
    showWarningMessage: async (message: string) => {
      ui.warnings.push(message);
      return ui.answer;
    },
    showErrorMessage: async (message: string) => void ui.errors.push(message),
    showInformationMessage: async (message: string) => {
      ui.asked.push(message);
      return ui.answer;
    },
    showInputBox: async (options: (typeof ui.inputs)[number]) => {
      ui.inputs.push(options);
      return ui.typed;
    },
  },
  commands: { executeCommand: async (...args: unknown[]) => void ui.commands.push(args) },
};
const {
  BrowserLauncher,
  BrowserOffer,
  BROWSER_OFFER_LIMIT,
  BROWSER_OFFER_WORKSPACE_KEY,
  BROWSER_URL_KEY,
  profileInUse,
} = withVscode(mock, () => require('./browser') as typeof import('./browser'));

function memento() {
  const stored = new Map<string, unknown>();
  return {
    stored,
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
}

function reset() {
  Object.assign(ui, {
    warnings: [],
    errors: [],
    asked: [],
    inputs: [],
    commands: [],
    answer: undefined,
    typed: undefined,
  });
  mock.env.remoteName = undefined;
  mock.workspace.isTrusted = true;
}

async function launcher(settings: Record<string, unknown> = {}, installed = ['/opt/chrome']) {
  reset();
  const storagePath = await mkdtemp(path.join(tmpdir(), 'logline-browser-'));
  const spawner = fakeSpawner((browser) => {
    browser.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
      return undefined;
    };
  });
  const config = { get: <T>(key: string, fallback: T) => (key in settings ? settings[key] : fallback) as T };
  const capture = new BrowserCapture(
    config,
    new SessionRegistry(),
    new Ingestion(new LogStore(), () => undefined),
    new RuntimeState(() => undefined),
    spawner.spawn,
  );
  const workspace = memento();
  const shown: string[] = [];
  const state = { recent: undefined as string | undefined };
  const browser = new BrowserLauncher({
    capture,
    config,
    storagePath,
    workspace,
    recentUrl: () => state.recent,
    show: (serverId) => void shown.push(serverId),
    // Chrome's usual place on this machine must not decide the test.
    exists: (file) => installed.includes(file) && !file.includes('Applications'),
  });
  const original = { platform: process.platform, path: process.env.PATH };
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.PATH = '/opt';
  const restore = async () => {
    Object.defineProperty(process, 'platform', { value: original.platform });
    process.env.PATH = original.path;
    await capture.dispose();
    await rm(storagePath, { recursive: true, force: true });
  };
  return { browser, capture, workspace, shown, state, storagePath, browsers: spawner.browsers, restore };
}

test('the command asks for the address, opens it in a profile of the workspace, and shows the source', async () => {
  const h = await launcher({ 'browser.executable': '/opt/chrome' });
  try {
    h.state.recent = 'http://localhost:5173/';
    ui.typed = 'localhost:5173/cart';
    assert.equal(await h.browser.open(), true);
    assert.equal(ui.inputs[0].value, 'http://localhost:5173/');
    assert.equal(ui.inputs[0].validateInput!('ftp://x'), 'Enter an http or https address.');
    assert.equal(ui.inputs[0].validateInput!('localhost:3000'), undefined);
    const [process] = h.browsers;
    assert.equal(process.executable, '/opt/chrome');
    const profile = process.args[1].replace('--user-data-dir=', '');
    assert.equal(path.dirname(profile), path.join(h.storagePath, 'browser-profiles'));
    assert.match(path.basename(profile), /^[0-9a-f]{16}$/);
    assert.ok((await stat(profile)).isDirectory());
    assert.equal(h.capture.active?.command, 'http://localhost:5173/cart');
    assert.deepEqual(h.shown, ['browser:localhost:5173']);
    assert.equal(h.workspace.stored.get(BROWSER_URL_KEY), 'http://localhost:5173/cart');

    // Without a dev server's address, the last one opened is offered; a given address is not asked for.
    h.state.recent = undefined;
    ui.typed = undefined;
    assert.equal(await h.browser.open(), false, 'cancelled');
    assert.equal(ui.inputs[1].value, 'http://localhost:5173/cart');
    assert.equal(await h.browser.open('http://localhost:5173/admin'), true);
    assert.equal(ui.inputs.length, 2);
    assert.equal(h.browsers.length, 1, 'a second address is a tab of the same browser');
  } finally {
    await h.restore();
  }
});

test('with nothing to go on, the address suggested is a common one, and one not typed as an address is asked for', async () => {
  const h = await launcher({}, ['/opt/google-chrome']);
  try {
    ui.typed = 'http://localhost:8080';
    assert.equal(await h.browser.open('not an address'), true);
    assert.equal(ui.inputs[0].value, 'http://localhost:3000');
    assert.equal(h.browsers[0].executable, '/opt/google-chrome', 'found on the PATH');
  } finally {
    await h.restore();
  }
});

test('a remote window and an untrusted workspace are told why no browser opens', async () => {
  const h = await launcher();
  try {
    mock.env.remoteName = 'ssh-remote';
    assert.equal(await h.browser.open('http://localhost:3000'), false);
    assert.match(ui.warnings[0], /remote machine/);
    mock.env.remoteName = undefined;
    mock.workspace.isTrusted = false;
    assert.equal(await h.browser.open('http://localhost:3000'), false);
    assert.match(ui.warnings[1], /Trust this workspace/);
    assert.equal(h.browsers.length, 0);
  } finally {
    await h.restore();
  }
});

test('a missing browser points at the setting, and a missing configured one is not replaced', async () => {
  const none = await launcher({}, []);
  try {
    ui.answer = 'Open Settings';
    assert.equal(await none.browser.open('http://localhost:3000'), false);
    assert.match(ui.warnings[0], /found no Chrome, Edge, Chromium, or Brave/);
    assert.deepEqual(ui.commands[0], ['workbench.action.openSettings', 'logline.browser.executable']);
  } finally {
    await none.restore();
  }
  const wrong = await launcher({ 'browser.executable': '/opt/missing' }, ['/opt/google-chrome']);
  try {
    assert.equal(wrong.browser.executable(), undefined);
    assert.equal(await wrong.browser.open('http://localhost:3000'), false);
    assert.match(ui.warnings[0], /found no browser at \/opt\/missing/);
    assert.equal(ui.commands.length, 0);
  } finally {
    await wrong.restore();
  }
});

test('a browser that does not start is reported, and a window without a folder still gets a profile', async () => {
  reset();
  mock.workspace.workspaceFolders = undefined;
  const storagePath = await mkdtemp(path.join(tmpdir(), 'logline-browser-'));
  const spawner = fakeSpawner((browser) => {
    browser.answer = () => 'silent';
    setImmediate(() => browser.exit(new Error('spawn EACCES')));
  });
  const config = {
    get: <T>(key: string, fallback: T) => (key === 'browser.executable' ? '/opt/chrome' : fallback) as T,
  };
  const capture = new BrowserCapture(
    config,
    new SessionRegistry(),
    new Ingestion(new LogStore(), () => undefined),
    new RuntimeState(() => undefined),
    spawner.spawn,
  );
  const browser = new BrowserLauncher({
    capture,
    config,
    storagePath,
    workspace: { get: () => undefined, update: () => Promise.reject(new Error('read-only')) },
    recentUrl: () => undefined,
    show: () => undefined,
    exists: () => true,
  });
  try {
    assert.equal(await browser.open('http://localhost:3000'), false);
    assert.deepEqual(ui.errors, ['Logline could not open the browser: spawn EACCES']);
    assert.match(spawner.browsers[0].args[1], /browser-profiles/);
  } finally {
    mock.workspace.workspaceFolders = [{ uri: { toString: () => 'file:///work/shop' } }];
    await rm(storagePath, { recursive: true, force: true });
  }
});

function offer(global = memento(), overrides: { enabled?: boolean; available?: boolean; opens?: boolean } = {}) {
  const opened: string[] = [];
  const steps: string[] = [];
  const workspace = memento();
  const browserOffer = new BrowserOffer({
    workspace,
    global,
    enabled: () => overrides.enabled ?? true,
    available: () => overrides.available ?? true,
    open: async (url) => {
      opened.push(url);
      return overrides.opens ?? true;
    },
    record: (step) => steps.push(step),
  });
  return { offer: browserOffer, opened, steps, global, workspace };
}

test('a run that prints a local address is offered the browser, once per workspace', async () => {
  reset();
  ui.answer = 'Open Browser';
  const here = offer();
  assert.equal(await here.offer.found('http://localhost:5173/'), true);
  assert.match(ui.asked[0], /Your app is at http:\/\/localhost:5173\/\./);
  assert.deepEqual(here.opened, ['http://localhost:5173/']);
  assert.deepEqual(here.steps, ['shown', 'accepted']);
  assert.equal(await here.offer.found('http://localhost:5173/'), false);
  assert.equal(await offer(here.global).offer.found('http://localhost:5173/'), false, 'a yes ends it everywhere');
});

test('a yes that opened nothing leaves the offer for another workspace', async () => {
  reset();
  ui.answer = 'Open Browser';
  const failed = offer(memento(), { opens: false });
  await failed.offer.found('http://localhost:5173/');
  assert.equal(await offer(failed.global).offer.found('http://localhost:5173/'), true);
});

test('the offer stops after a few workspaces without a yes, or at once when asked to', async () => {
  reset();
  const global = memento();
  for (let asked = 0; asked < BROWSER_OFFER_LIMIT; asked++) {
    const next = offer(global);
    assert.equal(await next.offer.found('http://localhost:3000'), true);
    assert.deepEqual(next.steps, ['shown', 'dismissed']);
  }
  assert.equal(await offer(global).offer.found('http://localhost:3000'), false);

  ui.answer = "Don't Ask Again";
  const never = offer();
  await never.offer.found('http://localhost:3000');
  assert.deepEqual(never.steps, ['shown', 'never']);
  assert.equal(await offer(never.global).offer.found('http://localhost:3000'), false);
});

test('nothing is offered when the setting is off, no browser can open, or a question is already up', async () => {
  reset();
  assert.equal(await offer(memento(), { enabled: false }).offer.found('http://localhost:3000'), false);
  assert.equal(await offer(memento(), { available: false }).offer.found('http://localhost:3000'), false);
  assert.equal(ui.asked.length, 0);
  const both = offer();
  const [first, second] = await Promise.all([
    both.offer.found('http://localhost:3000'),
    both.offer.found('http://localhost:3000'),
  ]);
  assert.deepEqual([first, second], [true, false]);
});

test('the address opened here last is suggested before one a run printed', async () => {
  const h = await launcher({ 'browser.executable': '/opt/chrome' });
  try {
    await h.workspace.update(BROWSER_URL_KEY, 'http://localhost:8080/admin');
    h.state.recent = 'http://localhost:4318/v1/traces';
    assert.equal(await h.browser.open(), false);
    assert.equal(ui.inputs[0].value, 'http://localhost:8080/admin');
  } finally {
    await h.restore();
  }
});

test('a profile another window’s browser holds is left to it, and this window gets its own', async () => {
  const h = await launcher({ 'browser.executable': '/opt/chrome' });
  try {
    await h.browser.open('http://localhost:5173/');
    const shared = h.browsers[0].args[1].replace('--user-data-dir=', '');
    assert.equal(profileInUse(shared), false);
    h.browsers[0].exit();
    // What a running Chromium leaves in its profile: a link to nowhere on macOS and Linux, a file on Windows.
    await symlink('host-1234', path.join(shared, 'SingletonLock'));
    assert.equal(profileInUse(shared), true);
    await h.browser.open('http://localhost:5173/');
    const own = h.browsers[1].args[1].replace('--user-data-dir=', '');
    assert.match(own, new RegExp(`^${shared.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}-[0-9a-f]{16}$`));
    assert.ok((await stat(own)).isDirectory());

    const windows = path.join(h.storagePath, 'windows-profile');
    await mkdir(windows);
    assert.equal(profileInUse(windows), false);
    await writeFile(path.join(windows, 'lockfile'), '');
    assert.equal(profileInUse(windows), true);
    assert.equal(profileInUse(path.join(h.storagePath, 'missing')), false);
  } finally {
    await h.restore();
  }
});

test('whether the offer could be made is known without asking, and an unanswered one is made again later', async () => {
  reset();
  // The notification went away with no answer: it may never have been seen.
  const unanswered = offer();
  assert.equal(unanswered.offer.canAsk(), true);
  assert.equal(await unanswered.offer.found('http://localhost:5173/'), true);
  assert.deepEqual(unanswered.steps, ['shown', 'dismissed']);
  assert.equal(unanswered.workspace.stored.get(BROWSER_OFFER_WORKSPACE_KEY), undefined);
  assert.equal(unanswered.offer.canAsk(), false, 'not twice in one window');

  ui.answer = 'Not Now';
  const answered = offer();
  await answered.offer.found('http://localhost:5173/');
  assert.equal(answered.workspace.stored.get(BROWSER_OFFER_WORKSPACE_KEY), true, 'an answer settles the workspace');

  assert.equal(offer(memento(), { enabled: false }).offer.canAsk(), false);
  assert.equal(offer(memento(), { available: false }).offer.canAsk(), false);
  const done = memento();
  await done.update('logline.browserOffer', { done: true });
  assert.equal(offer(done).offer.canAsk(), false);
});
