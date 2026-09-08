import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExceptions, parseSourceLocation } from './exceptions';
import { parseLogLine } from './log-event';

const exception = (value: unknown) => extractExceptions(parseLogLine(JSON.stringify(value), 'stdout', 1, new Date()));

test('JSON exception stacks become readable frames and retain nested causes', () => {
  const blocks = exception({ message: 'Checkout failed', err: { type: 'Error', message: 'Payment failed',
    stack: 'Error: Payment failed\n    at pay (/work/src/pay.ts:42:9)',
    cause: { name: 'TimeoutError', message: 'Timed out', stack: 'TimeoutError: Timed out\n    at retry (src/retry.ts:8:2)' } } });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].title, 'Error: Payment failed');
  assert.deepEqual(blocks[0].lines[1].source, { file: '/work/src/pay.ts', line: 42, column: 9 });
  assert.equal(blocks[1].title, 'Caused by: TimeoutError: Timed out');
  assert.equal(blocks[1].lines[1].text, '    at retry (src/retry.ts:8:2)');
});

test('recognizes Java, Python, Windows, and file URI source locations', () => {
  for (const [text, file, line, column] of [
    ['    at com.example.Service.run(Service.java:27)', 'Service.java', 27, 1],
    ['  File "/work/my app/main.py", line 12, in run', '/work/my app/main.py', 12, 1],
    ['    at run (C:\\work\\main.ts:42:9)', 'C:\\work\\main.ts', 42, 9],
    ['    at file:///work/my%20app/main.js:7:4', '/work/my app/main.js', 7, 4],
    ['    at run (/work/my app/main.js:7:4)', '/work/my app/main.js', 7, 4]
  ] as const) assert.deepEqual(parseSourceLocation(text), { file, line, column });
});

test('rejects remote, command, internal, and invalid source locations', () => {
  for (const text of ['at https://example.com/main.js:1:1', 'at command:run.ts:1:1',
    'at node:internal/main.js:1:1', 'at file://remote/work/main.js:1:1', 'at main.js:0:1', 'at main.js:1:0',
    'at main.js:999999999999999999:1', 'at native']) assert.equal(parseSourceLocation(text), undefined, text);
});

test('supports Log4j2 structured throwable frames and OpenTelemetry exception fields', () => {
  const blocks = exception({ thrown: { name: 'java.lang.RuntimeException', message: 'Failed',
    extendedStackTrace: [{ class: 'app.Service', method: 'run', file: 'Service.java', line: 27 }],
    cause: { name: 'java.io.IOException', message: 'Connection lost' } } });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lines[0].source?.line, 27);
  assert.match(blocks[1].title, /Caused by: java.io.IOException/);
  assert.equal(exception({ 'exception.type': 'Error', 'exception.message': 'Failed', 'exception.stacktrace': 'Error\n at main.js:1:2' })[0].lines.length, 2);
});

test('array-shaped stack fields are joined into frame lines', () => {
  const blocks = exception({ err: { message: 'boom', stack: ['at foo (a.js:1:1)', 'at bar (b.js:2:2)'] } });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[0].lines[0].source?.file, 'a.js');
  assert.equal(blocks[0].lines[1].source?.file, 'b.js');
});

test('ordinary JSON is unaffected and exception previews stay bounded', () => {
  assert.deepEqual(exception({ message: 'Hello', status: 200 }), []);
  assert.deepEqual(exception(null), []);
  const blocks = exception({ error: { stack: 'at main.js:1:2\n'.repeat(10000) } });
  assert.ok(blocks[0].lines.length <= 301);
  assert.equal(blocks[0].lines.at(-1)?.text, '[Exception preview truncated]');
  let cause: unknown = { message: 'root cause' };
  for (let i = 0; i < 30; i++) cause = { message: 'wrapper', cause };
  assert.ok(exception({ error: cause }).length <= 8);
});

test('an error-level event without an exception key is not treated as an exception', () => {
  // The pre-test that lets ordinary events skip JSON parsing keys off `"error":`
  // as a field name, so a level *value* of "error" must not trip it.
  assert.deepEqual(exception({ level: 'error', message: 'request failed', service: 'errors' }), []);
  assert.deepEqual(exception({ level: 'error', message: 'no stack here', errorCount: 3 }), []);
  assert.equal(exception({ level: 'error', error: { name: 'E', stack: 'E: x\n    at f (/a/b.js:1:2)' } }).length, 1,
    'a real error field still yields a block');
  assert.equal(exception({ message: 'boom', 'exception.stacktrace': 'at a(A.java:9)' }).length, 1,
    'dotted Log4j2 exception keys still yield a block');
  assert.equal(exception({ message: 'Traceback (most recent call last):\n  File "a.py", line 3\nValueError: v' }).length, 1,
    'a traceback embedded in the message still yields a block');
});
