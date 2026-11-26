import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeProjectDir } from '../core/agent-session';
import { LogStore } from '../core/log-store';
import { AGENT_HINT_SCAN_MS, AGENT_IDLE_MS, AgentSessionCapture, sessionDetail } from './agent-sessions';
import { Ingestion } from './ingestion';
import { RuntimeState } from './runtime-state';
import { SessionRegistry } from './session-registry';

const NOW = Date.now();
const iso = (offsetSeconds: number) => new Date(NOW - 60_000 + offsetSeconds * 1000).toISOString();

function setup(enabled: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'logline-agents-'));
  const folder = join(root, 'shop');
  const claudeDir = join(root, 'claude');
  const codexDir = join(root, 'codex');
  mkdirSync(folder);
  const store = new LogStore();
  const registry = new SessionRegistry();
  let notified = 0;
  const state = new RuntimeState(() => void notified++);
  const settings: Record<string, unknown> = { 'agentSessions.enabled': enabled };
  const config = { get: <T>(key: string, fallback: T) => (key in settings ? settings[key] : fallback) as T };
  const capture = new AgentSessionCapture(config, registry, new Ingestion(store, () => undefined), state, {
    claudeDir,
    codexDir,
    now: () => clock.now,
  });
  const clock = { now: NOW };
  capture.folders = () => [folder];
  const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  const claudeFile = (name = 'x.jsonl', dir = claudeProjectDir(folder)) => {
    mkdirSync(join(claudeDir, 'projects', dir), { recursive: true });
    return join(claudeDir, 'projects', dir, name);
  };
  return {
    root,
    folder,
    store,
    registry,
    capture,
    clock,
    settings,
    jsonl,
    claudeFile,
    codexDir,
    notified: () => notified,
    cleanup: () => {
      capture.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const claudeSession = (cwd: string) => [
  { type: 'user', sessionId: 'c1', cwd, timestamp: iso(0), message: { role: 'user', content: 'Fix the checkout 500' } },
  {
    type: 'assistant',
    sessionId: 'c1',
    cwd,
    timestamp: iso(1),
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  },
  {
    type: 'user',
    timestamp: iso(3),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Exit code 1\nFAIL charge.test.ts' },
      ],
    },
  },
];

test('nothing is read while agent sessions are off', async () => {
  const t = setup(false);
  try {
    writeFileSync(t.claudeFile(), t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    assert.equal(t.capture.enabled, false);
    assert.equal(t.capture.active, 0);
    assert.equal(t.store.all().length, 0);
    assert.equal(t.registry.records.size, 0);
  } finally {
    t.cleanup();
  }
});

test('a Claude Code session in the folder becomes a run with an event per step', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    const events = t.store.all();
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.serverId === 'agent:claude-code' && event.server === 'Claude Code'));
    const [prompt, tool] = events;
    assert.equal(prompt.message, 'Fix the checkout 500');
    assert.equal(prompt.fields?.action, 'prompt');
    assert.equal(tool.level, 'error');
    assert.equal(tool.fields?.kind, 'agent');
    assert.equal(tool.fields?.agent, 'claude-code');
    assert.equal(tool.fields?.action, 'tool');
    assert.equal(tool.fields?.tool, 'Bash');
    assert.equal(tool.fields?.command, 'npm test');
    assert.equal(tool.fields?.exitCode, 1);
    assert.equal(tool.fields?.durationMs, 2000);
    const [run] = [...t.registry.records.values()];
    assert.equal(run.serverId, 'agent:claude-code');
    assert.equal(run.sourceKind, 'agent');
    assert.equal(run.events, 2);
    assert.equal(run.command, 'Fix the checkout 500');
    assert.equal(run.cwd, t.folder);
    assert.equal(run.status, 'running');
    assert.equal(run.canStop, false);
    assert.equal(tool.sessionId, run.id);
    assert.equal(t.capture.active, 1);
    assert.ok(t.notified() > 0);

    // Appended lines are read on the next poll.
    appendFileSync(
      file,
      t.jsonl(
        { type: 'ai-title', aiTitle: 'Fix checkout 500' },
        {
          type: 'assistant',
          timestamp: iso(5),
          message: { id: 'msg_2', content: [{ type: 'text', text: 'All fixed' }] },
        },
      ),
    );
    await t.capture.poll();
    assert.equal(t.store.all().length, 3);
    assert.equal(t.store.all()[2].message, 'All fixed');
    assert.equal(run.command, 'Fix checkout 500');
    assert.equal(run.events, 3);
  } finally {
    t.cleanup();
  }
});

test('a session that worked in another folder is ignored', async () => {
  const t = setup(true);
  try {
    // Filed under this folder's name, but its own cwd is elsewhere.
    writeFileSync(t.claudeFile(), t.jsonl(...claudeSession(join(t.root, 'other'))));
    // And a project folder named for another folder is never listed.
    writeFileSync(
      t.claudeFile('y.jsonl', claudeProjectDir(join(t.root, 'other'))),
      t.jsonl(...claudeSession(t.folder)),
    );
    await t.capture.poll();
    assert.equal(t.store.all().length, 0);
    assert.equal(t.registry.records.size, 0);
    assert.equal(t.capture.active, 0);
  } finally {
    t.cleanup();
  }
});

test('a Codex session reads its folder from session_meta', async () => {
  const t = setup(true);
  try {
    const dir = join(t.codexDir, 'sessions', '2026', '11', '15');
    mkdirSync(dir, { recursive: true });
    const item = (offset: number, payload: unknown) => ({ timestamp: iso(offset), type: 'response_item', payload });
    writeFileSync(
      join(dir, 'rollout-2026-11-15T10-00-00-abc.jsonl'),
      t.jsonl(
        { timestamp: iso(0), type: 'session_meta', payload: { id: 's1', cwd: t.folder } },
        { timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-x' } },
        item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add retries' }] }),
        item(2, {
          type: 'function_call',
          name: 'shell',
          call_id: 'c1',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }),
        }),
        item(3, {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } }),
        }),
      ),
    );
    // Another folder's Codex session.
    writeFileSync(
      join(dir, 'rollout-other.jsonl'),
      t.jsonl(
        { timestamp: iso(0), type: 'session_meta', payload: { id: 's2', cwd: join(t.root, 'other') } },
        item(1, { type: 'message', role: 'user', content: 'hi' }),
      ),
    );
    await t.capture.poll();
    const events = t.store.all();
    assert.deepEqual(
      events.map((event) => event.message),
      ['Add retries', 'shell  bash -lc ls  exit 2'],
    );
    assert.equal(events[0].serverId, 'agent:codex');
    assert.equal(events[1].fields?.exitCode, 2);
    assert.equal(events[1].level, 'error');
    assert.equal(events[1].fields?.command, 'bash -lc ls');
  } finally {
    t.cleanup();
  }
});

test('a removed source is no longer read', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    t.capture.stopServer('agent:claude-code');
    assert.equal(t.capture.active, 0);
    appendFileSync(file, t.jsonl({ type: 'user', timestamp: iso(9), message: { role: 'user', content: 'More' } }));
    t.clock.now += 20_000;
    await t.capture.poll();
    assert.equal(t.store.all().length, 2);
  } finally {
    t.cleanup();
  }
});

test('a removed agent is offered again, ignores new sessions, and comes back when restored', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    assert.deepEqual(t.capture.hints, []);
    t.capture.stopServer('agent:claude-code');
    assert.deepEqual(t.capture.removedAgents, ['claude-code']);
    assert.deepEqual(t.capture.hints, [{ agent: 'claude-code', label: 'Claude Code', sessions: 1 }]);
    assert.equal(t.registry.records.size, 0);
    // A session it starts after the removal is not read either.
    writeFileSync(t.claudeFile('y.jsonl'), t.jsonl(...claudeSession(t.folder)));
    t.clock.now += 20_000;
    await t.capture.poll();
    assert.equal(t.capture.active, 0);
    assert.equal(t.capture.restore('codex'), false);
    assert.equal(t.capture.restore(), true);
    assert.deepEqual(t.capture.hints, []);
    await t.capture.poll();
    assert.equal(t.capture.active, 2);
    assert.equal(t.registry.records.size, 2);
  } finally {
    t.cleanup();
  }
});

test('turning agent sessions off forgets which agents were removed', async () => {
  const t = setup(true);
  try {
    writeFileSync(t.claudeFile(), t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    t.capture.stopServer('agent:claude-code');
    t.settings['agentSessions.enabled'] = false;
    await t.capture.poll();
    t.settings['agentSessions.enabled'] = true;
    assert.deepEqual(t.capture.removedAgents, []);
  } finally {
    t.cleanup();
  }
});

test('a session that stops growing is exited, and running again when it grows', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    const [run] = [...t.registry.records.values()];
    assert.equal(run.status, 'running');
    t.clock.now += AGENT_IDLE_MS + 1000;
    await t.capture.poll();
    assert.equal(run.status, 'exited');
    assert.ok(run.endedAt !== undefined);
    appendFileSync(file, t.jsonl({ type: 'user', timestamp: iso(9), message: { role: 'user', content: 'Again' } }));
    await t.capture.poll();
    assert.equal(run.status, 'running');
    assert.equal(run.endedAt, undefined);
  } finally {
    t.cleanup();
  }
});

test('turning agent sessions off stops following and ends the runs', async () => {
  const t = setup(true);
  try {
    writeFileSync(t.claudeFile(), t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    const [run] = [...t.registry.records.values()];
    t.settings['agentSessions.enabled'] = false;
    await t.capture.poll();
    assert.equal(t.capture.active, 0);
    assert.equal(run.status, 'exited');
    assert.equal(run.captureComplete, true);
  } finally {
    t.cleanup();
  }
});

test('sessions older than a day are not followed, and a session can be stopped by id', async () => {
  const t = setup(true);
  try {
    const old = t.claudeFile('old.jsonl');
    writeFileSync(old, t.jsonl(...claudeSession(t.folder)));
    const past = new Date(NOW - 3 * 24 * 3600_000);
    utimesSync(old, past, past);
    await t.capture.poll();
    assert.equal(t.capture.active, 0);
    writeFileSync(t.claudeFile('new.jsonl'), t.jsonl(...claudeSession(t.folder)));
    t.clock.now += 20_000;
    await t.capture.poll();
    assert.equal(t.capture.active, 1);
    const [run] = [...t.registry.records.values()];
    t.capture.stopSessionById(run.id);
    assert.equal(t.capture.active, 0);
  } finally {
    t.cleanup();
  }
});

test('a run says what it did, and the transcript it came from is known while it is followed', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    const [run] = [...t.registry.records.values()];
    assert.equal(run.detail, '1 tool · 1 failed · 30 tok');
    assert.equal(t.capture.transcriptOf(run.id), file);
    assert.equal(t.capture.transcriptOf('other'), undefined);
  } finally {
    t.cleanup();
  }
});

test('a session detail counts tools, failures, and tokens, leaving out what is zero', () => {
  const info = (toolCalls: number, failedCalls: number, input: number, output = 0, cached = 0) => ({
    toolCalls,
    failedCalls,
    tokens: { input, output, cached },
  });
  assert.equal(sessionDetail(info(3, 1, 1000, 100, 100)), '3 tools · 1 failed · 1.2k tok');
  assert.equal(sessionDetail(info(1, 0, 5)), '1 tool · 5 tok');
  assert.equal(sessionDetail(info(0, 0, 0)), '0 tools');
});

test('after a clear, a run counts only what its session did since, and old lines are not read again', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    const [run] = [...t.registry.records.values()];
    assert.equal(run.detail, '1 tool · 1 failed · 30 tok');
    t.store.clear();
    t.registry.clearCompleted();
    t.capture.cleared();
    assert.equal(run.events, 0);
    assert.equal(run.detail, '0 tools');
    assert.equal(t.registry.records.get(run.id), run, 'a running session keeps its run');
    appendFileSync(
      file,
      t.jsonl({
        type: 'assistant',
        timestamp: iso(5),
        message: { id: 'msg_2', content: [{ type: 'text', text: 'All fixed' }], usage: { output_tokens: 7 } },
      }),
    );
    await t.capture.poll();
    assert.deepEqual(
      t.store.all().map((event) => event.message),
      ['All fixed'],
    );
    assert.equal(run.events, 1);
    assert.equal(run.detail, '0 tools · 7 tok');
  } finally {
    t.cleanup();
  }
});

test('an ended session that a clear removed is listed again when it resumes', async () => {
  const t = setup(true);
  try {
    const file = t.claudeFile();
    writeFileSync(file, t.jsonl(...claudeSession(t.folder)));
    await t.capture.poll();
    const [run] = [...t.registry.records.values()];
    t.clock.now += AGENT_IDLE_MS + 1000;
    await t.capture.poll();
    assert.equal(run.status, 'exited');
    t.store.clear();
    t.registry.clearCompleted();
    t.capture.cleared();
    assert.equal(t.registry.records.size, 0);
    appendFileSync(file, t.jsonl({ type: 'user', timestamp: iso(9), message: { role: 'user', content: 'Again' } }));
    await t.capture.poll();
    assert.equal(t.registry.records.get(run.id), run);
    assert.equal(run.status, 'running');
    assert.equal(run.events, 1);
    assert.equal(t.store.all()[0].sessionId, run.id);
  } finally {
    t.cleanup();
  }
});

test('while agent sessions are off, the agents with sessions in the folder are offered, without following them', async () => {
  const t = setup(false);
  try {
    writeFileSync(t.claudeFile('a.jsonl'), t.jsonl(...claudeSession(t.folder)));
    writeFileSync(t.claudeFile('b.jsonl'), t.jsonl(...claudeSession(t.folder)));
    // A sibling folder whose name starts with this one's is filed under a matching prefix, but worked elsewhere.
    writeFileSync(
      t.claudeFile('c.jsonl', `${claudeProjectDir(t.folder)}-site`),
      t.jsonl(...claudeSession(`${t.folder}-site`)),
    );
    // A subfolder's session counts.
    writeFileSync(
      t.claudeFile('d.jsonl', `${claudeProjectDir(t.folder)}-api`),
      t.jsonl(...claudeSession(join(t.folder, 'api'))),
    );
    const dir = join(t.codexDir, 'sessions', '2026', '11', '15');
    mkdirSync(dir, { recursive: true });
    const meta = (cwd: string) => t.jsonl({ timestamp: iso(0), type: 'session_meta', payload: { id: 's', cwd } });
    writeFileSync(join(dir, 'rollout-here.jsonl'), meta(t.folder));
    writeFileSync(join(dir, 'rollout-other.jsonl'), meta(join(t.root, 'other')));
    const before = t.notified();
    await t.capture.poll();
    assert.deepEqual(
      t.capture.hints.map((hint) => ({ ...hint })),
      [
        { agent: 'claude-code', label: 'Claude Code', sessions: 3 },
        { agent: 'codex', label: 'Codex', sessions: 1 },
      ],
    );
    assert.ok(t.notified() > before, 'the panel hears of the offer');
    assert.equal(t.capture.active, 0);
    assert.equal(t.store.all().length, 0);
    assert.equal(t.registry.records.size, 0);

    // The folders are listed again only after a while.
    writeFileSync(join(dir, 'rollout-later.jsonl'), meta(t.folder));
    t.clock.now += 10_000;
    await t.capture.poll();
    assert.equal(t.capture.hints[1].sessions, 1);
    t.clock.now += AGENT_HINT_SCAN_MS;
    await t.capture.poll();
    assert.equal(t.capture.hints[1].sessions, 2);

    // Once on, nothing is offered: the sessions are shown.
    t.settings['agentSessions.enabled'] = true;
    assert.deepEqual(t.capture.hints, []);
    await t.capture.poll();
    assert.equal(t.capture.active, 5);
  } finally {
    t.cleanup();
  }
});

test('with no sessions in the folder, nothing is offered', async () => {
  const t = setup(false);
  try {
    writeFileSync(
      t.claudeFile('x.jsonl', claudeProjectDir(join(t.root, 'elsewhere'))),
      t.jsonl(...claudeSession(t.root)),
    );
    await t.capture.poll();
    assert.deepEqual(t.capture.hints, []);
  } finally {
    t.cleanup();
  }
});
