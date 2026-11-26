import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentShareStatus } from '../core/agent-types';
import { LogStore } from '../core/log-store';
import type { SessionSummary } from '../core/types';
import { withVscode } from '../test/vscode-mock';

interface Options {
  copilot?: boolean;
  connected?: string[];
  shared?: boolean;
  /** The source shared, when it is. */
  sharedSource?: string;
  pick?: string;
}

function harness(options: Options = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const messages: string[] = [];
  const terminals: { name: string; sent: string[] }[] = [];
  const chats: string[] = [];
  const shares: [string[], number | undefined, string[] | undefined][] = [];
  const queries: string[] = [];
  const picks: string[][] = [];
  const state = new Map<string, unknown>();
  let clipboard = '';
  let saveListener: ((document: { uri: { scheme: string } }) => void) | undefined;
  let warningAnswer: string | undefined;
  let shared = options.shared ?? true;
  let sharedSources = [options.sharedSource ?? 'api'];
  const vscode = {
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose() {} };
      },
    },
    extensions: {
      getExtension: (id: string) => (options.copilot && id === 'GitHub.copilot-chat' ? { id } : undefined),
    },
    env: {
      appName: 'Visual Studio Code',
      shell: '/bin/zsh',
      clipboard: {
        writeText: async (text: string) => {
          clipboard = text;
        },
      },
    },
    window: {
      createTerminal: (options: { name: string }) => {
        const terminal = { name: options.name, sent: [] as string[] };
        terminals.push(terminal);
        return { show() {}, sendText: (text: string) => terminal.sent.push(text) };
      },
      showQuickPick: async (items: { label: string }[]) => {
        picks.push(items.map((item) => item.label));
        return items.find((item) => item.label === options.pick) ?? items[0];
      },
      showInformationMessage: (message: string) => {
        messages.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string) => {
        messages.push(message);
        return Promise.resolve(warningAnswer);
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/w' } }],
      onDidSaveTextDocument: (listener: typeof saveListener) => {
        saveListener = listener;
        return { dispose() {} };
      },
    },
  };
  const store = new LogStore(1000, 10 * 1024 * 1024);
  const runs: SessionSummary[] = [];
  for (const module of ['./investigate', './agent-setup']) delete require.cache[require.resolve(module)];
  const { Investigator } = withVscode(vscode, () => require('./investigate') as typeof import('./investigate'));
  const status = (): AgentShareStatus =>
    shared
      ? {
          active: true,
          shareId: 'share-1',
          revision: 1,
          scope: 'selected',
          sources: sharedSources.map((id) => ({ id, runs: [{ id: id === 'api' ? 'run-1' : `${id}-run` }] })) as never,
        }
      : { active: false, revision: 0, sources: [] };
  const investigator = new Investigator({
    store,
    runs: () => runs,
    shareStatus: status,
    share: async (ids, anchor, sessionIds) => {
      shares.push([ids, anchor, sessionIds]);
      shared = true;
      sharedSources = ids;
    },
    openChat: async (prompt) => {
      chats.push(prompt);
      return true;
    },
    showQuery: async (query) => {
      queries.push(query);
    },
    globalState: {
      get: ((key: string) => state.get(key)) as never,
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
    connected: () => options.connected ?? [],
  });
  const error = (id: number, sessionId = 'run-1') =>
    store.add({ id, level: 'error', message: 'Error: boom', serverId: 'api', sessionId });
  return {
    investigator,
    commands,
    messages,
    terminals,
    chats,
    shares,
    queries,
    picks,
    runs,
    store,
    error,
    clipboard: () => clipboard,
    save: () => saveListener!({ uri: { scheme: 'file' } }),
    answerWarning: (answer: string) => {
      warningAnswer = answer;
    },
    pick: (label: string) => {
      options.pick = label;
    },
  };
}

const boom = { message: 'Error: boom', eventId: 1, query: 'message:/boom/' };

test('Investigate offers the agents here, hands the error to the chosen one, and offers it first next time', async () => {
  const h = harness({ copilot: true, connected: ['Claude Code'], pick: 'Claude Code' });
  h.error(1);
  assert.equal(await h.investigator.investigate(boom), 'claude');
  assert.deepEqual(h.picks[0], ['GitHub Copilot', 'Claude Code', 'Copy prompt for another agent']);
  assert.equal(h.terminals[0].name, 'Logline · Claude Code');
  assert.match(h.terminals[0].sent[0], /^claude '.*Investigate this error.*Follow the \/logline-triage skill/);
  assert.deepEqual(h.investigator.agents(), ['claude', 'copilot', 'copy']);

  h.pick('GitHub Copilot');
  assert.equal(await h.investigator.investigate(boom), 'copilot');
  assert.match(h.chats[0], /Start with event id 1/);
  assert.ok(!h.chats[0].includes('skill'), 'Copilot gets no skill to follow');
});

test('without an agent connected, the prompt is copied for the agent in the editor', async () => {
  const h = harness();
  h.error(1);
  assert.equal(await h.investigator.investigate(boom), 'copy');
  assert.equal(h.picks.length, 0, 'with one choice there is nothing to ask');
  assert.match(h.clipboard(), /Logline share id: share-1/);
  assert.match(h.messages[0], /prompt was copied/);
});

test('logs are shared first when they are not, and an error no longer retained is said so', async () => {
  const h = harness({ shared: false });
  h.error(7);
  await h.investigator.investigate({ ...boom, eventId: 7 }, 'copy');
  assert.deepEqual(h.shares, [[['api'], 7, undefined]]);
  assert.equal(await h.investigator.investigate({ ...boom, eventId: 99 }, 'copy'), undefined);
  assert.match(h.messages.at(-1)!, /no longer in the retained logs/);
});

test('after the handoff, the error happening again in a new run is still failing', async () => {
  const h = harness();
  h.error(1);
  await h.investigator.investigate(boom, 'copy');
  h.investigator.check();
  assert.equal(h.messages.length, 1, 'nothing to say yet');
  h.runs.push({
    id: 'run-2',
    serverId: 'api',
    server: 'npm run dev',
    status: 'running',
    startedAt: Date.now() + 1,
    events: 1,
  });
  h.error(2, 'run-2');
  h.answerWarning('Show Error');
  h.investigator.check();
  assert.match(h.messages.at(-1)!, /Still failing\. Error: boom happened again in npm run dev\./);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.queries, ['id:2']);
  h.investigator.check();
  assert.equal(h.messages.filter((message) => message.includes('Still failing')).length, 1, 'said once');
});

test('a run that keeps going is fixed once it logs enough after a save without the error', async () => {
  const h = harness();
  h.error(1);
  h.runs.push({ id: 'run-1', serverId: 'api', server: 'npm run dev', status: 'running', startedAt: 0, events: 1 });
  await h.investigator.investigate(boom, 'copy');
  h.save();
  for (let id = 2; id < 60; id++)
    h.store.add({ id, level: 'info', message: 'ok', serverId: 'api', sessionId: 'run-1' });
  h.investigator.check();
  assert.match(
    h.messages.at(-1)!,
    /Fixed locally\. Error: boom did not happen in 58 events from npm run dev since the change\. No other errors/,
  );
});

test('the command without an error lists the error groups to choose from', async () => {
  const h = harness();
  assert.equal(await h.commands.get('logline.investigate')!(), undefined);
  assert.match(h.messages[0], /No errors/);
  h.error(1);
  h.error(2);
  assert.equal(await h.commands.get('logline.investigate')!(), 'copy');
  assert.match(h.clipboard(), /`Error: boom` \(2 times\)/);
});

test('an error from a source not shared yet is added to what is shared, so the agent can read it', async () => {
  const h = harness({ sharedSource: 'web' });
  h.error(3, 'run-1');
  await h.investigator.investigate({ ...boom, eventId: 3 }, 'copy');
  assert.deepEqual(h.shares, [[['web', 'api'], undefined, ['web-run', 'run-1']]]);
  assert.match(h.clipboard(), /Start with event id 3/);
});

test('captured events are checked once for a burst, not on every notification', async () => {
  const h = harness();
  h.error(1);
  h.investigator.schedule(0);
  await h.investigator.investigate(boom, 'copy');
  h.runs.push({
    id: 'run-2',
    serverId: 'api',
    server: 'npm run dev',
    status: 'running',
    startedAt: Date.now() + 1,
    events: 1,
  });
  h.error(2, 'run-2');
  h.investigator.schedule(0);
  h.investigator.schedule(0);
  assert.ok(!h.messages.some((message) => message.includes('Still failing')), 'not yet');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.messages.filter((message) => message.includes('Still failing')).length, 1);
  h.investigator.dispose();
});
