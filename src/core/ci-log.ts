// A CI job's log as log events: GitHub Actions writes each line with a time,
// marks steps with ##[group], and errors with ##[error]. Test failures in the
// output of common test runners become events of their own, with the test's
// name and, when the output gives it, the file and line.

/** Where a job's log came from, kept on each of its events. */
export interface CiJob {
  /** The run's number in its workflow, as GitHub shows it: `#4812`. */
  run: number;
  runId: number;
  workflow: string;
  job: string;
  jobId: number;
  branch?: string;
  sha?: string;
  /** `failure`, `success`, `cancelled`, … */
  conclusion?: string;
  url?: string;
}

export interface CiRecord {
  timestamp?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  kind: 'ci' | 'test-failure';
  run: number;
  workflow: string;
  job: string;
  step?: string;
  branch?: string;
  sha?: string;
  conclusion?: string;
  url?: string;
  test?: string;
  file?: string;
  line?: number;
  framework?: string;
  [field: string]: unknown;
}

export interface TestFailure {
  test: string;
  framework: string;
  file?: string;
  line?: number;
  /** The line of the log it was found on. */
  index: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?/;
const MAX_LINE = 4000;
const MAX_TEST = 300;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** One line of a job log: its time and its text without colours. */
export function splitStamp(line: string): { time?: string; text: string } {
  const match = STAMP.exec(line);
  const rest = match ? line.slice(match[0].length) : line;
  const text = stripAnsi(rest.replace(/\r$/, ''));
  return match ? { time: new Date(Date.parse(match[1])).toISOString(), text } : { text };
}

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}…` : text);

/** A test file named in a stack trace or a runner's output: `src/table.test.ts:118:31`. */
const LOCATION =
  /((?:[A-Za-z]:)?[\w./\\@-]*?(?:test|spec|Test|Tests)[\w.-]*\.(?:[cm]?[jt]sx?|py|go|java|kt|cs|rb|rs))[:(](\d+)/;

function location(text: string): { file: string; line: number } | undefined {
  const match = LOCATION.exec(text);
  if (!match) return undefined;
  // Paths in the runner's checkout, on Linux, macOS, and Windows, become paths in the repository.
  const file = match[1]
    .replace(/\\+/g, '/')
    .replace(
      /^(?:\.\/|\/home\/runner\/work\/[^/]+\/[^/]+\/|\/Users\/runner\/work\/[^/]+\/[^/]+\/|[A-Za-z]:\/a\/[^/]+\/[^/]+\/)/,
      '',
    );
  return { file, line: Number(match[2]) };
}

/** The failures the test runners in a log reported, each test once, with its file and line when given. */
export function testFailures(lines: readonly string[]): TestFailure[] {
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  let jestFile: string | undefined;
  const add = (index: number, test: string, framework: string, place?: { file: string; line?: number }) => {
    const name = clip(test.trim(), MAX_TEST);
    if (!name || seen.has(name)) return;
    seen.add(name);
    failures.push({
      test: name,
      framework,
      index,
      ...(place?.file ? { file: place.file } : {}),
      ...(place?.line ? { line: place.line } : {}),
    });
  };
  lines.forEach((text, index) => {
    let match: RegExpExecArray | null;
    if ((match = /^\s*(?:FAIL|PASS)\s+(\S+\.(?:[cm]?[jt]sx?))(?:\s|$)/.exec(text)) && !text.includes(' > '))
      jestFile = match[0].trimStart().startsWith('FAIL') ? match[1] : undefined;
    // Vitest: FAIL  src/table.test.ts > viewer > level column > INFO is not bold
    if ((match = /^\s*FAIL\s+(\S+)\s+>\s+(.+)$/.exec(text)))
      add(index, match[2].replace(/\s+>\s+/g, ' › '), 'vitest', { file: match[1] });
    // Jest and Vitest: ✕ name (12 ms), × name
    else if ((match = /^\s*[✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/.exec(text)))
      add(index, match[1], jestFile ? 'jest' : 'vitest', jestFile ? { file: jestFile } : undefined);
    // node:test: ✖ name (12.3ms), but not its summary line
    else if (
      (match = /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/.exec(text)) &&
      !/^failing tests:?$/i.test(match[1])
    )
      add(index, match[1], 'node');
    // TAP, as node:test writes it in CI: not ok 8 - a browser that reports no tab gets one opened
    else if ((match = /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(text))) add(index, match[1], 'tap');
    // pytest: FAILED tests/test_cart.py::test_total - AssertionError
    else if ((match = /^\s*FAILED\s+([\w./\\-]+\.py)::(\S+)/.exec(text)))
      add(index, match[2].replace(/::/g, ' › '), 'pytest', { file: match[1] });
    // go test: --- FAIL: TestTotal (0.00s)
    else if ((match = /^\s*--- FAIL:\s+(\S+)/.exec(text))) add(index, match[1], 'go');
    // Maven Surefire: [ERROR] testTotal(com.shop.CartTest)  Time elapsed: … <<< FAILURE!
    else if ((match = /^\s*(?:\[ERROR\]\s+)?(\w+)\(([\w.$]+)\).*<<<\s*(?:FAILURE|ERROR)!/.exec(text)))
      add(index, `${match[2]} › ${match[1]}`, 'junit');
    // dotnet test:   Failed Shop.Tests.CartTests.Total [12 ms]
    else if ((match = /^\s*Failed\s+([\w.]+)\s+\[\d+/.exec(text))) add(index, match[1], 'dotnet');
  });
  // Where the runner gives the failing line, it follows the failure's name, before the next test.
  for (const [position, failure] of failures.entries()) {
    if (failure.line) continue;
    const end = Math.min(lines.length, failures[position + 1]?.index ?? Infinity, failure.index + 40);
    for (let index = failure.index; index < end; index++) {
      const place = location(lines[index]);
      if (!place || (failure.file && !place.file.endsWith(failure.file) && !failure.file.endsWith(place.file)))
        continue;
      failure.file = place.file;
      failure.line = place.line;
      break;
    }
  }
  return failures;
}

/** A job's whole log as events: one per line, and one per failed test. */
export function parseJobLog(log: string, job: CiJob): CiRecord[] {
  const base = {
    run: job.run,
    workflow: job.workflow,
    job: job.job,
    ...(job.branch ? { branch: job.branch } : {}),
    ...(job.sha ? { sha: job.sha.slice(0, 7) } : {}),
    ...(job.conclusion ? { conclusion: job.conclusion } : {}),
    ...(job.url ? { url: job.url } : {}),
  };
  const lines = log.split('\n');
  const texts: string[] = [];
  const times: (string | undefined)[] = [];
  const steps: (string | undefined)[] = [];
  const records: CiRecord[] = [];
  let step: string | undefined;
  let lastTime: string | undefined;
  for (const raw of lines) {
    if (!raw) continue;
    const { time, text } = splitStamp(raw);
    lastTime = time ?? lastTime;
    texts.push(text);
    times.push(lastTime);
    const group = /^##\[group\](.*)$/.exec(text);
    if (group) step = clip(group[1].trim(), 200);
    steps.push(step);
    if (text.startsWith('##[endgroup]')) continue;
    let message = text;
    let level: CiRecord['level'] = 'info';
    if (group) message = step ?? '';
    else if (text.startsWith('##[error]')) {
      level = 'error';
      message = text.slice(9);
    } else if (text.startsWith('##[warning]')) {
      level = 'warn';
      message = text.slice(11);
    } else if (text.startsWith('[warn]')) level = 'warn';
    else if (/^\s*(?:npm ERR!|error(?:\[\w+\])?:|ERROR:|FATAL:)/.test(text)) level = 'error';
    if (!message.trim()) continue;
    records.push({
      ...(lastTime ? { timestamp: lastTime } : {}),
      level,
      message: clip(message, MAX_LINE),
      kind: 'ci',
      ...base,
      ...(step ? { step } : {}),
    });
  }
  for (const failure of testFailures(texts))
    records.push({
      ...(times[failure.index] ? { timestamp: times[failure.index] } : {}),
      level: 'error',
      message: `✕ ${failure.test}`,
      kind: 'test-failure',
      ...base,
      ...(steps[failure.index] ? { step: steps[failure.index] } : {}),
      test: failure.test,
      framework: failure.framework,
      ...(failure.file ? { file: failure.file } : {}),
      ...(failure.line ? { line: failure.line } : {}),
    });
  return records;
}
