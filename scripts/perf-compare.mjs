// Compare the performance of two builds on this machine, and fail when the second is slower or larger.
//
//   node scripts/perf-compare.mjs --base <dir> --head <dir> [--report report.md] [--json results.json]
//
// Both builds run this checkout's scripts/benchmark.mjs, in fresh processes that alternate between them,
// so the machine's speed and load affect both alike. A timed case regresses when its median is more than
// --threshold slower (and slower by more than --floor ms); it is then measured again with more rounds, and
// fails only if the slowdown holds. A size case (bytes sent, memory retained) is deterministic and fails
// when it grows by more than --size-threshold.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string', default: '.' },
    rounds: { type: 'string', default: '5' },
    threshold: { type: 'string', default: '0.25' },
    'size-threshold': { type: 'string', default: '0.05' },
    floor: { type: 'string', default: '0.02' },
    report: { type: 'string' },
    json: { type: 'string' },
  },
});
if (!args.base) {
  console.error('Usage: node scripts/perf-compare.mjs --base <dir> [--head <dir>] [--rounds 5] [--threshold 0.25]');
  process.exit(2);
}
const benchmark = path.join(path.dirname(fileURLToPath(import.meta.url)), 'benchmark.mjs');
const rounds = Number(args.rounds);
const threshold = Number(args.threshold);
const sizeThreshold = Number(args['size-threshold']);
const floor = Number(args.floor);
const sides = { base: path.resolve(args.base), head: path.resolve(args.head) };
const scratch = mkdtempSync(path.join(tmpdir(), 'logline-perf-'));

/** samples[side][case] holds one value per process run; labels and errors are kept from the latest run. */
const samples = { base: {}, head: {} };
const meta = {};
const errors = { base: {}, head: {} };

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
    // Alternate which build goes first, so neither always runs on a warmer or cooler machine.
    const order = round % 2 ? ['head', 'base'] : ['base', 'head'];
    for (const side of order) run(side, only);
    process.stderr.write(`  round ${round + 1}/${count}${only ? ` (${only.join(', ')})` : ''}\n`);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function verdicts() {
  return Object.entries(meta).map(([name, { label, unit }]) => {
    const base = samples.base[name] && median(samples.base[name]);
    const head = samples.head[name] && median(samples.head[name]);
    if (head === undefined) return { name, label, unit, base, status: 'broken', note: errors.head[name] };
    if (base === undefined) return { name, label, unit, head, status: 'new' };
    const change = head / base - 1;
    const timed = unit === 'ms';
    const slower = timed ? change > threshold && head - base > floor : change > sizeThreshold;
    const faster = timed ? change < -threshold && base - head > floor : change < -sizeThreshold;
    const status = slower ? (timed ? 'slower' : 'larger') : faster ? (timed ? 'faster' : 'smaller') : 'same';
    return { name, label, unit, base, head, change, status };
  });
}

console.error(`Comparing ${sides.head} with ${sides.base}, ${rounds} rounds each`);
measure(rounds);
// A slowdown has to hold up: measure the suspects again, twice as long, and judge on all the samples.
const suspects = verdicts().filter((verdict) => verdict.status === 'slower' && verdict.unit === 'ms');
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
const marks = {
  slower: '❌ slower',
  larger: '❌ larger',
  broken: '❌ broken',
  faster: '✅ faster',
  smaller: '✅ smaller',
  same: '✓',
  new: 'new',
};
const rows = final.map(
  ({ label, unit, base, head, change, status, note }) =>
    `| ${label} | ${format(base, unit)} | ${format(head, unit)} | ${change === undefined ? '–' : `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`} | ${marks[status]}${note ? ` (${note})` : ''} |`,
);
const failures = final.filter((verdict) => ['slower', 'larger', 'broken'].includes(verdict.status));
const report = [
  '## Performance',
  '',
  failures.length
    ? `**${failures.length} ${failures.length === 1 ? 'case is' : 'cases are'} slower or larger than the base build.**`
    : 'No case is slower or larger than the base build.',
  '',
  `Timed cases fail when more than ${threshold * 100}% slower after a second measurement; size cases when more than ${sizeThreshold * 100}% larger. Medians of ${rounds} alternating runs on the same machine, ${process.version}.`,
  '',
  '| Case | Base | This change | Change | Result |',
  '| --- | --- | --- | --- | --- |',
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
