import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';

// --vsix tests a packaged extension instead of this folder, so a file missing from the package fails here.
// VSCODE_VERSION (such as 1.99.0 or stable) downloads that build instead of using the installed `code` CLI.
const { values: { vsix } } = parseArgs({ options: { vsix: { type: 'string' } } });
const version = process.env.VSCODE_VERSION;

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
  let extensionPath = process.cwd();
  if (vsix) {
    const unpacked = path.join(root, 'package');
    await mkdir(unpacked);
    // A VSIX is a zip archive with the extension under extension/. GNU tar cannot read zip; the bsdtar in macOS and in
    // Windows' System32 can, named in full on Windows so Git Bash's GNU tar is not found first.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const [command, ...args] = process.platform === 'linux' ? ['unzip', '-q', path.resolve(vsix), '-d', unpacked] : [tar, '-xf', path.resolve(vsix), '-C', unpacked];
    const extracted = spawnSync(command, args, { stdio: 'inherit' });
    if (extracted.status !== 0) throw new Error(`Could not unpack ${vsix}`);
    extensionPath = path.join(unpacked, 'extension');
  }
  const resultFile = path.join(root, 'result.json');
  // The extension installs its MCP server and agent discovery files under the home folder: keep them in this run's.
  const home = path.join(root, 'home');
  await mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOGLINE_SMOKE_RESULT: resultFile, LOGLINE_SMOKE_OTLP_PORT: String(otlpPort) };
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const args = [
    '--user-data-dir', path.join(root, 'profile'), '--extensions-dir', path.join(root, 'extensions'),
    '--extensionDevelopmentPath', extensionPath, '--extensionTestsPath', path.join(process.cwd(), 'out-tests/test/extension-smoke.js'),
    // With HOME moved, macOS cannot find the login keychain and asks to create one: keep secrets in memory instead.
    // The Chromium switch goes before a known option, or VS Code reads the next argument as its value.
    '--use-inmemory-secretstorage', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace,
  ];
  let executable = process.env.VSCODE_CLI ?? 'code';
  if (version) {
    const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
    executable = await downloadAndUnzipVSCode({ version, cachePath: path.resolve('.vscode-test') });
    // The application runs the tests and exits; CI containers have no sandbox support.
    args.unshift('--no-sandbox', '--disable-gpu-sandbox');
  } else {
    // The CLI returns at once unless it waits for the window to close.
    args.push('--wait');
  }
  const child = spawn(executable, args, { env, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`VS Code exited with ${code}`))); });
  } finally { clearTimeout(timeout); }
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  if (!result.passed) throw new Error(result.error);
  console.log('Extension smoke passed:', result.checks.join(', '));
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
