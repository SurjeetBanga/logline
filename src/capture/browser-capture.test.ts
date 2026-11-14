import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { BrowserCapture, CdpPipe } from './browser-capture';
import { browserCandidates, locateBrowser } from './browser-locate';
import { Ingestion } from './ingestion';
import { RuntimeState } from './runtime-state';
import { SessionRegistry } from './session-registry';
import { LogStore } from '../core/log-store';
import { fakeSpawner, type FakeBrowser } from '../test/fake-browser';

const LAUNCH = { executable: '/opt/chrome', profileDir: '/tmp/profile' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await tick();
}

function harness(settings: Record<string, unknown> = {}, prepare?: (browser: FakeBrowser) => void) {
  const store = new LogStore();
  const registry = new SessionRegistry();
  let notified = 0;
  const state = new RuntimeState(() => void notified++);
  const config = { get: <T>(key: string, fallback: T) => (key in settings ? settings[key] : fallback) as T };
  // The tab a browser opens with is reported while auto-attach is being set.
  const spawner = fakeSpawner(
    prepare ??
      ((browser) => {
        browser.answer = (command) => {
          if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
          return undefined;
        };
      }),
  );
  const capture = new BrowserCapture(config, registry, new Ingestion(store, () => undefined), state, spawner.spawn);
  return { store, registry, state, capture, settings, browsers: spawner.browsers, notified: () => notified };
}

test('opening a browser starts a run and shows the address in its first tab', async () => {
  const h = harness();
  const id = await h.capture.open('http://localhost:5173/cart', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  assert.equal(browser.executable, '/opt/chrome');
  assert.deepEqual(browser.args, [
    '--remote-debugging-pipe',
    '--user-data-dir=/tmp/profile',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  assert.deepEqual(browser.commands[0].params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.deepEqual(browser.methods(), [
    'Target.setAutoAttach',
    'Runtime.enable',
    'Network.enable',
    'Log.enable',
    'Page.navigate',
  ]);
  assert.deepEqual(browser.commands.at(-1), {
    id: 5,
    method: 'Page.navigate',
    params: { url: 'http://localhost:5173/cart' },
    sessionId: 'tab-1',
  });
  const record = h.registry.records.get(id)!;
  assert.equal(record.sourceKind, 'browser');
  assert.equal(record.serverId, 'browser:localhost:5173');
  assert.equal(record.server, 'Browser · localhost:5173');
  assert.equal(record.status, 'running');
  assert.equal(record.canStop, true);
  assert.equal(record.pid, 4242);
  assert.equal(record.command, 'http://localhost:5173/cart');
  assert.equal(h.capture.active, record);
  assert.equal(h.state.status, 'Capturing Browser · localhost:5173');
});

test('a browser that reports no tab gets one opened', async () => {
  const h = harness({}, () => undefined);
  await h.capture.open('http://localhost:3000/', LAUNCH);
  assert.deepEqual(h.browsers[0].methods(), ['Target.setAutoAttach', 'Target.createTarget']);
  assert.deepEqual(h.browsers[0].commands[1].params, { url: 'http://localhost:3000/' });
});

test('console calls, exceptions, browser messages, and requests become events of the run', async () => {
  const h = harness();
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  browser.emit(
    'Runtime.consoleAPICalled',
    { type: 'error', args: [{ type: 'string', value: 'cart failed' }] },
    'tab-1',
  );
  browser.emit(
    'Runtime.exceptionThrown',
    {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { subtype: 'error', description: 'TypeError: x\n    at a (http://localhost/a.js:1:1)' },
      },
    },
    'tab-1',
  );
  browser.emit(
    'Log.entryAdded',
    { entry: { level: 'warning', text: 'blocked by CORS policy', source: 'security' } },
    'tab-1',
  );
  browser.emit(
    'Network.requestWillBeSent',
    {
      requestId: 'r1',
      request: { url: 'http://localhost:4000/api/orders', method: 'GET' },
      timestamp: 1,
      wallTime: 1767323045,
      type: 'Fetch',
    },
    'tab-1',
  );
  browser.emit('Network.responseReceived', { requestId: 'r1', response: { status: 503 } }, 'tab-1');
  browser.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 1.25 }, 'tab-1');
  // Not from a tab, and not something Logline reads.
  browser.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'no session' }] });
  browser.emit('Page.frameNavigated', {}, 'tab-1');
  browser.emit('Runtime.consoleAPICalled', { type: 'clear', args: [] }, 'tab-1');
  await settle();
  const events = h.store.all();
  assert.deepEqual(
    events.map((event) => [event.level, event.message]),
    [
      ['error', 'cart failed'],
      ['error', 'Uncaught TypeError: x'],
      ['warn', 'blocked by CORS policy'],
      ['error', 'GET /api/orders 503 (250 ms)'],
    ],
  );
  assert.ok(events.every((event) => event.serverId === 'browser:localhost:5173' && event.sessionId === id));
  assert.equal(events[3].fields?.status, 503);
  assert.equal(events[3].fields?.kind, 'request');
  assert.equal(h.registry.records.get(id)!.events, 4);
  assert.ok(h.notified() >= 4);
});

test('the requests setting is read as events arrive', async () => {
  const h = harness({ 'browser.requests': 'off' });
  await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  const request = (id: string, type: string) => {
    browser.emit(
      'Network.requestWillBeSent',
      { requestId: id, request: { url: `http://localhost/${id}.js`, method: 'GET' }, timestamp: 1, type },
      'tab-1',
    );
    browser.emit('Network.responseReceived', { requestId: id, response: { status: 200 } }, 'tab-1');
    browser.emit('Network.loadingFinished', { requestId: id, timestamp: 2 }, 'tab-1');
  };
  request('a', 'Fetch');
  browser.emit('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 500' } }, 'tab-1');
  await settle();
  assert.deepEqual(
    h.store.all().map((event) => event.message),
    ['Failed to load resource: 500'],
  );
  h.settings['browser.requests'] = 'all';
  request('b', 'Script');
  await settle();
  assert.equal(h.store.all().at(-1)!.message, 'GET /b.js 200 (1000 ms)');
  h.settings['browser.requests'] = 'nonsense';
  request('c', 'Script');
  request('d', 'XHR');
  await settle();
  assert.equal(h.store.all().at(-1)!.message, 'GET /d.js 200 (1000 ms)');
  assert.equal(h.store.all().length, 3);
});

test('a second address opens a tab, which is read before it runs', async () => {
  const h = harness();
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  assert.equal(await h.capture.open('http://localhost:5173/admin', LAUNCH), id);
  assert.equal(h.browsers.length, 1);
  assert.deepEqual(browser.commands.at(-1)!.params, { url: 'http://localhost:5173/admin' });
  assert.equal(browser.commands.at(-1)!.method, 'Target.createTarget');
  browser.commands.length = 0;
  browser.attachPage('tab-2', true);
  await settle();
  assert.deepEqual(browser.methods(), [
    'Runtime.enable',
    'Network.enable',
    'Log.enable',
    'Runtime.runIfWaitingForDebugger',
  ]);
  assert.ok(browser.commands.every((command) => command.sessionId === 'tab-2'));
});

test('workers are let run and left alone, and a closed tab forgets its requests', async () => {
  const h = harness();
  await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  browser.commands.length = 0;
  browser.emit('Target.attachedToTarget', {
    sessionId: 'worker-1',
    targetInfo: { type: 'service_worker' },
    waitingForDebugger: true,
  });
  browser.emit('Target.attachedToTarget', { targetInfo: { type: 'page' } });
  browser.emit('Target.attachedToTarget', { sessionId: 'odd' });
  await settle();
  assert.deepEqual(
    browser.commands.map((command) => [command.method, command.sessionId ?? command.params.sessionId]),
    [
      ['Runtime.runIfWaitingForDebugger', 'worker-1'],
      ['Target.detachFromTarget', 'odd'],
      ['Target.detachFromTarget', 'worker-1'],
    ],
  );
  browser.emit(
    'Network.requestWillBeSent',
    { requestId: 'r1', request: { url: 'http://localhost/api', method: 'GET' }, timestamp: 1, type: 'Fetch' },
    'tab-1',
  );
  // Another tab stays open, so closing this one does not end the capture.
  browser.attachPage('tab-2');
  await settle();
  browser.emit('Target.detachedFromTarget', { sessionId: 'tab-1' });
  browser.emit('Target.detachedFromTarget', {});
  browser.emit('Network.loadingFinished', { requestId: 'r1', timestamp: 2 }, 'tab-1');
  await settle();
  assert.equal(h.store.all().length, 0);
});

test('a tab that cannot be read is still shown its address, and the capture goes on', async () => {
  const h = harness({}, (browser) => {
    browser.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
      return command.method === 'Network.enable' ? { error: { message: 'Session closed' } } : undefined;
    };
  });
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  assert.equal(h.registry.records.get(id)!.status, 'running');
  // What could not be read is no reason to leave the address unopened.
  assert.ok(h.browsers[0].methods().includes('Page.navigate'));
});

test('stopping asks the browser to close, and the run ends when it has', async () => {
  const h = harness();
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  h.capture.stopSessionById('another');
  h.capture.stopServer('browser:elsewhere');
  assert.equal(h.registry.records.get(id)!.status, 'running');
  h.capture.stopServer('browser:localhost:5173');
  await settle();
  const record = h.registry.records.get(id)!;
  assert.equal(h.browsers[0].methods().at(-1), 'Browser.close');
  assert.equal(h.browsers[0].killed, false);
  assert.equal(record.status, 'exited');
  assert.equal(record.exitReason, 'stopped');
  assert.equal(record.captureComplete, true);
  assert.ok(record.endedAt);
  assert.equal(h.capture.active, undefined);
  assert.equal(h.state.status, 'Browser · localhost:5173 closed');
  h.capture.stop();
  await h.capture.dispose();
});

test('a browser that ignores the request to close is killed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({}, (browser) => {
    browser.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
      return command.method === 'Browser.close' ? 'silent' : undefined;
    };
  });
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  h.capture.stopSessionById(id);
  h.capture.stop();
  assert.equal(h.registry.records.get(id)!.status, 'stopping');
  // Events of a browser that is closing are no longer taken.
  h.browsers[0].emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'late' }] }, 'tab-1');
  await settle();
  assert.equal(h.store.all().length, 0);
  assert.equal(h.browsers[0].killed, false);
  t.mock.timers.tick(2000);
  assert.equal(h.browsers[0].killed, true);
  assert.equal(h.registry.records.get(id)!.status, 'exited');
});

test('closing the browser window ends the run, and the next open starts another', async () => {
  const h = harness();
  const first = await h.capture.open('http://localhost:5173/', LAUNCH);
  h.browsers[0].exit();
  assert.equal(h.registry.records.get(first)!.exitReason, 'browser closed');
  const second = await h.capture.open('http://localhost:5173/', LAUNCH);
  assert.notEqual(second, first);
  assert.equal(h.browsers.length, 2);
  assert.equal(h.registry.records.get(second)!.serverId, h.registry.records.get(first)!.serverId);
  await h.capture.dispose();
  assert.equal(h.registry.records.get(second)!.status, 'exited');
});

test('opening while the last browser is still closing waits for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({}, (browser) => {
    browser.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
      return command.method === 'Browser.close' ? 'silent' : undefined;
    };
  });
  await h.capture.open('http://localhost:5173/', LAUNCH);
  h.capture.stop();
  const next = h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  assert.equal(h.browsers.length, 1);
  t.mock.timers.tick(2000);
  await next;
  assert.equal(h.browsers.length, 2);
});

test('a browser that cannot start, or closes at once, fails the open and its run', async () => {
  const missing = harness({}, (browser) => {
    browser.answer = () => 'silent';
    setImmediate(() => browser.exit(new Error('spawn /opt/chrome ENOENT')));
  });
  await assert.rejects(missing.capture.open('http://localhost:5173/', LAUNCH), /ENOENT/);
  const [record] = [...missing.registry.records.values()];
  assert.equal(record.status, 'failed');
  assert.equal(record.exitReason, 'spawn /opt/chrome ENOENT');
  assert.equal(missing.capture.active, undefined);

  // Another browser already uses the profile: the new process hands over to it and exits.
  const handedOver = harness({}, (browser) => {
    browser.answer = () => 'silent';
    setImmediate(() => browser.exit());
  });
  await assert.rejects(handedOver.capture.open('http://localhost:5173/', LAUNCH), /closed before Logline connected/);
});

test('a browser that refuses to be read is closed', async () => {
  const h = harness({}, (browser) => {
    browser.answer = (command) =>
      command.method === 'Target.setAutoAttach' ? { error: { message: 'Not allowed' } } : undefined;
  });
  await assert.rejects(h.capture.open('http://localhost:5173/', LAUNCH), /Not allowed/);
  await settle();
  assert.equal(h.browsers[0].methods().at(-1), 'Browser.close');
  assert.equal(h.capture.active, undefined);
});

function pipe(timeoutMs?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: unknown[] = [];
  const sent: string[] = [];
  input.on('data', (chunk: Buffer) => sent.push(chunk.toString()));
  return { input, output, events, sent, cdp: new CdpPipe(input, output, (event) => events.push(event), timeoutMs) };
}

test('the pipe frames messages across chunks and matches answers to commands', async () => {
  const p = pipe();
  const answer = p.cdp.send('Target.getTargets', { all: true }, 'session');
  await tick();
  assert.equal(p.sent[0], '{"id":1,"method":"Target.getTargets","params":{"all":true},"sessionId":"session"}\0');
  p.output.write('{"method":"A","params":{"n":1}}\0{"id":1,"res');
  p.output.write('ult":{"ok":true}}\0{"method":"B","sessionId":"s"}\0not json\0"text"\0{"id":99}\0{"other":1}\0');
  assert.deepEqual(await answer, { ok: true });
  assert.deepEqual(p.events, [
    { method: 'A', params: { n: 1 } },
    { method: 'B', params: {}, sessionId: 's' },
  ]);
  const refused = p.cdp.send('Nope');
  const empty = p.cdp.send('Empty');
  await tick();
  p.output.write('{"id":2,"error":{"code":-1}}\0{"id":3}\0');
  await assert.rejects(refused, /refused the command/);
  assert.deepEqual(await empty, {});
});

test('a message too large to keep is skipped, and the next one read', async () => {
  const p = pipe();
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
  p.output.write(Buffer.from('{"method":"Huge","params":{"text":"'));
  for (let part = 0; part < 4; part++) p.output.write(big);
  p.output.write(Buffer.from('"}}\0{"method":"After"}\0'));
  await settle();
  assert.deepEqual(p.events, [{ method: 'After', params: {} }]);
});

test('commands time out, and a closed pipe rejects what waits and what follows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = pipe(50);
  const slow = p.cdp.send('Slow');
  t.mock.timers.tick(50);
  await assert.rejects(slow, /did not answer Slow/);
  const waiting = p.cdp.send('Waiting');
  p.cdp.close();
  p.cdp.close();
  await assert.rejects(waiting, /browser closed/);
  await assert.rejects(p.cdp.send('Later'), /browser is closed/);
  p.output.write('{"method":"Ignored"}\0');
  await settle();
  assert.deepEqual(p.events, []);
  p.input.emit('error', new Error('EPIPE'));
  p.output.emit('error', new Error('EPIPE'));
});

test('a pipe that cannot be written to rejects the command', async () => {
  const p = pipe();
  p.input.write = () => {
    throw new Error('write after end');
  };
  await assert.rejects(p.cdp.send('Any'), /write after end/);
});

test('the browser is found where each platform installs it', () => {
  const mac = browserCandidates('darwin', { HOME: '/Users/me' });
  assert.equal(mac[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(mac[1], '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(browserCandidates('darwin', {}).length, 4);
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  assert.equal(
    locateBrowser('darwin', {}, (file) => file === edge),
    edge,
  );

  const windows = browserCandidates('win32', {
    PROGRAMFILES: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  });
  assert.equal(windows[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(windows.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));

  const linux = browserCandidates('linux', { PATH: '/usr/bin:relative:/snap/bin' });
  assert.equal(linux[0], '/usr/bin/google-chrome');
  assert.ok(linux.includes('/snap/bin/chromium'));
  assert.ok(!linux.some((file) => file.startsWith('relative')));
  assert.deepEqual(browserCandidates('linux', {}), []);
  assert.equal(
    locateBrowser('linux', { PATH: '/usr/bin' }, () => false),
    undefined,
  );
});

test('a configured browser is used, and never replaced when it is missing', () => {
  const exists = (file: string) => file === '/opt/chromium/chrome' || file.includes('Google Chrome');
  assert.equal(locateBrowser('darwin', {}, exists, ' /opt/chromium/chrome '), '/opt/chromium/chrome');
  assert.equal(locateBrowser('darwin', {}, exists, '/opt/missing'), undefined);
  assert.match(locateBrowser('darwin', {}, exists, '  ')!, /Google Chrome/);
});

test('a request answered but never read is reported while the browser runs, and not after it closed', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const h = harness();
  await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  const answered = (id: string) => {
    browser.emit(
      'Network.requestWillBeSent',
      {
        requestId: id,
        request: { url: `http://localhost:4000/api/${id}`, method: 'GET' },
        timestamp: 1,
        type: 'Fetch',
      },
      'tab-1',
    );
    browser.emit('Network.responseReceived', { requestId: id, timestamp: 1.04, response: { status: 500 } }, 'tab-1');
  };
  answered('boom');
  await settle();
  t.mock.timers.tick(1000);
  assert.equal(h.store.all().length, 0);
  t.mock.timers.tick(1000);
  assert.deepEqual(
    h.store.all().map((event) => event.message),
    ['GET /api/boom 500 (40 ms)'],
  );
  answered('late');
  await settle();
  browser.exit();
  t.mock.timers.tick(5000);
  assert.equal(h.store.all().length, 1);
});

const page = (sessionId: string, url: string, extra: object = {}) => ({
  sessionId,
  targetInfo: { type: 'page', targetId: `target-${sessionId}`, url, ...extra },
});
const request = (browser: FakeBrowser, tab: string, id: string, url: string, documentURL: string) => {
  browser.emit(
    'Network.requestWillBeSent',
    { requestId: id, documentURL, request: { url, method: 'GET' }, timestamp: 1, type: 'Fetch' },
    tab,
  );
  browser.emit('Network.responseReceived', { requestId: id, response: { status: 200 } }, tab);
  browser.emit('Network.loadingFinished', { requestId: id, timestamp: 1.01 }, tab);
};

test('each tab’s events go to the source of the site it is showing, under the one run', async () => {
  const h = harness();
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  const log = (tab: string, text: string) =>
    browser.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: text }] }, tab);
  // A second site in a second tab.
  await h.capture.open('http://localhost:4000/admin', LAUNCH);
  browser.emit('Target.attachedToTarget', {
    ...page('tab-2', 'http://localhost:4000/admin'),
    waitingForDebugger: true,
  });
  await settle();
  log('tab-1', 'shop');
  log('tab-2', 'admin');
  // The first tab then goes to a third site; a page of another scheme changes nothing.
  request(browser, 'tab-1', 'r1', 'http://localhost:8080/api', 'http://localhost:8080/');
  request(browser, 'tab-1', 'r2', 'http://localhost:8080/api', 'chrome-error://chromewebdata/');
  log('tab-1', 'docs');
  await settle();
  assert.deepEqual(
    h.store.all().map((event) => [event.serverId, event.server, event.message, event.sessionId === id]),
    [
      ['browser:localhost:5173', 'Browser · localhost:5173', 'shop', true],
      ['browser:localhost:4000', 'Browser · localhost:4000', 'admin', true],
      ['browser:localhost:8080', 'Browser · localhost:8080', 'GET /api 200 (10 ms)', true],
      ['browser:localhost:8080', 'Browser · localhost:8080', 'GET /api 200 (10 ms)', true],
      ['browser:localhost:8080', 'Browser · localhost:8080', 'docs', true],
    ],
  );
  assert.deepEqual(h.capture.sites, ['localhost:8080', 'localhost:4000']);
  // Stop on any of its sites' sources stops the browser.
  h.capture.stopServer('browser:localhost:4000');
  await settle();
  assert.equal(h.capture.active, undefined);
  assert.deepEqual(h.capture.sites, []);
});

test('closing the last tab ends the capture, where the browser itself would have run on', async () => {
  const h = harness();
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  browser.attachPage('tab-2');
  await settle();
  browser.emit('Target.detachedFromTarget', { sessionId: 'tab-2' });
  await settle();
  assert.equal(h.registry.records.get(id)!.status, 'running');
  browser.emit('Target.detachedFromTarget', { sessionId: 'tab-1' });
  await settle();
  assert.equal(browser.methods().at(-1), 'Browser.close');
  const record = h.registry.records.get(id)!;
  assert.equal(record.status, 'exited');
  assert.equal(record.exitReason, 'browser closed');
});

test('two opens at once start one browser, and the second adds a tab', async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.capture.open('http://localhost:5173/', LAUNCH),
    h.capture.open('http://localhost:5173/cart', LAUNCH),
  ]);
  assert.equal(first, second);
  assert.equal(h.browsers.length, 1);
  assert.equal(h.browsers[0].methods().at(-1), 'Target.createTarget');
  // An open that fails does not hold up the next.
  const failing = harness({}, (browser) => {
    browser.answer = (command) =>
      command.method === 'Target.setAutoAttach' && failing.browsers.length === 1
        ? { error: { message: 'Not allowed' } }
        : command.method === 'Target.setAutoAttach'
          ? (browser.attachPage('tab-1'), undefined)
          : undefined;
  });
  const results = await Promise.allSettled([
    failing.capture.open('http://localhost:5173/', LAUNCH),
    failing.capture.open('http://localhost:5173/', LAUNCH),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'fulfilled'],
  );
  assert.equal(failing.browsers.length, 2);
});

test('a starting tab reported late is waited for; one reported after Logline opened its own is closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Reported a moment after auto-attach was answered: it is used, and no second tab is opened.
  const late = harness({}, () => undefined);
  const opening = late.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  late.browsers[0].emit('Target.attachedToTarget', page('tab-1', 'about:blank'));
  await opening;
  await settle();
  assert.deepEqual(late.browsers[0].methods().slice(-1), ['Page.navigate']);
  assert.ok(!late.browsers[0].methods().includes('Target.createTarget'));

  // Never reported in time: Logline opens a tab, and the blank one that shows up afterwards is closed.
  const never = harness({}, () => undefined);
  const waiting = never.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  t.mock.timers.tick(1500);
  const id = await waiting;
  const [browser] = never.browsers;
  assert.equal(browser.methods().at(-1), 'Target.createTarget');
  browser.emit('Target.attachedToTarget', { ...page('own', 'http://localhost:5173/'), waitingForDebugger: true });
  browser.emit('Target.attachedToTarget', page('blank', 'about:blank'));
  await settle();
  assert.deepEqual(browser.commands.find((command) => command.method === 'Target.closeTarget')?.params, {
    targetId: 'target-blank',
  });
  // Its closing is not the last tab closing, and a blank tab the page opens later is left alone.
  browser.emit('Target.detachedFromTarget', { sessionId: 'blank' });
  browser.emit('Target.attachedToTarget', page('popup', 'about:blank', { openerId: 'target-own' }));
  browser.emit('Target.attachedToTarget', page('newtab', 'about:blank'));
  await settle();
  assert.equal(never.registry.records.get(id)!.status, 'running');
  assert.equal(browser.methods().filter((method) => method === 'Target.closeTarget').length, 1);
});

test('a first tab that cannot be sent to the address gets a new tab for it, and a waiting tab is always let run', async () => {
  const h = harness({}, (browser) => {
    browser.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
      return /enable|navigate/.test(command.method) ? { error: { message: 'Session closed' } } : undefined;
    };
  });
  await h.capture.open('http://localhost:5173/', LAUNCH);
  await settle();
  const [browser] = h.browsers;
  assert.deepEqual(browser.commands.at(-1)!.params, { url: 'http://localhost:5173/' });
  assert.equal(browser.methods().at(-1), 'Target.createTarget');
  browser.commands.length = 0;
  browser.attachPage('tab-2', true);
  await settle();
  assert.equal(browser.methods().at(-1), 'Runtime.runIfWaitingForDebugger');
});

test('a browser that ignores being asked and told to end is killed outright, and nothing waits on it for ever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({}, (browser) => {
    browser.obeysKill = false;
    browser.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') browser.attachPage('tab-1');
      return command.method === 'Browser.close' ? 'silent' : undefined;
    };
  });
  const id = await h.capture.open('http://localhost:5173/', LAUNCH);
  const [browser] = h.browsers;
  const disposed = h.capture.dispose();
  t.mock.timers.tick(2000);
  assert.equal(browser.killed, true);
  assert.equal(browser.forced, false);
  assert.equal(h.registry.records.get(id)!.status, 'stopping');
  t.mock.timers.tick(2000);
  assert.equal(browser.forced, true);
  await disposed;
  assert.equal(h.registry.records.get(id)!.status, 'exited');

  // One that survives even that: shutdown and the next open go on without it.
  const stuck = harness({}, (process) => {
    process.kill = () => undefined;
    process.answer = (command) => {
      if (command.method === 'Target.setAutoAttach') process.attachPage('tab-1');
      return command.method === 'Browser.close' ? 'silent' : undefined;
    };
  });
  await stuck.capture.open('http://localhost:5173/', LAUNCH);
  stuck.capture.stop();
  const next = stuck.capture.open('http://localhost:5173/', LAUNCH);
  const gone = stuck.capture.dispose();
  await settle();
  t.mock.timers.tick(6000);
  await gone;
  await next;
  assert.equal(stuck.browsers.length, 2);
});
