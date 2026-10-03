import assert from 'node:assert/strict';
import test from 'node:test';
import { StackJoiner } from './capture/stack-joiner';
import { parseLogLine } from './core/log-event';
import { groupErrors } from './core/log-analysis';

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
