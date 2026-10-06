import assert from 'node:assert/strict';
import test from 'node:test';
import { StackJoiner } from './capture/stack-joiner';
import { parseLogLine } from './core/log-event';
import { groupErrors } from './core/log-analysis';
import { extractExceptions } from './core/exceptions';

function join(lines: string[], limit?: number): string[] {
  const out: string[] = [];
  const joiner = new StackJoiner(line => out.push(line), limit, 0);
  for (const line of lines) joiner.write(line, false);
  joiner.end();
  return out;
}

test('Java and Node stack traces become one event per exception', () => {
  assert.deepEqual(join([
    'INFO starting',
    'Exception in thread "main" java.lang.IllegalStateException: boom',
    '\tat com.example.App.run(App.java:42)',
    '\tat com.example.App.main(App.java:10)',
    'Caused by: java.io.IOException: disk full',
    '\tat com.example.Store.write(Store.java:7)',
    '\t... 2 more',
    'Error: request failed',
    '    at handler (/srv/app.js:12:5)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'INFO recovered'
  ]), [
    'INFO starting',
    'Exception in thread "main" java.lang.IllegalStateException: boom\n\tat com.example.App.run(App.java:42)\n\tat com.example.App.main(App.java:10)\nCaused by: java.io.IOException: disk full\n\tat com.example.Store.write(Store.java:7)\n\t... 2 more',
    'Error: request failed\n    at handler (/srv/app.js:12:5)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'INFO recovered'
  ]);
});

test('Python tracebacks, including chained ones, end at the exception line', () => {
  assert.deepEqual(join([
    'ERROR:root:job failed',
    'Traceback (most recent call last):',
    '  File "/app/job.py", line 3, in <module>',
    '    run()',
    'KeyError: \'id\'',
    // Line readers drop the blank line Python prints between chained tracebacks.
    'During handling of the above exception, another exception occurred:',
    'Traceback (most recent call last):',
    '  File "/app/job.py", line 5, in <module>',
    'ValueError: bad input',
    '  indented output after the trace',
  ]), [
    'ERROR:root:job failed\nTraceback (most recent call last):\n  File "/app/job.py", line 3, in <module>\n    run()\nKeyError: \'id\'\n'
      + 'During handling of the above exception, another exception occurred:\nTraceback (most recent call last):\n  File "/app/job.py", line 5, in <module>\nValueError: bad input',
    '  indented output after the trace'
  ]);
});

test('JSON lines are never held or joined, and ordering is preserved', () => {
  assert.deepEqual(join(['Error: x', '{"level":"info","message":"json"}', '    at f (a.js:1:1)']),
    ['Error: x', '{"level":"info","message":"json"}', '    at f (a.js:1:1)']);
});

test('a joined trace never exceeds the line limit', () => {
  const frames = Array.from({ length: 10 }, (_, i) => `    at f${i} (a.js:${i + 1}:1)`);
  const out = join(['Error: x', ...frames], 60);
  assert.ok(out.length > 1);
  for (const line of out) assert.ok(line.length <= 60, line);
  assert.equal(out.join('\n'), ['Error: x', ...frames].join('\n'));
});

test('held lines are released by the flush timer', async () => {
  const out: string[] = [];
  const joiner = new StackJoiner(line => out.push(line), undefined, 10);
  joiner.write('Error: x', false);
  joiner.write('    at f (a.js:1:1)', false);
  assert.deepEqual(out, []);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(out, ['Error: x\n    at f (a.js:1:1)']);
});

test('a joined trace shows its first line and feeds exception grouping', () => {
  const raw = 'Error: request failed\n    at handler (/srv/app.js:12:5)';
  const event = parseLogLine(raw, 'stderr', 1, new Date());
  assert.equal(event.message, 'Error: request failed');
  assert.equal(event.raw, raw);
  const [group] = groupErrors([event, { ...parseLogLine(raw.replace('12:5', '12:5'), 'stderr', 2, new Date()) }]);
  assert.equal(group.count, 2);
  assert.equal(group.location, '/srv/app.js:12');
});

// Line readers drop blank lines, so Node's crash output arrives without them.
const nodeCrash = [
  '/srv/app/server.js:12',
  '    const total = order.items.reduce(sum);',
  '                              ^',
  'TypeError: Cannot read properties of undefined (reading \'reduce\')',
  '    at checkout (/srv/app/server.js:12:31)',
  '    at /srv/app/server.js:40:5',
  'Node.js v22.22.0'
];

test('a Node crash block becomes one event with its header, frames and version', () => {
  assert.deepEqual(join(['{"level":50,"msg":"checkout failed"}', ...nodeCrash, 'next line']),
    ['{"level":50,"msg":"checkout failed"}', nodeCrash.join('\n'), 'next line']);
});

test('Node crash shapes: error properties, ESM URLs, internal locations and thrown values', () => {
  const properties = [
    '/srv/app/db.js:1',
    'throw e;',
    '^',
    'Error: connect ECONNREFUSED 127.0.0.1:5432',
    '    at Object.<anonymous> (/srv/app/db.js:1:11)',
    '    at node:internal/main/run_main_module:36:49 {',
    '  code: \'ECONNREFUSED\',',
    '  meta: { a: {',
    '    b: 1',
    '  } }',
    '}',
    'Node.js v22.22.0'
  ];
  const esm = ['file:///srv/app/main.mjs:1', 'await start();', '^', 'RangeError: bad', '    at file:///srv/app/main.mjs:1:22'];
  const thrown = ['/srv/app/str.js:1', 'throw \'boom\';', '^', 'boom', '(Use `node --trace-uncaught ...` to show where the exception was thrown)', 'Node.js v22.22.0'];
  const internal = ['node:internal/process/promises:394', '    triggerUncaughtException(err, true /* fromPromise */);', '    ^', 'Error: x', '    at f (/srv/a.js:1:1)'];
  for (const block of [properties, esm, thrown, internal]) assert.deepEqual(join([...block, 'after']), [block.join('\n'), 'after']);
});

test('a path:line line that does not start a crash block is released line by line', () => {
  assert.deepEqual(join(['/srv/app/server.js:12', 'listening on 3000', 'ready']), ['/srv/app/server.js:12', 'listening on 3000', 'ready']);
  assert.deepEqual(join(['/srv/app/server.js:12']), ['/srv/app/server.js:12']);
  assert.deepEqual(join(['/srv/app/server.js:12', '{"level":"info"}', 'x']), ['/srv/app/server.js:12', '{"level":"info"}', 'x']);
  // A replayed line can start a trace of its own.
  assert.deepEqual(join(['/srv/app/server.js:12', 'Error: x', '    at f (a.js:1:1)']), ['/srv/app/server.js:12', 'Error: x\n    at f (a.js:1:1)']);
  // `Node.js v…` and error properties only continue a trace.
  assert.deepEqual(join(['starting', 'Node.js v22.22.0']), ['starting', 'Node.js v22.22.0']);
});

test('a JSON line after a path:line line is delivered at once', () => {
  const out: string[] = [];
  const joiner = new StackJoiner(line => out.push(line), undefined, 0);
  joiner.write('/srv/app/server.js:12', false);
  joiner.write('{"level":"info","msg":"ready"}', false);
  assert.deepEqual(out, ['/srv/app/server.js:12', '{"level":"info","msg":"ready"}']);
  // A source line that only starts with a bracket still forms a crash block.
  const block = ['/srv/app/a.js:3', '[a, b] = pair();', '^', 'TypeError: pair is not a function', '    at /srv/app/a.js:3:10'];
  assert.deepEqual(join(block), [block.join('\n')]);
});

test('lines replayed from an unconfirmed crash block keep their own metadata', () => {
  const out: [string, string | undefined][] = [];
  const joiner = new StackJoiner<string>((line, _truncated, meta) => out.push([line, meta]), undefined, 0);
  joiner.write('/srv/app/server.js:12', false, 'first');
  joiner.write('listening on 3000', false, 'second');
  joiner.end();
  assert.deepEqual(out, [['/srv/app/server.js:12', 'first'], ['listening on 3000', 'second']]);
});

test('an unconfirmed crash block is split when the flush timer fires', async () => {
  const out: string[] = [];
  const joiner = new StackJoiner(line => out.push(line), undefined, 10);
  joiner.write('/srv/app/server.js:12', false);
  joiner.write('const x = 1;', false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(out, ['/srv/app/server.js:12', 'const x = 1;']);
});

test('a Node crash shows its error line and is an error', () => {
  const raw = nodeCrash.join('\n');
  const event = parseLogLine(raw, 'terminal', 1, new Date());
  assert.equal(event.message, 'TypeError: Cannot read properties of undefined (reading \'reduce\')');
  assert.equal(event.level, 'error');
  assert.equal(event.raw, raw);
  const [group] = groupErrors([event]);
  assert.equal(group.location, '/srv/app/server.js:12');
  const thrown = parseLogLine('/srv/app/str.js:1\nthrow \'boom\';\n^\nboom', 'terminal', 2, new Date());
  assert.equal(thrown.message, 'boom');
  assert.equal(thrown.level, 'error');
});

test('joined traces headed by an exception are errors; single lines keep their level', () => {
  const level = (raw: string) => parseLogLine(raw, 'terminal', 1, new Date()).level;
  assert.equal(level('TypeError: x\n    at f (a.js:1:1)'), 'error');
  assert.equal(level('java.lang.IllegalStateException: boom\n\tat com.example.App.run(App.java:42)'), 'error');
  assert.equal(level('WARN retrying\n    at f (a.js:1:1)'), 'warn');
  assert.equal(level('TypeError: x'), 'unclassified');
  assert.equal(level('compiled successfully\nin 2s'), 'unclassified');
});

test('frames of a joined TypeError trace are clickable', () => {
  const [block] = extractExceptions(parseLogLine('TypeError: x\n    at f (/srv/a.js:3:7)', 'terminal', 1, new Date()));
  assert.deepEqual(block?.lines[1].source, { file: '/srv/a.js', line: 3, column: 7 });
});
