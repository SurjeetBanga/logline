import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';

// --coverage measures the TypeScript sources (through source maps) and fails below these floors,
// set just under the current numbers so coverage can only drop by a small margin. They are measured
// on Node 22 (.nvmrc, CI), which counts lines without code, such as type declarations, as uncovered;
// newer Node versions report higher line coverage for the same tests.
const COVERAGE_FLOORS = { lines: 90, branches: 85, functions: 86 };
const coverage = process.argv.includes('--coverage');
// --coverage also writes coverage/: summary.md (the table), report.txt (the full test output), and lcov.info for
// coverage tools and editor extensions. CI keeps the folder as an artifact.
const report = 'coverage/report.txt';

rmSync('out-tests', { recursive: true, force: true });
if (coverage) {
  rmSync('coverage', { recursive: true, force: true });
  mkdirSync('coverage');
}
for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'],
  ['--check', 'media/viewer.js'],
  ['--test'],
]) {
  if (args[0] === '--test') {
    if (coverage) {
      args.unshift('--enable-source-maps');
      args.push(
        '--experimental-test-coverage',
        '--test-coverage-exclude=**/*.test.ts',
        '--test-coverage-exclude=**/src/test/**',
        ...Object.entries(COVERAGE_FLOORS).map(([kind, floor]) => `--test-coverage-${kind}=${floor}`),
        '--test-reporter=spec',
        '--test-reporter-destination=stdout',
        '--test-reporter=spec',
        `--test-reporter-destination=${report}`,
        '--test-reporter=lcov',
        '--test-reporter-destination=coverage/lcov.info',
      );
    }
    args.push(
      ...readdirSync('out-tests', { recursive: true })
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => `out-tests/${name}`),
    );
  }
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (args.includes('--test') && coverage) {
    const lines = readFileSync(report, 'utf8').split('\n');
    const start = lines.findIndex((line) => line.includes('start of coverage report'));
    const table = lines.slice(start + 1).filter((line) => !line.includes('end of coverage report'));
    const floors = Object.entries(COVERAGE_FLOORS)
      .map(([kind, floor]) => `${kind} ${floor}%`)
      .join(', ');
    const summary = `## Test coverage\n\nMinimum: ${floors}. Measured on ${process.version}.\n\n\`\`\`\n${table.map((line) => line.replace(/^ℹ ?/, '')).join('\n')}\n\`\`\`\n`;
    writeFileSync('coverage/summary.md', summary);
    // The coverage table on the workflow run's summary page.
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
