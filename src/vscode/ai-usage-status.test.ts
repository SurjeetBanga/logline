import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexUsage } from '../core/codex-usage';
import type { GenAiCall } from '../core/gen-ai';
import { withVscode } from '../test/vscode-mock';

const item = {
  text: '',
  tooltip: undefined as { value: string; isTrusted?: unknown; supportHtml?: boolean } | undefined,
  name: '',
  command: '',
  backgroundColor: undefined as { id: string } | undefined,
  shown: false,
  shows: 0,
  disposed: false,
};
const ui = {
  created: [] as unknown[],
  answer: undefined as string | undefined,
  picked: undefined as { level: string } | undefined,
  executed: [] as string[],
  withItem: true,
};
const settings = new Map<string, unknown>();
const registered = new Map<string, (...args: unknown[]) => unknown>();
let configChanged: ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined;
const mock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  MarkdownString: class {
    isTrusted?: unknown;
    supportHtml?: boolean;
    constructor(
      readonly value: string,
      readonly supportThemeIcons: boolean,
    ) {}
  },
  window: {
    get createStatusBarItem() {
      return ui.withItem
        ? (...args: unknown[]) => {
            ui.created = args;
            return Object.assign(item, {
              show: () => {
                item.shown = true;
                item.shows++;
              },
              hide: () => (item.shown = false),
              dispose: () => (item.disposed = true),
            });
          }
        : undefined;
    },
    showInformationMessage: async () => ui.answer,
    showQuickPick: async () => ui.picked,
  },
  workspace: {
    getConfiguration: (section: string) => ({
      update: async (key: string, value: unknown) => void settings.set(`${section}.${key}`, value),
    }),
    onDidChangeConfiguration: (listener: typeof configChanged) => {
      configChanged = listener;
      return { dispose: () => (configChanged = undefined) };
    },
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(id, handler);
      return { dispose: () => registered.delete(id) };
    },
    executeCommand: async (id: string) => void ui.executed.push(id),
  },
};
const { AiUsageStatus, agentNames } = withVscode(
  mock,
  () => require('./ai-usage-status') as typeof import('./ai-usage-status'),
);

const NOW = new Date(2026, 10, 15, 12).getTime();
const background = () => item.backgroundColor?.id;
const limit = (usedPercent: number) => ({ window: '5h', usedPercent, resetsAt: NOW + 3600_000, asOf: NOW });
const call = (): GenAiCall => ({
  traceId: 't',
  spanId: 's',
  operation: 'chat',
  kind: 'model',
  name: 'chat',
  service: 'api',
  startMs: 0,
  durationMs: 1,
  inputTokens: 10,
  outputTokens: 2,
  error: false,
  hasContent: false,
});

function setup(usage: CodexUsage = { tokens: 0, limits: [] }, codex = true) {
  Object.assign(item, {
    text: '',
    tooltip: undefined,
    backgroundColor: undefined,
    shown: false,
    shows: 0,
    disposed: false,
  });
  Object.assign(ui, { created: [], answer: undefined, picked: undefined, executed: [], withItem: true });
  settings.clear();
  registered.clear();
  if (codex) settings.set('logline.aiUsage.codex', true);
  const state = { usage, calls: [] as GenAiCall[], polls: 0, fail: false };
  const status = new AiUsageStatus({
    config: {
      get: <T>(key: string, fallback: T) =>
        settings.has(`logline.${key}`) ? (settings.get(`logline.${key}`) as T) : fallback,
    },
    calls: () => state.calls,
    reader: {
      poll: async () => {
        state.polls++;
        if (state.fail) throw new Error('unreadable');
        return state.usage;
      },
    },
    now: () => NOW,
  });
  return { status, state, run: (id: string, ...args: unknown[]) => registered.get(id)!(...args) };
}

test("the item sits on the right and shows Codex's limit, with the colours of the editor", async () => {
  const { status, state } = setup({ tokens: 1200, limits: [limit(23)] });
  await status.refresh();
  assert.deepEqual(ui.created.slice(0, 2), ['logline.aiUsage', 2]);
  assert.equal(item.command, 'logline.showAiUsage');
  assert.equal(item.text, '$(logline-mark) $(logline-pie-25) Codex 23%');
  assert.equal(background(), undefined);
  assert.equal(item.shown, true);
  assert.match(item.tooltip!.value, /Logline AI usage/);
  assert.equal(item.tooltip!.supportHtml, true);
  assert.ok(
    (item.tooltip!.isTrusted as { enabledCommands: string[] }).enabledCommands.includes('logline.setAiUsageDetail'),
  );
  // A poll that changes nothing leaves the item alone.
  await status.refresh();
  assert.equal(item.shows, 1);
  state.usage = { tokens: 0, limits: [limit(86)] };
  await status.refresh();
  assert.equal(background(), 'statusBarItem.warningBackground');
  state.usage = { tokens: 0, limits: [limit(100)] };
  await status.refresh();
  assert.equal(background(), 'statusBarItem.errorBackground');
  // A read that fails keeps what was shown.
  state.fail = true;
  await status.refresh();
  assert.equal(item.text, '$(logline-mark) $(logline-pie-100) Codex 100%');
  assert.equal(item.shows, 1);
  status.dispose();
  assert.equal(item.disposed, true);
  assert.equal(registered.size, 0);
});

test('Codex is not read until that is turned on; until then the item shows the mark and the calls of the app', async () => {
  const { status, state, run } = setup({ tokens: 0, limits: [limit(38)] }, false);
  await status.refresh();
  assert.equal(state.polls, 0);
  assert.equal(item.shown, true);
  assert.equal(item.text, '$(logline-mark)');
  state.calls = [call()];
  await status.refresh();
  assert.equal(item.text, '$(logline-mark) 1 call');
  assert.match(item.tooltip!.value, /Turn on \[Codex usage\]/);
  await run('logline.enableCodexUsage');
  assert.equal(settings.has('logline.aiUsage.codex'), false);
  ui.answer = 'Show Usage';
  await run('logline.enableCodexUsage');
  assert.equal(settings.get('logline.aiUsage.codex'), true);
  configChanged!({ affectsConfiguration: (section) => section === 'logline.aiUsage' });
  await status.refresh();
  assert.equal(item.text, '$(logline-mark) $(logline-pie-40) Codex 38%');
  // Turned off, the item goes and nothing is read.
  settings.set('logline.aiUsage.enabled', false);
  const polls = state.polls;
  await status.refresh();
  assert.equal(item.shown, false);
  assert.equal(state.polls, polls);
  // Other settings change nothing.
  settings.set('logline.aiUsage.enabled', true);
  configChanged!({ affectsConfiguration: (section) => section === 'editor' });
  assert.equal(item.shown, false);
  status.dispose();
});

test('the level of detail is set from the hover or from a list, and a click opens the Logs panel', async () => {
  const { status, run } = setup({ tokens: 65_000, limits: [limit(38)] });
  await run('logline.setAiUsageDetail', 'min');
  assert.equal(settings.get('logline.aiUsage.detail'), 'min');
  await status.refresh();
  assert.equal(item.text, '$(logline-mark) $(logline-pie-40) 38%');
  ui.picked = { level: 'max' };
  await run('logline.setAiUsageDetail');
  await status.refresh();
  assert.equal(item.text, '$(logline-mark) $(logline-pie-40) Codex 38%  65k tok');
  // A level that does not exist asks, and a list that is dismissed changes nothing.
  ui.picked = undefined;
  await run('logline.setAiUsageDetail', 'huge');
  assert.equal(settings.get('logline.aiUsage.detail'), 'max');
  await run('logline.showAiUsage');
  assert.deepEqual(ui.executed, ['logline.logs.focus']);
  status.dispose();
});

test('a host with no status bar still registers its commands', async () => {
  const { status, state } = setup({ tokens: 0, limits: [limit(50)] });
  status.dispose();
  ui.withItem = false;
  const bare = new AiUsageStatus({
    config: { get: <T>(_key: string, fallback: T) => fallback },
    calls: () => state.calls,
    reader: { poll: async () => state.usage },
  });
  await bare.refresh();
  assert.ok(registered.has('logline.showAiUsage'));
  bare.dispose();
});

test('the agent sessions dialog names the agents on offer, or both', () => {
  assert.equal(agentNames(['Claude Code']), 'Claude Code keeps');
  assert.equal(agentNames(['Claude Code', 'Codex']), 'Claude Code and Codex keep');
  assert.equal(agentNames(), 'Claude Code, Codex and Copilot keep');
  assert.equal(agentNames([]), 'Claude Code, Codex and Copilot keep');
});
