import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJobLog, splitStamp, testFailures, type CiJob } from './ci-log';

const ESC = String.fromCharCode(27);
const job: CiJob = { run: 12, runId: 99, workflow: 'CI', job: 'test', jobId: 7 };
const T = '2026-11-14T07:33:08.0074740Z';

test('splitStamp takes GitHub’s time prefix, strips colours and carriage returns', () => {
  assert.deepEqual(splitStamp(`${T} hello`), { time: '2026-11-14T07:33:08.007Z', text: 'hello' });
  assert.equal(splitStamp(`${T} ${ESC}[31mred${ESC}[0m\r`).text, 'red');
  assert.deepEqual(splitStamp('no stamp\r'), { text: 'no stamp' });
});

test('parseJobLog marks steps, levels, and drops empty and endgroup lines', () => {
  const log = [
    `${T} ##[group]Run npm test`,
    `${T} running`,
    `${T} ##[endgroup]`,
    '',
    'continued without stamp',
    `${T} ##[warning]careful`,
    `${T} [warn] src/a.ts`,
    `${T} npm ERR! boom`,
    `${T} ##[error]Process completed with exit code 1.`,
  ].join('\n');
  const records = parseJobLog(log, job);
  assert.deepEqual(
    records.map((r) => [r.level, r.message, r.step]),
    [
      ['info', 'Run npm test', 'Run npm test'],
      ['info', 'running', 'Run npm test'],
      ['info', 'continued without stamp', 'Run npm test'],
      ['warn', 'careful', 'Run npm test'],
      ['warn', '[warn] src/a.ts', 'Run npm test'],
      ['error', 'npm ERR! boom', 'Run npm test'],
      ['error', 'Process completed with exit code 1.', 'Run npm test'],
    ],
  );
  assert.equal(records[2].timestamp, '2026-11-14T07:33:08.007Z');
  assert.equal(records[0].run, 12);
  assert.equal(records[0].workflow, 'CI');
  assert.equal(records[0].job, 'test');
  assert.equal(records[0].kind, 'ci');
  assert.equal('branch' in records[0], false);
});

test('parseJobLog carries branch, short sha, conclusion and url', () => {
  const [record] = parseJobLog(`${T} hi`, {
    ...job,
    branch: 'main',
    sha: '0123456789abcdef',
    conclusion: 'failure',
    url: 'https://github.com/o/r/runs/1',
  });
  assert.equal(record.branch, 'main');
  assert.equal(record.sha, '0123456');
  assert.equal(record.conclusion, 'failure');
  assert.equal(record.url, 'https://github.com/o/r/runs/1');
});

test('testFailures reads Vitest', () => {
  const [f] = testFailures(['FAIL  src/table.test.ts > viewer > level > INFO is not bold']);
  assert.deepEqual(f, {
    test: 'viewer › level › INFO is not bold',
    framework: 'vitest',
    file: 'src/table.test.ts',
    index: 0,
  });
});

test('testFailures reads Jest with its file header', () => {
  const [f] = testFailures(['FAIL src/cart.test.js', '  ✕ adds items (5 ms)']);
  assert.equal(f.test, 'adds items');
  assert.equal(f.framework, 'jest');
  assert.equal(f.file, 'src/cart.test.js');
});

test('testFailures reads node:test but not its summary, and each test once', () => {
  const failures = testFailures(['✖ failing tests:', '✖ parses input (12.3ms)', '✖ parses input (12.3ms)']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].test, 'parses input');
  assert.equal(failures[0].framework, 'node');
});

test('testFailures reads TAP with its location on every runner OS', () => {
  const rel = 'out-tests/capture/browser-capture.test.js';
  const cases = [
    `/home/runner/work/logline/logline/${rel}:78:3`,
    `/Users/runner/work/logline/logline/${rel}:78:3`,
    `D:\\\\a\\\\logline\\\\logline\\\\out-tests\\\\capture\\\\browser-capture.test.js:78:3`,
  ];
  for (const path of cases) {
    const [f] = testFailures([
      'not ok 8 - a browser that reports no tab gets one opened',
      '  ---',
      `  location: '${path}'`,
    ]);
    assert.equal(f.framework, 'tap');
    assert.equal(f.file, rel, path);
    assert.equal(f.line, 78, path);
  }
});

test('testFailures reads pytest, go, Maven and dotnet', () => {
  const failures = testFailures([
    'FAILED tests/test_cart.py::TestCart::test_total - AssertionError',
    '--- FAIL: TestTotal (0.00s)',
    '    cart_test.go:42: want 3',
    '[ERROR] testTotal(com.shop.CartTest)  Time elapsed: 0.01 s  <<< FAILURE!',
    '  Failed Shop.Tests.CartTests.Total [12 ms]',
  ]);
  assert.deepEqual(
    failures.map((f) => [f.test, f.framework, f.file, f.line]),
    [
      ['TestCart › test_total', 'pytest', 'tests/test_cart.py', undefined],
      ['TestTotal', 'go', 'cart_test.go', 42],
      ['com.shop.CartTest › testTotal', 'junit', undefined, undefined],
      ['Shop.Tests.CartTests.Total', 'dotnet', undefined, undefined],
    ],
  );
});

test('testFailures ignores a location in another file and stops at the next failure', () => {
  const other = testFailures([
    'FAIL  src/a.test.ts > one',
    '    at src/b.test.ts:10:5',
    'FAIL  src/a.test.ts > two',
    '    at src/a.test.ts:20:5',
  ]);
  assert.equal(other[0].line, undefined);
  assert.equal(other[1].line, 20);
  const next = testFailures(['not ok 1 - first', 'not ok 2 - second', "  location: 'src/x.test.js:5:1'"]);
  assert.equal(next[0].file, undefined);
  assert.equal(next[1].line, 5);
});

test('parseJobLog adds a record per failed test', () => {
  const log = [`${T} ##[group]Run npm test`, `2026-11-14T07:34:00.000Z ✖ parses input (1.2ms)`].join('\n');
  const records = parseJobLog(log, job);
  const failure = records.find((r) => r.kind === 'test-failure')!;
  assert.equal(failure.level, 'error');
  assert.equal(failure.message, '✕ parses input');
  assert.equal(failure.step, 'Run npm test');
  assert.equal(failure.timestamp, '2026-11-14T07:34:00.000Z');
  assert.equal(failure.test, 'parses input');
  assert.equal(failure.framework, 'node');
  assert.equal(failure.job, 'test');
});
