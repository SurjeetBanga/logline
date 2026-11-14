import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserCapture, spawnBrowser } from '../capture/browser-capture';
import { locateBrowser } from '../capture/browser-locate';
import { Ingestion } from '../capture/ingestion';
import { RuntimeState } from '../capture/runtime-state';
import { SessionRegistry } from '../capture/session-registry';
import { LogStore } from '../core/log-store';

// Browser capture against a real Chromium, to check what the scripted browser of the unit tests cannot:
// that a browser started with a protocol pipe reports its console, exceptions, and requests the way
// `capture/browser-capture.ts` expects. Run with `npm run test:browser`.

const PAGE = `<!doctype html><title>shop</title><script>
  console.log('cart %s', 'loaded', { items: 2 });
  console.warn('slow render');
  new WebSocket(location.origin.replace('http', 'ws') + '/socket');
  Promise.reject(new Error('no stock'));
  fetch('/api/ok')
    .then(() => fetch('/api/boom'))
    .then(() => fetch('/api/gone'))
    .then(() => setTimeout(() => { throw new TypeError('cart is undefined'); }, 0));
</script>`;

let server: Server;
let url = '';
let profileDir = '';
// Playwright's Chromium where it is installed (CI); else a browser of this machine.
const executable =
  [chromium.executablePath()].find(existsSync) ?? locateBrowser(process.platform, process.env, existsSync);

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/') response.setHeader('content-type', 'text/html').end(PAGE);
    else if (request.url === '/api/ok') response.setHeader('content-type', 'application/json').end('{}');
    else if (request.url === '/api/boom') response.writeHead(500).end('no');
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  profileDir = await mkdtemp(join(tmpdir(), 'logline-browser-real-'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test(
  'a real browser reports its console, exceptions, and requests, and closes when stopped',
  { skip: !executable },
  async () => {
    const store = new LogStore();
    const registry = new SessionRegistry();
    const capture = new BrowserCapture(
      { get: <T>(_key: string, fallback: T) => fallback },
      registry,
      new Ingestion(store, () => undefined),
      new RuntimeState(() => undefined),
      // No window, and no sandbox, which CI's containers cannot set up.
      (file, args) => spawnBrowser(file, ['--headless=new', '--no-sandbox', ...args]),
    );
    const id = await capture.open(url, { executable: executable!, profileDir });
    try {
      const messages = () => store.all().map((event) => event.message ?? '');
      // A browser's first start on a machine can take a while, and its request events trail its console's.
      const deadline = Date.now() + 45_000;
      const seen = (start: string) => messages().some((message) => message.startsWith(start));
      // The page reads none of its responses, so each is reported once it has waited unread.
      while (
        ![
          'Uncaught TypeError',
          'Uncaught (in promise)',
          'GET /api/ok',
          'GET /api/boom',
          'GET /api/gone',
          'GET /socket',
        ].every(seen)
      ) {
        assert.ok(Date.now() < deadline, `Timed out; captured: ${JSON.stringify(messages())}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const find = (start: string) => store.all().find((event) => event.message?.startsWith(start));
      assert.equal(find('cart loaded')?.message, 'cart loaded {items: 2}');
      assert.equal(find('cart loaded')?.level, 'info');
      assert.match(String(find('cart loaded')?.fields?.at), /^http:\/\/localhost:\d+\/:\d+$/);
      assert.equal(find('slow render')?.level, 'warn');
      assert.equal(find('GET / 200')?.fields?.type, 'document');
      const ok = find('GET /api/ok 200')!;
      assert.equal(ok.level, 'info');
      assert.equal(ok.fields?.status, 200);
      assert.equal(ok.fields?.type, 'fetch');
      assert.equal(ok.fields?.contentType, 'application/json');
      assert.equal(typeof ok.fields?.durationMs, 'number');
      assert.equal(messages().filter((message) => message.startsWith('GET /api/')).length, 3, 'each request once');
      assert.equal(find('GET /api/boom 500')?.level, 'error');
      assert.equal(find('GET /api/gone 404')?.level, 'warn');
      const thrown = find('Uncaught TypeError')!;
      assert.equal(thrown.level, 'error');
      assert.match(String(thrown.fields?.stack), /TypeError: cart is undefined\n\s+at /);
      assert.equal(find('Uncaught (in promise)')?.message, 'Uncaught (in promise) Error: no stock');
      // The server takes no WebSockets: a socket that never connected is a failed request.
      const socket = find('GET /socket')!;
      assert.equal(socket.fields?.type, 'websocket');
      assert.ok(socket.level === 'error' || socket.level === 'warn', socket.message);
      // The browser's own "Failed to load resource" lines repeat the request events.
      assert.ok(!messages().some((message) => message.startsWith('Failed to load resource')));
      assert.ok(
        store.all().every((event) => event.sessionId === id && event.serverId?.startsWith('browser:localhost:')),
      );
    } finally {
      await capture.dispose();
    }
    const record = registry.records.get(id)!;
    assert.equal(record.status, 'exited');
    assert.equal(record.exitReason, 'stopped');
    assert.equal(capture.active, undefined);
  },
);
