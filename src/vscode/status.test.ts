import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { QuickPickItem } from 'vscode';
import { withVscode } from '../test/vscode-mock';
import type { LogsController } from './logs-controller';

type Pick = QuickPickItem & { item?: { area: string; action?: { command: string; args?: unknown[] } }; copy?: boolean };

/** A window with the receiver on a fallback port, one connected agent, and a shared run. */
function controller(settings: Record<string, unknown> = {}) {
  const config = { get: <T>(key: string, fallback: T) => (key in settings ? settings[key] : fallback) as T };
  return {
    config,
    otlp: {
      requestedPort: 4318,
      status: () => ({ running: true, endpoint: 'http://127.0.0.1:4319', error: undefined }),
    },
    store: { stats: () => ({ retained: 1200, bytes: 2048, maxBytes: 100 * 1024 * 1024, discarded: 3 }) },
    agentAccess: { status: () => ({ active: true, scope: 'selected', sources: ['api', 'worker'] }) },
    spans: { traceCount: 7 },
    metrics: { size: 2 },
    agentBridge: { running: true, recentClients: () => ['Claude Code'] },
    terminalCapture: { status: () => ({ state: 'capturing', detail: 'Capturing 1 terminal command' }) },
    runner: { sessions: new Map([['a', {}]]) },
    tasks: { executions: new Map([['b', {}]]) },
    files: { active: 1 },
    lens: { enabled: true },
    doctor: { total: 4 },
    gitChanges: { status: () => ({ files: 5 }) },
  } as unknown as LogsController;
}

/** Load the status module with a VS Code whose quick pick answers with `choose`. */
function load(choose: (picks: Pick[]) => Pick | undefined) {
  const calls = {
    picks: [] as Pick[],
    title: '',
    clipboard: '',
    info: [] as string[],
    commands: [] as unknown[][],
  };
  const mock = {
    QuickPickItemKind: { Separator: -1 },
    extensions: { getExtension: () => undefined },
    window: {
      showQuickPick: async (picks: Pick[], options: { title: string }) => {
        calls.picks = picks;
        calls.title = options.title;
        return choose(picks);
      },
      showInformationMessage: async (message: string) => {
        calls.info.push(message);
      },
    },
    env: {
      clipboard: {
        writeText: async (text: string) => {
          calls.clipboard = text;
        },
      },
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        calls.commands.push(args);
      },
    },
  };
  // Each test gets its own VS Code, so the module must load again rather than come from the cache.
  delete require.cache[require.resolve('./status')];
  const status = withVscode(mock, () => require('./status') as typeof import('./status'));
  return { ...status, calls };
}

/** Run with a home folder whose Claude Code skills include Logline's, so the result does not depend on this machine. */
function withHome<T>(run: () => T): T {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  const home = mkdtempSync(join(tmpdir(), 'logline-status-'));
  mkdirSync(join(home, '.claude', 'skills', 'logline-verify'), { recursive: true });
  process.env.HOME = process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Show Status reads each part of the running window', () => {
  const { statusInput } = load(() => undefined);
  const input = withHome(() => statusInput(controller({ persistLogs: true, logDoctor: 'security' })));
  assert.deepEqual(input.receiver, {
    running: true,
    endpoint: 'http://127.0.0.1:4319',
    error: undefined,
    requestedPort: 4318,
    port: 4318,
    injectEnvironment: true,
    traces: 7,
    metricSeries: 2,
  });
  assert.deepEqual(input.agents, {
    enabled: true,
    bridgeRunning: true,
    clients: ['Claude Code'],
    skills: ['Claude Code'],
    sharing: { active: true, scope: 'selected', sources: 2 },
    copilot: false,
  });
  assert.deepEqual(input.capture, {
    terminal: { state: 'capturing', detail: 'Capturing 1 terminal command' },
    debugSessions: true,
    running: 3,
  });
  assert.deepEqual(input.retention, {
    events: 1200,
    bytes: 2048,
    maxBytes: 100 * 1024 * 1024,
    discarded: 3,
    persist: true,
  });
  assert.deepEqual(input.editor, { lenses: true, doctor: 'security', findings: 4, changedFiles: 5 });
});

test('Show Status works before the optional parts of the window exist', () => {
  const { statusInput } = load(() => undefined);
  const bare = {
    ...controller(),
    agentBridge: undefined,
    lens: undefined,
    doctor: undefined,
    gitChanges: undefined,
  } as unknown as LogsController;
  const input = withHome(() => statusInput(bare));
  assert.equal(input.agents.bridgeRunning, false);
  assert.deepEqual(input.agents.clients, []);
  assert.deepEqual(input.editor, { lenses: false, doctor: 'all', findings: 0, changedFiles: undefined });
});

test('Show Status lists every area with its state, counts problems, and runs the chosen fix', async () => {
  const { showStatus, calls } = load((picks) => picks.find((pick) => pick.item?.action));
  // The receiver could not start: a problem, with a fix.
  const failed = {
    ...controller(),
    otlp: {
      requestedPort: 4318,
      status: () => ({ running: false, endpoint: undefined, error: 'Port 4318 is in use' }),
    },
  } as unknown as LogsController;
  await withHome(() => showStatus(failed, '1.2.3'));
  const areas = calls.picks.filter((pick) => pick.item).map((pick) => pick.item!.area);
  assert.ok(areas.includes('OpenTelemetry receiver'), areas.join(', '));
  assert.ok(calls.picks.every((pick) => !pick.item || /^\$\((pass|circle-slash|warning)\) /.test(pick.label)));
  assert.equal(calls.title, 'Logline status · 1 problem');
  const chosen = calls.picks.find((pick) => pick.item?.action)!;
  assert.deepEqual(calls.commands, [[chosen.item!.action!.command, ...(chosen.item!.action!.args ?? [])]]);
  assert.match(chosen.detail ?? '', /→ /, 'the fix is named in the detail line');
});

test('Copy status puts the version and every area on the clipboard', async () => {
  const { showStatus, calls } = load((picks) => picks.find((pick) => pick.copy));
  await withHome(() => showStatus(controller(), '1.2.3'));
  assert.match(calls.clipboard, /^Logline 1\.2\.3 status\n/);
  for (const pick of calls.picks.filter((item) => item.item)) assert.ok(calls.clipboard.includes(pick.item!.area));
  assert.deepEqual(calls.info, ['Copied Logline status.']);
  assert.deepEqual(calls.commands, []);
});

test('closing Show Status changes nothing', async () => {
  const { showStatus, calls } = load(() => undefined);
  await withHome(() => showStatus(controller(), '1.2.3'));
  assert.ok(calls.picks.length > 0);
  assert.equal(calls.clipboard, '');
  assert.deepEqual(calls.commands, []);
});
