import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = { asked: [] as string[], answer: undefined as string | undefined, appName: 'Visual Studio Code' };
const installed = new Set<string>();
const mock = {
  window: {
    showInformationMessage: async (message: string) => {
      ui.asked.push(message);
      return ui.answer;
    },
  },
  env: {
    get appName() {
      return ui.appName;
    },
  },
  extensions: { getExtension: (id: string) => (installed.has(id) ? {} : undefined) },
};
const { AgentOnboarding, AGENT_OFFER_KEY, detectAgent, setupSummary, AGENT_FIRST_PROMPT } = withVscode(
  mock,
  () => require('./agent-onboarding') as typeof import('./agent-onboarding'),
);

function setup(options: { ready?: boolean; agent?: { kind: 'claude' | 'copilot'; name: string } | null } = {}) {
  const stored = new Map<string, unknown>();
  const steps: string[] = [];
  const setUps: string[] = [];
  const onboarding = new AgentOnboarding({
    memento: {
      get: <T>(key: string) => stored.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void stored.set(key, value),
    },
    ready: () => options.ready ?? false,
    setUp: async (agent) => void setUps.push(agent.kind),
    detect: () => (options.agent === null ? undefined : (options.agent ?? { kind: 'claude', name: 'Claude Code' })),
    record: (step, agent) => steps.push(`${step}:${agent}`),
    delayMs: 0,
  });
  return { onboarding, stored, steps, setUps };
}

test('the agent found is the editor’s own, then Claude Code or Codex, then Copilot', () => {
  installed.clear();
  const none = () => false;
  const host = { name: 'Cursor', file: '/home/me/.cursor/mcp.json' };
  assert.deepEqual(
    detectAgent(host, () => true, none),
    { kind: 'host', name: 'Cursor' },
  );
  assert.deepEqual(
    detectAgent(undefined, (id) => id === 'anthropic.claude-code', none),
    { kind: 'claude', name: 'Claude Code' },
  );
  assert.deepEqual(
    detectAgent(undefined, (id) => id === 'openai.chatgpt', none),
    { kind: 'codex', name: 'Codex' },
  );
  assert.deepEqual(
    detectAgent(undefined, none, () => true),
    { kind: 'copilot', name: 'Copilot' },
  );
  assert.equal(detectAgent(undefined, none, none), undefined);
  // By default it asks the editor which extensions are installed.
  installed.add('openai.chatgpt');
  assert.deepEqual(detectAgent(undefined), { kind: 'codex', name: 'Codex' });
  installed.clear();
});

test('the setup is offered once, names the agent, and runs only on Set Up', async () => {
  Object.assign(ui, { asked: [], answer: 'Set Up' });
  const accepted = setup();
  assert.equal(await accepted.onboarding.offer(), true);
  assert.match(ui.asked[0], /Let Claude Code read your app's logs/);
  assert.match(ui.asked[0], /redacted/);
  assert.deepEqual(accepted.setUps, ['claude']);
  assert.deepEqual(accepted.steps, ['offered:claude', 'accepted:claude']);
  assert.equal(accepted.stored.get(AGENT_OFFER_KEY), true);
  assert.equal(await accepted.onboarding.offer(), false, 'never a second time');
  assert.equal(ui.asked.length, 1);

  Object.assign(ui, { asked: [], answer: 'Not Now' });
  const declined = setup();
  assert.equal(await declined.onboarding.offer(), true);
  assert.deepEqual(declined.setUps, []);
  assert.deepEqual(declined.steps, ['offered:claude', 'declined:claude']);
  assert.equal(await declined.onboarding.offer(), false);

  Object.assign(ui, { asked: [], answer: undefined });
  const closed = setup({ agent: { kind: 'copilot', name: 'Copilot' } });
  await closed.onboarding.offer();
  assert.deepEqual(closed.steps, ['offered:copilot', 'dismissed:copilot']);
});

test('nothing is offered without an agent, or when agents already read the logs', async () => {
  Object.assign(ui, { asked: [], answer: 'Set Up' });
  const none = setup({ agent: null });
  assert.equal(await none.onboarding.offer(), false);
  assert.equal(none.stored.size, 0, 'so an agent installed later is still offered');
  const ready = setup({ ready: true });
  assert.equal(await ready.onboarding.offer(), false);
  assert.equal(ui.asked.length, 0);
});

test('start offers a while into the session, and not after it was offered or disposed', async () => {
  Object.assign(ui, { asked: [], answer: 'Not Now' });
  const first = setup();
  first.onboarding.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ui.asked.length, 1);
  first.onboarding.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ui.asked.length, 1);
  const disposed = setup();
  disposed.onboarding.start();
  disposed.onboarding.dispose();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ui.asked.length, 1);
});

test('the closing message says what is left to do, for the shell and the agent', () => {
  const claude = { kind: 'claude' as const, name: 'Claude Code' };
  const summary = setupSummary(claude, { restart: true, cmd: false });
  assert.match(summary, /^Logline is set up for Claude Code\. Restart Claude Code so it loads Logline\./);
  assert.match(summary, /Run your app in a terminal as usual\./);
  assert.ok(summary.endsWith(`Then ask Claude Code: "${AGENT_FIRST_PROMPT}"`));
  const copilot = setupSummary({ kind: 'copilot', name: 'Copilot' }, { restart: false, cmd: true });
  assert.doesNotMatch(copilot, /Restart/);
  assert.match(copilot, /Command Prompt cannot be captured/);
});
