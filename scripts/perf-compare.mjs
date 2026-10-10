// Compare the performance of builds on this machine, and fail when this one is slower or larger.
//
//   node scripts/perf-compare.mjs --base <dir> [--baseline <dir>] [--head <dir>] [--report report.md] [--json results.json]
//
// Every build runs this checkout's scripts/benchmark.mjs, in fresh processes that take turns, so the machine's
// speed and load affect them alike. Two limits apply to this build (--head):
//
// - Against --base, the branch it changes: no case may get more than --threshold slower in one change.
// - Against --baseline, the commit in .github/performance-baseline: no case may drift more than --threshold above
//   it, however small each step was. Moving the baseline is a reviewed change to that file.
//
// A timed case over a limit (and slower by more than --floor ms) is measured again with twice the rounds, and fails
// only if it is still over. A size case (bytes sent, memory retained) is deterministic and fails when it grows by
// more than --size-threshold.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    baseline: { type: 'string' },
    head: { type: 'string', default: '.' },
    rounds: { type: 'string', default: '5' },
    threshold: { type: 'string', default: '0.15' },
    'size-threshold': { type: 'string', default: '0.05' },
    floor: { type: 'string', default: '0.02' },
    report: { type: 'string' },
    json: { type: 'string' },
  },
});
if (!args.base) {
  console.error('Usage: node scripts/perf-compare.mjs --base <dir> [--baseline <dir>] [--head <dir>] [--rounds 5]');
  process.exit(2);
}
const benchmark = path.join(path.dirname(fileURLToPath(import.meta.url)), 'benchmark.mjs');
const rounds = Number(args.rounds);
const threshold = Number(args.threshold);
const sizeThreshold = Number(args['size-threshold']);
const floor = Number(args.floor);
const sides = { base: path.resolve(args.base), head: path.resolve(args.head) };
// A baseline that is the base itself (the usual case right after the baseline moves) is measured once.
if (args.baseline && path.resolve(args.baseline) !== sides.base) sides.baseline = path.resolve(args.baseline);
const baselineSide = args.baseline ? (sides.baseline ? 'baseline' : 'base') : undefined;
const names = Object.keys(sides);
const scratch = mkdtempSync(path.join(tmpdir(), 'logline-perf-'));

/** samples[side][case] holds one value per process run; labels and errors are kept from the latest run. */
const samples = Object.fromEntries(names.map((side) => [side, {}]));
const errors = Object.fromEntries(names.map((side) => [side, {}]));
const meta = {};

function run(side, only) {
  const output = path.join(scratch, `${side}.json`);
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', benchmark, '--root', sides[side], '--json', output, ...(only ? ['--only', only.join(',')] : [])],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) throw new Error(`The benchmark failed for ${side} (${sides[side]}).`);
  for (const [name, { label, unit, value, error }] of Object.entries(
    JSON.parse(readFileSync(output, 'utf8')).results,
  )) {
    meta[name] = { label, unit };
    if (error) errors[side][name] = error;
    else (samples[side][name] ??= []).push(value);
  }
}

function measure(count, only) {
  for (let round = 0; round < count; round++) {
    // Rotate which build goes first, so none always runs on a warmer or cooler machine.
    const order = names.map((_, i) => names[(i + round) % names.length]);
    for (const side of order) run(side, only);
    process.stderr.write(`  round ${round + 1}/${count}${only ? ` (${only.join(', ')})` : ''}\n`);
  }
}

const median = (values) => {
  if (!values?.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** How `head` compares with `reference`: its relative change, and whether that is over or under the limit. */
function compare(head, reference, unit) {
  if (reference === undefined) return undefined;
  const change = head / reference - 1;
  const timed = unit === 'ms';
  const over = timed ? change > threshold && head - reference > floor : change > sizeThreshold;
  const under = timed ? change < -threshold && reference - head > floor : change < -sizeThreshold;
  return { change, over, under };
}

function verdicts() {
  return Object.entries(meta).map(([name, { label, unit }]) => {
    const base = median(samples.base[name]);
    const baseline = baselineSide && median(samples[baselineSide][name]);
    const head = median(samples.head[name]);
    if (head === undefined) return { name, label, unit, base, baseline, status: 'broken', note: errors.head[name] };
    const change = compare(head, base, unit);
    const drift = compare(head, baseline, unit);
    const timed = unit === 'ms';
    const status = change?.over
      ? timed
        ? 'slower'
        : 'larger'
      : drift?.over
        ? 'drifted'
        : change?.under
          ? timed
            ? 'faster'
            : 'smaller'
          : change
            ? 'same'
            : 'new';
    return { name, label, unit, base, baseline, head, change: change?.change, drift: drift?.change, status };
  });
}

console.error(
  `Comparing ${sides.head} with ${names
    .filter((side) => side !== 'head')
    .map((side) => `${side} ${sides[side]}`)
    .join(' and ')}, ${rounds} rounds each`,
);
measure(rounds);
// A slowdown has to hold up: measure the suspects again, twice as long, and judge on all the samples.
const suspects = verdicts().filter(
  (verdict) => ['slower', 'drifted'].includes(verdict.status) && verdict.unit === 'ms',
);
if (suspects.length) {
  console.error(`Measuring again: ${suspects.map((verdict) => verdict.name).join(', ')}`);
  measure(
    rounds * 2,
    suspects.map((verdict) => verdict.name),
  );
}
const final = verdicts();
rmSync(scratch, { recursive: true, force: true });

const format = (value, unit) =>
  value === undefined ? '–' : `${value.toFixed(unit === 'ms' ? (value < 1 ? 3 : 1) : 1)} ${unit}`;
const percent = (change) => (change === undefined ? '–' : `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`);
const marks = {
  slower: '❌ slower',
  larger: '❌ larger',
  drifted: '❌ above baseline',
  broken: '❌ broken',
  faster: '✅ faster',
  smaller: '✅ smaller',
  same: '✓',
  new: 'new',
};
const withBaseline = Boolean(baselineSide);
const rows = final.map(
  ({ label, unit, base, baseline, head, change, drift, status, note }) =>
    `| ${[
      label,
      ...(withBaseline ? [format(baseline, unit)] : []),
      format(base, unit),
      format(head, unit),
      percent(change),
      ...(withBaseline ? [percent(drift)] : []),
      `${marks[status]}${note ? ` (${note})` : ''}`,
    ].join(' | ')} |`,
);
const failures = final.filter((verdict) => ['slower', 'larger', 'drifted', 'broken'].includes(verdict.status));
const columns = [
  'Case',
  ...(withBaseline ? ['Baseline'] : []),
  'Base',
  'This change',
  'vs base',
  ...(withBaseline ? ['vs baseline'] : []),
  'Result',
];
const report = [
  '## Performance',
  '',
  failures.length
    ? `**${failures.length} ${failures.length === 1 ? 'case is' : 'cases are'} over a limit.**`
    : 'Every case is within its limits.',
  '',
  `A timed case fails when it is more than ${threshold * 100}% slower than the base${withBaseline ? `, or more than ${threshold * 100}% above the baseline in \`.github/performance-baseline\`` : ''}, and still is when measured again. A size fails when it grows by more than ${sizeThreshold * 100}%${withBaseline ? ' over either' : ''}. Medians of ${rounds} runs that take turns on the same machine, ${process.version}.`,
  '',
  `| ${columns.join(' | ')} |`,
  `| ${columns.map(() => '---').join(' | ')} |`,
  ...rows,
  '',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
// For the pull request comment and the run's artifact.
for (const [file, text] of [
  [args.report, report],
  [args.json, JSON.stringify({ node: process.version, rounds, threshold, sizeThreshold, cases: final }, null, 2)],
]) {
  if (!file) continue;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, text);
}
process.exit(failures.length ? 1 : 0);
