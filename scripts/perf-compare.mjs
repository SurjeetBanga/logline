// Compare the performance of builds on this machine, and fail when this one is slower or larger.
//
//   node scripts/perf-compare.mjs --base <dir> [--baseline <dir>] [--head <dir>] [--shard 1/4]
//                                 [--report report.md] [--json results.json]
//   node scripts/perf-compare.mjs --merge shard-1.json shard-2.json ... [--report report.md] [--json results.json]
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
//
// --shard i/n measures every nth case, so CI can split the cases across machines; each comparison still runs on
// one machine. --merge combines the shards' results into one report and one verdict.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    baseline: { type: 'string' },
    head: { type: 'string', default: '.' },
    rounds: { type: 'string', default: '5' },
    threshold: { type: 'string', default: '0.15' },
    'size-threshold': { type: 'string', default: '0.05' },
    floor: { type: 'string', default: '0.02' },
    shard: { type: 'string' },
    merge: { type: 'boolean', default: false },
    report: { type: 'string' },
    json: { type: 'string' },
  },
});
const benchmark = path.join(path.dirname(fileURLToPath(import.meta.url)), 'benchmark.mjs');
const failing = ['slower', 'larger', 'drifted', 'broken'];

/** Measure this build against the base (and baseline), and return the verdict for each case. */
function compareBuilds() {
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

  // This shard's cases: every nth, in the benchmark's order, so heavy and light cases spread evenly.
  let shardCases;
  if (args.shard) {
    const [index, count] = args.shard.split('/').map(Number);
    const listed = spawnSync(process.execPath, [benchmark, '--list'], { encoding: 'utf8' });
    shardCases = JSON.parse(listed.stdout).filter((_, i) => i % count === index - 1);
  }

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
      .join(' and ')}, ${rounds} rounds each${shardCases ? `, cases ${shardCases.join(', ')}` : ''}`,
  );
  measure(rounds, shardCases);
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
  rmSync(scratch, { recursive: true, force: true });
  return {
    node: process.version,
    rounds,
    threshold,
    sizeThreshold,
    baseline: Boolean(baselineSide),
    cases: verdicts(),
  };
}

/** Several shards' results as one, with the cases in the benchmark's order. */
function mergeShards(files) {
  const shards = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  if (!shards.length) throw new Error('No shard results to merge.');
  const order = JSON.parse(spawnSync(process.execPath, [benchmark, '--list'], { encoding: 'utf8' }).stdout);
  const position = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  return {
    ...shards[0],
    baseline: shards.some((shard) => shard.baseline),
    cases: shards.flatMap((shard) => shard.cases).sort((a, b) => position(a.name) - position(b.name)),
  };
}

function render({ node, rounds, threshold, sizeThreshold, baseline: withBaseline, cases }) {
  const format = (value, unit) =>
    value === undefined || value === null ? '–' : `${value.toFixed(unit === 'ms' ? (value < 1 ? 3 : 1) : 1)} ${unit}`;
  const percent = (change) =>
    change === undefined || change === null ? '–' : `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
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
  const columns = [
    'Case',
    ...(withBaseline ? ['Baseline'] : []),
    'Base',
    'This change',
    'vs base',
    ...(withBaseline ? ['vs baseline'] : []),
    'Result',
  ];
  const rows = cases.map(
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
  const failures = cases.filter((verdict) => failing.includes(verdict.status));
  return [
    '## Performance',
    '',
    failures.length
      ? `**${failures.length} ${failures.length === 1 ? 'case is' : 'cases are'} over a limit.**`
      : 'Every case is within its limits.',
    '',
    `A timed case fails when it is more than ${threshold * 100}% slower than the base${withBaseline ? `, or more than ${threshold * 100}% above the baseline in \`.github/performance-baseline\`` : ''}, and still is when measured again. A size fails when it grows by more than ${sizeThreshold * 100}%${withBaseline ? ' over either' : ''}. Medians of ${rounds} runs that take turns on the same machine, ${node}.`,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
  ].join('\n');
}

if (!args.merge && !args.base) {
  console.error('Usage: node scripts/perf-compare.mjs --base <dir> [--baseline <dir>] [--head <dir>] [--shard i/n]');
  console.error('       node scripts/perf-compare.mjs --merge <results.json>...');
  process.exit(2);
}
const results = args.merge ? mergeShards(positionals) : compareBuilds();
const report = render(results);
console.log(report);
// The full table goes on the summary page once: from the merge, or from an unsharded comparison.
if (process.env.GITHUB_STEP_SUMMARY && (args.merge || !args.shard))
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
// For the pull request comment and the run's artifact.
for (const [file, text] of [
  [args.report, report],
  [args.json, JSON.stringify(results, null, 2)],
]) {
  if (!file) continue;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, text);
}
process.exit(results.cases.some((verdict) => failing.includes(verdict.status)) ? 1 : 0);
