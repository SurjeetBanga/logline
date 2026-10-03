import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// A free port for the OpenTelemetry receiver, so the smoke test never meets a real collector.
const otlpPort = await new Promise((resolve, reject) => {
  const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const root = await mkdtemp(path.join(tmpdir(), 'logline-smoke-'));
try {
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await mkdir(path.join(root, 'profile', 'User'), { recursive: true });
  await writeFile(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false, 'workbench.startupEditor': 'none',
  }));
  await writeFile(path.join(workspace, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{
    type: 'logline', label: 'Logline smoke', command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({level:"info",message:"extension smoke"}))'], shell: false,
  }] }));
  await writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'logline.otlp.port': otlpPort }));
  await writeFile(path.join(workspace, 'app.js'), 'console.log("smoke debug statement ready");\n');
  const resultFile = path.join(root, 'result.json');
  const env = { ...process.env, LOGLINE_SMOKE_RESULT: resultFile, LOGLINE_SMOKE_OTLP_PORT: String(otlpPort) };
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const child = spawn(process.env.VSCODE_CLI ?? 'code', [
    '--user-data-dir', path.join(root, 'profile'), '--extensions-dir', path.join(root, 'extensions'),
    '--extensionDevelopmentPath', process.cwd(), '--extensionTestsPath', path.join(process.cwd(), 'out-tests/test/extension-smoke.js'),
    '--wait', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace,
  ], { env, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`VS Code exited with ${code}`))); });
  } finally { clearTimeout(timeout); }
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  if (!result.passed) throw new Error(result.error);
  console.log('Extension smoke passed:', result.checks.join(', '));
} finally { await rm(root, { recursive: true, force: true }); }
