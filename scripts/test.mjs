import { spawnSync } from 'node:child_process';
import { rmSync, readdirSync } from 'node:fs';
rmSync('out-tests', { recursive: true, force: true });
for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'],
  ['--check', 'media/viewer.js'],
  ['--test'],
]) {
  if (args[0] === '--test') args.push(...readdirSync('out-tests', { recursive: true }).filter(name => name.endsWith('.test.js')).map(name => `out-tests/${name}`));
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
