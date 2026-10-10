import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';

// --coverage measures the TypeScript sources (through source maps) and fails below these floors,
// set just under the current numbers so coverage can only drop by a small margin.
const COVERAGE_FLOORS = { lines: 92, branches: 85, functions: 86 };
const coverage = process.argv.includes('--coverage');
const report = 'out-tests/coverage.txt';

rmSync('out-tests', { recursive: true, force: true });
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
      );
    }
    args.push(
      ...readdirSync('out-tests', { recursive: true })
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => `out-tests/${name}`),
    );
  }
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (args.includes('--test') && coverage && process.env.GITHUB_STEP_SUMMARY) {
    // The coverage table on the workflow run's summary page.
    const lines = readFileSync(report, 'utf8').split('\n');
    const start = lines.findIndex((line) => line.includes('start of coverage report'));
    const table = lines.slice(start + 1).filter((line) => !line.includes('end of coverage report'));
    const floors = Object.entries(COVERAGE_FLOORS)
      .map(([kind, floor]) => `${kind} ${floor}%`)
      .join(', ');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Test coverage\n\nMinimum: ${floors}.\n\n\`\`\`\n${table.map((line) => line.replace(/^ℹ ?/, '')).join('\n')}\n\`\`\`\n`,
    );
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
