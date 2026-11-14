import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserLogRecord,
  browserSource,
  browserUrl,
  consoleRecord,
  exceptionRecord,
  formatArguments,
  localUrls,
  RequestTracker,
  traceIdOf,
  wantsRequest,
  type RequestMode,
} from './browser-events';
import { extractExceptions } from './exceptions';
import { parseLogLine } from './log-event';
import { getField } from './query';

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const string = (value: string) => ({ type: 'string', value });

test('console arguments read as one line', () => {
  assert.equal(
    formatArguments([
      string('user'),
      { type: 'number', value: 7 },
      { type: 'undefined' },
      { type: 'object', subtype: 'null' },
    ]),
    'user 7 undefined null',
  );
  assert.equal(
    formatArguments([
      { type: 'number', unserializableValue: 'NaN' },
      { type: 'boolean', value: false },
    ]),
    'NaN false',
  );
  assert.equal(
    formatArguments([
      {
        type: 'object',
        description: 'Object',
        preview: {
          overflow: true,
          properties: [
            { name: 'id', type: 'number', value: '3' },
            { name: 'name', type: 'string', value: 'ada' },
          ],
        },
      },
    ]),
    '{id: 3, name: "ada", …}',
  );
  assert.equal(
    formatArguments([
      {
        type: 'object',
        subtype: 'array',
        description: 'Array(2)',
        preview: {
          properties: [
            { name: '0', type: 'number', value: '1' },
            { name: '1', type: 'string', value: 'b' },
          ],
        },
      },
    ]),
    '[1, "b"]',
  );
  assert.equal(formatArguments([{ type: 'function', description: 'function go() {}' }]), 'function go() {}');
  assert.equal(formatArguments([{ type: 'object', className: 'Map' }]), 'Map');
  assert.equal(formatArguments('nothing'), '');
});

test('format specifiers are applied and styles dropped', () => {
  assert.equal(
    formatArguments([
      string('%c[vite]%c connected in %dms 100%% %s'),
      string('color: blue'),
      string(''),
      { type: 'number', value: 12 },
    ]),
    '[vite] connected in 12ms 100% %s',
  );
  assert.equal(formatArguments([string('%s and'), string('one'), string('two')]), 'one and two');
});

test('long and numerous arguments are bounded', () => {
  const many = Array.from({ length: 30 }, (_, index) => string(String(index)));
  assert.equal(formatArguments(many), '0 1 2 3 4 5 6 7 8 9');
  assert.equal(formatArguments([string('x'.repeat(5000))]).length, 1001);
});

test('a console call becomes a record with its level and call site', () => {
  const record = consoleRecord(
    {
      type: 'warning',
      args: [string('slow render')],
      timestamp: NOW,
      stackTrace: { callFrames: [{ url: '' }, { url: 'http://localhost:5173/src/App.tsx', lineNumber: 11 }] },
    },
    0,
  );
  assert.deepEqual(record, {
    timestamp: '2026-01-02T03:04:05.000Z',
    level: 'warn',
    message: 'slow render',
    kind: 'console',
    at: 'http://localhost:5173/src/App.tsx:12',
  });
  assert.equal(consoleRecord({ type: 'error', args: [string('no')] }, NOW)?.level, 'error');
  assert.equal(consoleRecord({ type: 'assert', args: [string('no')] }, NOW)?.level, 'error');
  assert.equal(consoleRecord({ type: 'log', args: [string('hi')] }, NOW)?.level, 'info');
  assert.equal(consoleRecord({ type: 'debug', args: [string('hi')] }, NOW)?.level, 'debug');
  assert.equal(consoleRecord({ args: [string('hi')], timestamp: 1e300 }, NOW)?.timestamp, '2026-01-02T03:04:05.000Z');
  assert.equal(consoleRecord({ type: 'clear', args: [] }, NOW), undefined);
  assert.equal(consoleRecord({ type: 'log', args: [] }, NOW), undefined);
  assert.equal(consoleRecord(null, NOW), undefined);
});

test('an uncaught exception keeps its stack for the details', () => {
  const stack = 'TypeError: cart is undefined\n    at total (http://localhost:5173/src/cart.ts:8:3)';
  const record = exceptionRecord(
    {
      timestamp: NOW,
      exceptionDetails: {
        text: 'Uncaught',
        exception: {
          type: 'object',
          subtype: 'error',
          description: stack,
          preview: { properties: [{ name: 'stack' }] },
        },
        stackTrace: { callFrames: [{ url: 'http://localhost:5173/src/cart.ts', lineNumber: 7 }] },
      },
    },
    0,
  )!;
  assert.equal(record.level, 'error');
  assert.equal(record.message, 'Uncaught TypeError: cart is undefined');
  assert.equal(record.stack, stack);
  assert.equal(record.at, 'http://localhost:5173/src/cart.ts:8');
  const event = parseLogLine(JSON.stringify(record), 'browser', 1, new Date(NOW));
  assert.equal(event.level, 'error');
  assert.match(extractExceptions(event)[0].lines[1].text, /at total/);

  const plain = exceptionRecord(
    { exceptionDetails: { text: 'Uncaught SyntaxError: bad', url: 'http://localhost/a.js', lineNumber: 0 } },
    NOW,
  )!;
  assert.equal(plain.message, 'Uncaught SyntaxError: bad');
  assert.equal(plain.stack, undefined);
  assert.equal(plain.at, 'http://localhost/a.js:1');
  assert.equal(exceptionRecord({ exceptionDetails: {} }, NOW)?.message, 'Uncaught exception');
  assert.equal(exceptionRecord({}, NOW), undefined);
});

test("the browser's own log entries are kept, except failures a request event already reports", () => {
  const entry = {
    source: 'security',
    level: 'error',
    text: "Access to fetch at 'http://localhost:4000/api' has been blocked by CORS policy",
    timestamp: NOW,
    url: 'http://localhost:5173/',
    lineNumber: 0,
  };
  assert.deepEqual(browserLogRecord({ entry }, 'api', 0), {
    timestamp: '2026-01-02T03:04:05.000Z',
    level: 'error',
    message: entry.text,
    kind: 'browser',
    reporter: 'security',
    at: 'http://localhost:5173/:1',
  });
  const failed = {
    entry: { level: 'error', text: 'Failed to load resource: the server responded with a status of 500 ()' },
  };
  assert.equal(browserLogRecord(failed, 'api', NOW), undefined);
  assert.equal(browserLogRecord(failed, 'off', NOW)?.level, 'error');
  assert.equal(browserLogRecord({ entry: { level: 'verbose', text: 'note' } }, 'api', NOW)?.level, 'debug');
  assert.equal(browserLogRecord({ entry: { text: 'note' } }, 'api', NOW)?.level, 'info');
  assert.equal(browserLogRecord({ entry: {} }, 'api', NOW), undefined);
  assert.equal(browserLogRecord(undefined, 'api', NOW), undefined);
});

test('which requests are wanted follows the mode', () => {
  assert.equal(wantsRequest('Fetch', false, 'api'), true);
  assert.equal(wantsRequest('Document', false, 'api'), true);
  assert.equal(wantsRequest('Script', false, 'api'), false);
  assert.equal(wantsRequest('Image', true, 'api'), true);
  assert.equal(wantsRequest(undefined, false, 'api'), false);
  assert.equal(wantsRequest('Script', false, 'all'), true);
  assert.equal(wantsRequest('Fetch', true, 'off'), false);
});

test('a trace id is read from a traceparent header', () => {
  const id = '4bf92f3577b34da6a3ce929d0e0e4736';
  assert.equal(traceIdOf({ Accept: '*/*', TraceParent: `00-${id}-00f067aa0ba902b7-01` }), id);
  assert.equal(traceIdOf({ traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` }), undefined);
  assert.equal(traceIdOf({ traceparent: 'nonsense' }), undefined);
  assert.equal(traceIdOf(undefined), undefined);
});

function tracker(mode: RequestMode = 'api') {
  return new RequestTracker(() => mode);
}
const sent = (requestId: string, url: string, extra: object = {}) => ({
  requestId,
  request: { url, method: 'GET', headers: {} },
  timestamp: 100,
  wallTime: NOW / 1000,
  type: 'Fetch',
  ...extra,
});

test('a request is one record when it finishes, with fields searches already know', () => {
  const requests = tracker();
  const id = '4bf92f3577b34da6a3ce929d0e0e4736';
  assert.equal(
    requests.handle('Network.requestWillBeSent', {
      ...sent('1', 'http://localhost:4000/api/orders?page=2'),
      request: {
        url: 'http://localhost:4000/api/orders?page=2',
        method: 'POST',
        headers: { traceparent: `00-${id}-00f067aa0ba902b7-01` },
      },
    }),
    undefined,
  );
  assert.equal(requests.size, 1);
  requests.handle('Network.responseReceived', {
    requestId: '1',
    response: { status: 500, mimeType: 'application/json' },
  });
  const record = requests.handle(
    'Network.loadingFinished',
    { requestId: '1', timestamp: 100.212, encodedDataLength: 345.4 },
    '',
    0,
  )!;
  assert.deepEqual(record, {
    timestamp: new Date(NOW + 212).toISOString(),
    level: 'error',
    message: 'POST /api/orders 500 (212 ms)',
    kind: 'request',
    method: 'POST',
    url: 'http://localhost:4000/api/orders?page=2',
    path: '/api/orders',
    host: 'localhost:4000',
    status: 500,
    type: 'fetch',
    durationMs: 212,
    bytes: 345,
    contentType: 'application/json',
    traceId: id,
  });
  assert.equal(requests.size, 0);
  const event = parseLogLine(JSON.stringify(record), 'browser', 1, new Date(NOW));
  assert.equal(event.level, 'error');
  assert.equal(event.message, 'POST /api/orders 500 (212 ms)');
  assert.equal(String(getField(event, 'status')), '500');
  assert.equal(String(getField(event, 'durationMs')), '212');
  assert.equal(String(getField(event, 'traceId')), id);
});

test('levels follow the outcome, and static files are left out unless they fail', () => {
  const requests = tracker();
  const finish = (url: string, status: number, type = 'Fetch') => {
    requests.handle('Network.requestWillBeSent', sent(url, url, { type }));
    requests.handle('Network.responseReceived', { requestId: url, response: { status } });
    return requests.handle('Network.loadingFinished', { requestId: url, timestamp: 100.01 }, '', NOW);
  };
  assert.equal(finish('http://localhost/ok', 200)?.level, 'info');
  assert.equal(finish('http://localhost/missing', 404)?.level, 'warn');
  assert.equal(finish('http://localhost/app.js', 200, 'Script'), undefined);
  assert.equal(finish('http://localhost/logo.png', 404, 'Image')?.level, 'warn');
  assert.equal(tracker('all').handle('Network.loadingFinished', { requestId: 'unknown' }), undefined);
});

test('a failed request says why, and a canceled one is not an error', () => {
  const requests = tracker();
  requests.handle('Network.requestWillBeSent', sent('1', 'http://localhost:4000/api'));
  const failed = requests.handle(
    'Network.loadingFailed',
    { requestId: '1', timestamp: 100.5, errorText: 'net::ERR_CONNECTION_REFUSED' },
    '',
    NOW,
  )!;
  assert.equal(failed.level, 'error');
  assert.equal(failed.message, 'GET /api net::ERR_CONNECTION_REFUSED (500 ms)');
  assert.equal(failed.failure, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(failed.status, undefined);

  requests.handle('Network.requestWillBeSent', sent('2', 'http://localhost:4000/api'));
  const blocked = requests.handle(
    'Network.loadingFailed',
    { requestId: '2', errorText: 'net::ERR_FAILED', blockedReason: 'csp' },
    '',
    NOW,
  )!;
  assert.equal(blocked.failure, 'csp');
  assert.equal(blocked.durationMs, undefined);

  requests.handle('Network.requestWillBeSent', sent('3', 'http://localhost:4000/api'));
  const canceled = requests.handle(
    'Network.loadingFailed',
    { requestId: '3', errorText: 'net::ERR_ABORTED', canceled: true },
    '',
    NOW,
  )!;
  assert.equal(canceled.level, 'info');
  assert.equal(canceled.failure, 'canceled');

  requests.handle('Network.requestWillBeSent', sent('4', 'http://localhost/app.js', { type: undefined }));
  assert.equal(
    requests.handle('Network.loadingFailed', { requestId: '4', type: 'Script', errorText: 'x', canceled: true }),
    undefined,
  );
  assert.equal(requests.handle('Network.loadingFailed', { requestId: 'unknown', errorText: 'x' }), undefined);
});

test('a redirect ends the hop before it', () => {
  const requests = tracker();
  requests.handle('Network.requestWillBeSent', sent('1', 'http://localhost/old', { type: 'Document' }));
  const hop = requests.handle(
    'Network.requestWillBeSent',
    sent('1', 'http://localhost/new', { type: 'Document', timestamp: 100.05, redirectResponse: { status: 302 } }),
    '',
    NOW,
  )!;
  assert.equal(hop.message, 'GET /old 302 (50 ms)');
  requests.handle('Network.responseReceived', { requestId: '1', response: { status: 200 }, type: 'Document' });
  assert.equal(requests.handle('Network.loadingFinished', { requestId: '1', timestamp: 100.1 }, '', NOW)?.path, '/new');
});

test('a WebSocket handshake is a request', () => {
  const requests = tracker();
  assert.equal(
    requests.handle('Network.webSocketCreated', { requestId: '1', url: 'ws://localhost:5173/hmr' }),
    undefined,
  );
  requests.handle('Network.webSocketWillSendHandshakeRequest', { requestId: '1', timestamp: 5, wallTime: NOW / 1000 });
  const record = requests.handle(
    'Network.webSocketHandshakeResponseReceived',
    { requestId: '1', timestamp: 5.004, response: { status: 101 } },
    '',
    0,
  )!;
  assert.equal(record.message, 'GET /hmr 101 (4 ms)');
  assert.equal(record.type, 'websocket');
  assert.equal(requests.handle('Network.webSocketCreated', { requestId: '2', url: 'about:blank' }), undefined);
  assert.equal(requests.handle('Network.webSocketWillSendHandshakeRequest', { requestId: '9' }), undefined);
  assert.equal(requests.handle('Network.webSocketHandshakeResponseReceived', { requestId: '9' }), undefined);
  assert.equal(requests.size, 0);
});

test('requests of other schemes, other tabs, and an off mode are ignored', () => {
  const requests = tracker();
  requests.handle('Network.requestWillBeSent', sent('1', 'data:text/plain,hi'));
  assert.equal(requests.size, 0);
  requests.handle('Network.requestWillBeSent', sent('1', 'http://localhost/a'), 'tab-a');
  requests.handle('Network.requestWillBeSent', sent('1', 'http://localhost/b'), 'tab-b');
  assert.equal(requests.size, 2);
  assert.equal(
    requests.handle('Network.loadingFinished', { requestId: '1', timestamp: 101 }, 'tab-b', NOW)?.path,
    '/b',
  );
  requests.clear('tab-a');
  assert.equal(requests.size, 0);
  assert.equal(requests.handle('Network.dataReceived', { requestId: '1' }), undefined);
  assert.equal(requests.handle('Network.responseReceived', { requestId: 'unknown', response: {} }), undefined);
  assert.equal(requests.handle('Network.requestWillBeSent', { nothing: true }), undefined);
  const off = tracker('off');
  off.handle('Network.requestWillBeSent', sent('1', 'http://localhost/a'));
  assert.equal(off.size, 0);
});

test('requests in flight are bounded', () => {
  const requests = tracker();
  for (let index = 0; index < 2100; index++)
    requests.handle('Network.requestWillBeSent', sent(String(index), `http://localhost/${index}`));
  assert.equal(requests.size, 2000);
  assert.equal(requests.handle('Network.loadingFinished', { requestId: '0', timestamp: 101 }), undefined);
  assert.equal(
    requests.handle('Network.loadingFinished', { requestId: '2099', timestamp: 101 }, '', NOW)?.path,
    '/2099',
  );
  const sockets = tracker();
  for (let index = 0; index < 2001; index++)
    sockets.handle('Network.webSocketCreated', { requestId: String(index), url: 'ws://localhost/s' });
  assert.equal(sockets.size, 2000);
});

test('local addresses are found in dev server output', () => {
  assert.deepEqual(
    localUrls(
      '  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m\n  ➜  Network: http://192.168.1.4:5173/',
    ),
    ['http://localhost:5173/'],
  );
  assert.deepEqual(localUrls('Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)'), [
    'http://localhost:8000',
  ]);
  assert.deepEqual(localUrls('listening at https://127.0.0.1:3443/app, and http://[::1]:3000.'), [
    'https://127.0.0.1:3443/app',
    'http://[::1]:3000',
  ]);
  assert.deepEqual(localUrls('see https://example.com/docs'), []);
  assert.equal(
    localUrls(Array.from({ length: 30 }, (_, index) => `http://localhost:${3000 + index}`).join(' ')).length,
    10,
  );
});

test('a typed address becomes one a browser can open', () => {
  assert.equal(browserUrl(' localhost:3000 '), 'http://localhost:3000/');
  assert.equal(browserUrl('https://app.test/login?next=/'), 'https://app.test/login?next=/');
  assert.equal(browserUrl('file:///etc/passwd'), undefined);
  assert.equal(browserUrl('javascript://alert(1)'), undefined);
  assert.equal(browserUrl('two words'), undefined);
  assert.equal(browserUrl(''), undefined);
  assert.equal(browserUrl('http://'), undefined);
  assert.equal(browserUrl(`http://localhost/${'a'.repeat(3000)}`), undefined);
});

test('a site is one source', () => {
  assert.deepEqual(browserSource('http://localhost:5173/cart'), {
    serverId: 'browser:localhost:5173',
    server: 'Browser · localhost:5173',
  });
  assert.deepEqual(browserSource('nonsense'), { serverId: 'browser:nonsense', server: 'Browser · nonsense' });
});

test('a response the page never reads is reported after a while, with the time its headers took', () => {
  const requests = tracker();
  requests.handle('Network.requestWillBeSent', sent('1', 'http://localhost/api/boom'), 'tab-1');
  requests.handle('Network.requestWillBeSent', sent('2', 'http://localhost/api/waiting'), 'tab-1');
  requests.handle(
    'Network.responseReceived',
    { requestId: '1', timestamp: 100.03, response: { status: 500 } },
    'tab-1',
    NOW,
  );
  assert.deepEqual(requests.sweep(NOW + 1999), []);
  const [[tab, record], ...others] = requests.sweep(NOW + 2000);
  assert.equal(tab, 'tab-1');
  assert.equal(record.message, 'GET /api/boom 500 (30 ms)');
  assert.equal(record.level, 'error');
  assert.equal(record.bytes, undefined);
  assert.deepEqual(others, []);
  assert.deepEqual(requests.sweep(NOW + 9000), [], 'reported once');
  // Its end, when the browser does report it, is not a second event, and it is forgotten then.
  assert.equal(requests.handle('Network.loadingFinished', { requestId: '1', timestamp: 109 }, 'tab-1'), undefined);
  assert.equal(requests.size, 1, 'a request without an answer keeps waiting');

  requests.handle('Network.requestWillBeSent', sent('3', 'http://localhost/app.js', { type: 'Script' }), 'tab-1');
  requests.handle(
    'Network.responseReceived',
    { requestId: '3', timestamp: 100.01, response: { status: 200 } },
    'tab-1',
    NOW,
  );
  assert.deepEqual(requests.sweep(NOW + 5000), [], 'still only the requests the mode wants');
  assert.equal(requests.size, 1);
});

test('a response still streaming is left until it ends, and a failure after a quiet spell is still reported', () => {
  const requests = tracker();
  const answer = (id: string) => {
    requests.handle('Network.requestWillBeSent', sent(id, `http://localhost/api/${id}`));
    requests.handle(
      'Network.responseReceived',
      { requestId: id, timestamp: 100.04, response: { status: 200 } },
      '',
      NOW,
    );
  };
  // A completion streamed for ten seconds, a chunk a second, that then breaks.
  answer('chat');
  for (let second = 1; second <= 10; second++) {
    requests.handle('Network.dataReceived', { requestId: 'chat' }, '', NOW + second * 1000);
    assert.deepEqual(requests.sweep(NOW + second * 1000 + 900), []);
  }
  const broken = requests.handle(
    'Network.loadingFailed',
    { requestId: 'chat', timestamp: 110, errorText: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' },
    '',
    NOW,
  )!;
  assert.equal(broken.message, 'GET /api/chat net::ERR_INCOMPLETE_CHUNKED_ENCODING (10000 ms)');
  assert.equal(broken.level, 'error');
  assert.equal(broken.status, 200);

  // A stream that goes quiet is reported as answered; when it later fails, that is reported too.
  answer('events');
  assert.equal(requests.sweep(NOW + 2000).length, 1);
  const dropped = requests.handle(
    'Network.loadingFailed',
    { requestId: 'events', timestamp: 160, errorText: 'net::ERR_CONNECTION_RESET' },
    '',
    NOW,
  )!;
  assert.equal(dropped.message, 'GET /api/events net::ERR_CONNECTION_RESET (60000 ms)');
  assert.equal(requests.size, 0);

  // One the page dropped unread, reported already, ends without another event.
  answer('unread');
  requests.sweep(NOW + 2000);
  assert.equal(
    requests.handle('Network.loadingFailed', { requestId: 'unread', errorText: 'net::ERR_ABORTED', canceled: true }),
    undefined,
  );
  assert.equal(requests.size, 0);
  assert.equal(requests.handle('Network.dataReceived', { requestId: 'unknown' }), undefined);
});

test('a WebSocket that never connects is reported as a failed request and forgotten', () => {
  const requests = tracker();
  requests.handle('Network.webSocketCreated', { requestId: '1', url: 'ws://localhost:4000/socket' });
  requests.handle('Network.webSocketWillSendHandshakeRequest', { requestId: '1', timestamp: 5, wallTime: NOW / 1000 });
  const refused = requests.handle(
    'Network.webSocketFrameError',
    { requestId: '1', timestamp: 5.01, errorMessage: 'Error in connection establishment: net::ERR_CONNECTION_REFUSED' },
    '',
    NOW,
  )!;
  assert.equal(refused.level, 'error');
  assert.equal(refused.type, 'websocket');
  assert.equal(refused.failure, 'Error in connection establishment: net::ERR_CONNECTION_REFUSED');
  assert.equal(requests.handle('Network.webSocketClosed', { requestId: '1', timestamp: 5.02 }), undefined);

  requests.handle('Network.webSocketCreated', { requestId: '2', url: 'ws://localhost:4000/socket' });
  const closed = requests.handle('Network.webSocketClosed', { requestId: '2', timestamp: 6 }, '', NOW)!;
  assert.equal(closed.message, 'GET /socket closed before it connected');
  assert.equal(requests.size, 0);

  // One that connected has been reported; its close later is not a failure. Nor is an HTTP request's.
  requests.handle('Network.webSocketCreated', { requestId: '3', url: 'ws://localhost:4000/socket' });
  requests.handle('Network.webSocketHandshakeResponseReceived', { requestId: '3', response: { status: 101 } });
  assert.equal(requests.handle('Network.webSocketClosed', { requestId: '3' }), undefined);
  requests.handle('Network.requestWillBeSent', sent('4', 'http://localhost/api'));
  assert.equal(requests.handle('Network.webSocketClosed', { requestId: '4' }), undefined);
  assert.equal(requests.size, 1);
});

test('a rejection nothing handled says so, unlike a throw', () => {
  const rejected = exceptionRecord(
    {
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        exception: { subtype: 'error', description: 'Error: no stock\n    at buy (http://localhost/a.js:3:9)' },
      },
    },
    NOW,
  )!;
  assert.equal(rejected.message, 'Uncaught (in promise) Error: no stock');
  assert.equal(
    exceptionRecord({ exceptionDetails: { text: 'Uncaught (in promise)' } }, NOW)!.message,
    'Uncaught (in promise)',
  );
  const thrown = { subtype: 'error', description: 'Error: x' };
  assert.equal(
    exceptionRecord({ exceptionDetails: { text: 'Script error.', exception: thrown } }, NOW)!.message,
    'Uncaught Error: x',
  );
});

test('addresses of other machines that start like a local one are not local, and terminal links are read plainly', () => {
  assert.deepEqual(localUrls('see http://localhost.example.com/app and http://127.0.0.1.nip.io:3000/'), []);
  assert.deepEqual(localUrls('open http://localhost-proxy:8080'), []);
  assert.deepEqual(localUrls('ready at http://localhost:3000. Then http://localhost.'), [
    'http://localhost:3000',
    'http://localhost',
  ]);
  assert.deepEqual(
    localUrls('\u001b]8;;http://localhost:5173/\u001b\\http://localhost:5173/\u001b]8;;\u001b\\ ready'),
    ['http://localhost:5173/'],
  );
  assert.deepEqual(
    localUrls('\u001b]8;;http://localhost:4000/a\u0007http://localhost:4000/a\u001b]8;;\u0007\u001b[2K\u001b[1G'),
    ['http://localhost:4000/a'],
  );
});

test('a request canceled after it was answered keeps its answer', () => {
  const requests = tracker();
  requests.handle('Network.requestWillBeSent', sent('1', 'http://localhost/api/gone'));
  requests.handle('Network.responseReceived', { requestId: '1', timestamp: 100.002, response: { status: 404 } });
  const record = requests.handle(
    'Network.loadingFailed',
    { requestId: '1', timestamp: 100.004, errorText: 'net::ERR_ABORTED', canceled: true },
    '',
    NOW,
  )!;
  assert.equal(record.message, 'GET /api/gone 404 (4 ms)');
  assert.equal(record.level, 'warn');
  assert.equal(record.failure, undefined);
});
