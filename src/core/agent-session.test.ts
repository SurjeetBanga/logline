import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentSessionParser,
  agentSource,
  claudeProjectDir,
  embeddedCommand,
  exitCodeOf,
  headline,
  within,
  type AgentRecord,
} from './agent-session';

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();
const feed = (parser: AgentSessionParser, ...entries: unknown[]): AgentRecord[] =>
  entries.flatMap((entry) => parser.line(JSON.stringify(entry)));

const CWD = '/work/shop';

test('helpers: source, headline, exit code, project directory, and folder membership', () => {
  assert.deepEqual(agentSource('claude-code'), { serverId: 'agent:claude-code', server: 'Claude Code' });
  assert.deepEqual(agentSource('codex'), { serverId: 'agent:codex', server: 'Codex' });
  assert.equal(headline('  first line\nsecond'), 'first line');
  assert.equal(headline('abcdefghij', 4), 'abcd…');
  assert.equal(headline('abcd', 4), 'abcd');
  assert.equal(exitCodeOf('Exit code 1\nFAIL'), 1);
  assert.equal(exitCodeOf('Exit code: -2'), -2);
  assert.equal(exitCodeOf('Process exited with code 127'), 127);
  assert.equal(exitCodeOf('all good'), undefined);
  assert.equal(claudeProjectDir('/Users/me/my.app_1'), '-Users-me-my-app-1');
  assert.equal(within('/work/shop', '/work/shop'), true);
  assert.equal(within('/work/shop/api', '/work/shop/'), true);
  assert.equal(within('C:\\work\\shop\\api', 'C:\\work\\shop'), true);
  assert.equal(within('/work/shop2', '/work/shop'), false);
  assert.equal(within(undefined, '/work/shop'), false);
  assert.equal(embeddedCommand('exec_command({cmd:"npm test"})'), 'npm test');
  assert.equal(embeddedCommand('exec({"cmd": "echo \\"hi\\""})'), 'echo "hi"');
  assert.equal(embeddedCommand('nothing here'), undefined);
});

test('Claude Code: prompts, tool calls with their result, replies, title, and tokens counted once', () => {
  const parser = new AgentSessionParser('claude-code');
  const base = { sessionId: 's1', cwd: CWD };
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 };
  const tool = {
    type: 'assistant',
    ...base,
    timestamp: iso(1),
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
      usage,
    },
  };
  const records = feed(
    parser,
    { type: 'user', ...base, timestamp: iso(0), message: { role: 'user', content: 'Fix the checkout 500' } },
    tool,
    // The same reply again, as Claude Code writes one line per content part.
    { ...tool, message: { ...tool.message, content: [{ type: 'text', text: 'Running the tests\nnow' }] } },
    {
      type: 'user',
      timestamp: iso(4),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Exit code 1\nFAIL charge.test.ts' },
        ],
      },
    },
    { type: 'ai-title', sessionId: 's1', aiTitle: 'Fix checkout 500' },
  );
  assert.deepEqual(
    records.map((record) => [record.action, record.level, record.message]),
    [
      ['prompt', 'info', 'Fix the checkout 500'],
      ['reply', 'info', 'Running the tests'],
      ['tool', 'error', 'Bash  npm test  exit 1'],
    ],
  );
  const call = records[2];
  assert.equal(call.kind, 'agent');
  assert.equal(call.agent, 'claude-code');
  assert.equal(call.session, 's1');
  assert.equal(call.tool, 'Bash');
  assert.equal(call.command, 'npm test');
  assert.equal(call.exitCode, 1);
  assert.equal(call.durationMs, 3000);
  assert.equal(call.timestamp, iso(1));
  assert.equal(call.model, 'claude-opus-5-5');
  assert.match(call.output!, /FAIL charge\.test\.ts/);
  assert.deepEqual(parser.info.tokens, { input: 15, output: 20, cached: 100 });
  assert.equal(parser.info.toolCalls, 1);
  assert.equal(parser.info.failedCalls, 1);
  assert.equal(parser.info.cwd, CWD);
  assert.equal(parser.info.title, 'Fix checkout 500');
  assert.equal(parser.label, 'Fix checkout 500');
  assert.equal(parser.info.startedAt, T0);
  assert.equal(parser.info.lastAt, T0 + 4000);
});

test('Claude Code: a changed usage for the same reply replaces the earlier one', () => {
  const parser = new AgentSessionParser('claude-code');
  const reply = (output: number) => ({
    type: 'assistant',
    timestamp: iso(0),
    message: { id: 'm', content: [], usage: { input_tokens: 1, output_tokens: output } },
  });
  feed(parser, reply(5), reply(9));
  assert.deepEqual(parser.info.tokens, { input: 1, output: 9, cached: 0 });
});

test('Claude Code: meta lines, reminders, sidechains, and junk never become prompts', () => {
  const parser = new AgentSessionParser('claude-code');
  const records = feed(
    parser,
    {
      type: 'user',
      isMeta: true,
      timestamp: iso(0),
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    },
    { type: 'user', timestamp: iso(0), message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    {
      type: 'user',
      timestamp: iso(0),
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x' }] },
    },
    { type: 'user', isSidechain: true, timestamp: iso(0), message: { role: 'user', content: 'sub agent task' } },
    { type: 'user', timestamp: iso(0), message: { role: 'user', content: [{ type: 'text', text: 'Add a test' }] } },
  );
  assert.deepEqual(
    records.map((record) => record.message),
    ['Add a test'],
  );
  assert.deepEqual(parser.line(''), []);
  assert.deepEqual(parser.line('not json'), []);
  assert.deepEqual(parser.line('[1]'), []);
  assert.deepEqual(parser.line('null'), []);
});

test('Claude Code: file tools are relative to the folder, other tools summarised, summary lines title', () => {
  const parser = new AgentSessionParser('claude-code');
  const call = (id: string, name: string, input: unknown) => ({
    type: 'assistant',
    cwd: CWD,
    timestamp: iso(0),
    message: { id: `m${id}`, content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (id: string, content: unknown, extra: object = {}) => ({
    type: 'user',
    timestamp: iso(1),
    ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const records = feed(
    parser,
    call('a', 'Edit', { file_path: `${CWD}/src/a.ts` }),
    result('a', 'ok'),
    call('b', 'Read', { file_path: '/etc/hosts' }),
    result('b', 'ok'),
    call('c', 'Grep', { pattern: 'TODO' }),
    result('c', [{ type: 'text', text: 'Process exited with code 2' }]),
    call('d', 'Bash', { command: 'ls' }),
    result('d', '', { toolUseResult: { stdout: 'out', stderr: 'Exit code 3' } }),
    call('e', 'Bash', { command: 'false' }),
    result('e', '', {}),
    { type: 'summary', summary: 'A summary title' },
  );
  assert.equal(records[0].file, 'src/a.ts');
  assert.equal(records[0].message, 'Edit  src/a.ts');
  assert.equal(records[1].file, '/etc/hosts');
  assert.equal(records[2].message, 'Grep  TODO  exit 2');
  assert.equal(records[2].level, 'error');
  assert.equal(records[3].exitCode, 3);
  assert.equal(records[4].level, 'info');
  assert.equal(records[4].exitCode, undefined);
  assert.equal(parser.info.title, 'A summary title');
  // A result with no call waiting is dropped.
  assert.deepEqual(feed(parser, result('zzz', 'x')), []);
});

const codexBase = { timestamp: iso(0) };
const meta = [
  { ...codexBase, type: 'session_meta', payload: { id: 's1', cwd: CWD } },
  { ...codexBase, type: 'turn_context', payload: { model: 'gpt-x', cwd: '/ignored' } },
];
const item = (offset: number, payload: unknown) => ({ timestamp: iso(offset), type: 'response_item', payload });

test('Codex: prompt, script tool run as shell, wall time, and replies', () => {
  const parser = new AgentSessionParser('codex');
  const records = feed(
    parser,
    ...meta,
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add retries' }] }),
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] }),
    item(2, {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'c1',
      input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
    }),
    item(5, {
      type: 'custom_tool_call_output',
      call_id: 'c1',
      output: '[{"type":"input_text","text":"Script completed\\nWall time 1.5 seconds\\nOutput:\\n"}]',
    }),
    item(6, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.\nMore' }] }),
  );
  assert.deepEqual(
    records.map((record) => [record.action, record.message]),
    [
      ['prompt', 'Add retries'],
      ['tool', 'shell  npm test'],
      ['reply', 'Done.'],
    ],
  );
  assert.equal(records[1].tool, 'shell');
  assert.equal(records[1].command, 'npm test');
  assert.equal(records[1].durationMs, 1500);
  assert.equal(records[1].level, 'info');
  assert.equal(records[1].model, 'gpt-x');
  assert.equal(records[1].session, 's1');
  assert.equal(parser.info.cwd, CWD);
  assert.equal(parser.label, 'Add retries');
});

test('Codex: function calls with a command list, JSON output exit codes, and failures', () => {
  const parser = new AgentSessionParser('codex');
  const records = feed(
    parser,
    ...meta,
    item(1, {
      type: 'function_call',
      name: 'shell',
      call_id: 'f1',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }),
    }),
    item(3, {
      type: 'function_call_output',
      call_id: 'f1',
      output: JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } }),
    }),
    item(4, { type: 'local_shell_call', call_id: 'f2', action: { command: ['git', 'status'] } }),
    item(5, { type: 'local_shell_call_output', call_id: 'f2', output: 'plain output' }),
    item(6, {
      type: 'function_call',
      name: 'plan',
      call_id: 'f3',
      arguments: JSON.stringify({ title: 'Make a plan' }),
    }),
    item(7, { type: 'function_call_output', call_id: 'f3', output: 'Error: nope' }),
    item(8, { type: 'function_call', name: 'raw', call_id: 'f4', arguments: 'not json' }),
    item(9, { type: 'function_call_output', call_id: 'f4', output: { type: 'x' } }),
    item(10, { type: 'function_call_output', call_id: 'unknown', output: 'x' }),
    item(11, { type: 'reasoning' }),
  );
  assert.equal(records.length, 4);
  const [first, second, third, fourth] = records;
  assert.equal(first.command, 'bash -lc ls');
  assert.equal(first.exitCode, 2);
  assert.equal(first.level, 'error');
  assert.equal(first.durationMs, 2000);
  assert.match(first.output!, /boom/);
  assert.equal(second.command, 'git status');
  assert.equal(second.level, 'info');
  assert.equal(third.level, 'error');
  assert.equal(third.message, 'plan  Make a plan  failed');
  assert.equal(fourth.message, 'raw  not json');
  assert.equal(parser.info.toolCalls, 4);
  assert.equal(parser.info.failedCalls, 2);
});

test('Codex: token counts are totals with the cached share taken out of input', () => {
  const parser = new AgentSessionParser('codex');
  feed(parser, {
    timestamp: iso(0),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } },
    },
  });
  assert.deepEqual(parser.info.tokens, { input: 40, output: 7, cached: 60 });
  feed(parser, { timestamp: iso(1), type: 'event_msg', payload: { type: 'token_count', info: null } });
  feed(parser, { timestamp: iso(1), type: 'event_msg', payload: { type: 'agent_message' } });
  assert.deepEqual(parser.info.tokens, { input: 40, output: 7, cached: 60 });
  assert.deepEqual(feed(parser, { type: 'compacted' }, { type: 'response_item' }), []);
});

test('a session never answers more tool calls than it can hold', () => {
  const parser = new AgentSessionParser('claude-code');
  const calls = Array.from({ length: 600 }, (_, i) => ({
    type: 'assistant',
    timestamp: iso(0),
    message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'x' } }] },
  }));
  feed(parser, ...calls);
  const result = (id: string) => ({
    type: 'user',
    timestamp: iso(1),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
  assert.equal(feed(parser, result('t0')).length, 0, 'the oldest call was dropped');
  assert.equal(feed(parser, result('t599')).length, 1);
});

test('Copilot CLI: prompt, tool calls with their exit code, replies, model, and tokens', () => {
  const parser = new AgentSessionParser('copilot');
  const event = (type: string, at: number, data: unknown) => ({ type, timestamp: iso(at), id: type, data });
  const records = feed(
    parser,
    event('session.start', 0, { sessionId: 'cli-1', context: { cwd: CWD } }),
    event('session.model_change', 0, { newModel: 'auto' }),
    event('session.auto_mode_resolved', 0, { chosenModel: 'gpt-test' }),
    event('user.message', 1, { content: 'Fix the checkout 500', transformedContent: '<context>…</context>' }),
    event('assistant.message', 2, { content: 'Running the tests.', model: 'gpt-test' }),
    event('tool.execution_start', 2, { toolCallId: 't1', toolName: 'bash', arguments: { command: 'npm test' } }),
    event('tool.execution_start', 3, { toolCallId: 't2', toolName: 'view', arguments: { path: `${CWD}/src/a.ts` } }),
    event('tool.execution_complete', 4, { toolCallId: 't2', success: true, result: { content: 'code' } }),
    event('tool.execution_complete', 6, {
      toolCallId: 't1',
      success: true,
      shellExecution: { exitCode: 1 },
      result: { content: 'FAIL charge.test.ts' },
    }),
    event('tool.execution_start', 7, { toolCallId: 't3', toolName: 'edit', arguments: { path: '/elsewhere/b.ts' } }),
    event('tool.execution_complete', 8, { toolCallId: 't3', success: false, error: { message: 'No such file' } }),
    event('session.usage_record', 8, { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 } }),
    event('session.usage_record', 9, { usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0 } }),
    event('session.shutdown', 10, { tokenDetails: { input: { tokenCount: 9999 } } }),
    event('hook.start', 10, {}),
  );
  assert.deepEqual(
    records.map((record) => [record.action, record.level, record.message]),
    [
      ['prompt', 'info', 'Fix the checkout 500'],
      ['reply', 'info', 'Running the tests.'],
      ['tool', 'info', 'view  src/a.ts'],
      ['tool', 'error', 'bash  npm test  exit 1'],
      ['tool', 'error', 'edit  /elsewhere/b.ts  failed'],
    ],
  );
  const [, , view, bash, edit] = records;
  assert.equal(view.file, 'src/a.ts');
  assert.equal(bash.command, 'npm test');
  assert.equal(bash.exitCode, 1);
  assert.equal(bash.durationMs, 4000);
  assert.equal(bash.timestamp, iso(2));
  assert.match(bash.output!, /FAIL charge\.test\.ts/);
  assert.equal(edit.output, 'No such file');
  assert.ok(records.every((record) => record.agent === 'copilot' && record.session === 'cli-1'));
  assert.equal(bash.model, 'gpt-test');
  assert.equal(parser.info.cwd, CWD);
  assert.equal(parser.label, 'Fix the checkout 500');
  assert.equal(parser.info.toolCalls, 3);
  assert.equal(parser.info.failedCalls, 2);
  // Each model call's usage is counted; the totals at shutdown are not added to it.
  assert.deepEqual(parser.info.tokens, { input: 90, output: 25, cached: 60 });
  assert.deepEqual(agentSource('copilot'), { serverId: 'agent:copilot', server: 'Copilot' });
});

test('Copilot CLI: a session that recorded only its totals counts them at shutdown, and errors are logged', () => {
  const parser = new AgentSessionParser('copilot');
  const records = feed(
    parser,
    {
      type: 'session.shutdown',
      timestamp: iso(5),
      data: {
        tokenDetails: {
          input: { tokenCount: 10 },
          cache_write: { tokenCount: 30 },
          cache_read: { tokenCount: 500 },
          output: { tokenCount: 7 },
        },
      },
    },
    { type: 'session.error', timestamp: iso(6), data: { message: 'Rate limited' } },
    { type: 'session.error', timestamp: iso(6), data: {} },
    { type: 'user.message', timestamp: iso(7), data: { content: '<reminder>' } },
  );
  assert.deepEqual(parser.info.tokens, { input: 40, output: 7, cached: 500 });
  assert.deepEqual(
    records.map((record) => [record.level, record.message]),
    [['error', 'Rate limited']],
  );
});

/** A Copilot Chat request as VS Code keeps it. */
function chatRequest(id: string, at: number, text: string, response: unknown[] = []) {
  return { requestId: id, timestamp: T0 + at * 1000, message: { text }, modelId: 'copilot/auto', response, agent: {} };
}
const tool = (id: string, toolId: string, fields: Record<string, unknown> = {}) => ({
  kind: 'toolInvocationSerialized',
  toolCallId: id,
  toolId,
  isComplete: true,
  isConfirmed: { type: 1 },
  ...fields,
});

test('Copilot Chat: replaying the session logs each prompt, finished tool call, and reply once', () => {
  const parser = new AgentSessionParser('copilot');
  parser.info.cwd = CWD;
  const first = feed(parser, {
    kind: 0,
    v: {
      version: 3,
      sessionId: 'chat-1',
      creationDate: T0,
      requests: [
        chatRequest('r1', 1, 'Why does checkout fail?', [
          { kind: 'thinking', value: 'hmm' },
          tool('c1', 'copilot_readFile', {
            pastTenseMessage: { value: `Read [](file://${CWD}/src/pay%20ment.ts#1-20), lines 1 to 20` },
            resultDetails: { input: '{}', output: [{ value: 'big' }] },
          }),
          tool('c2', 'run_in_terminal', { isComplete: false, invocationMessage: 'Running' }),
        ]),
      ],
    },
  });
  assert.deepEqual(
    first.map((record) => [record.action, record.message]),
    [
      ['prompt', 'Why does checkout fail?'],
      ['tool', 'copilot_readFile  Read src/pay ment.ts, lines 1 to 20'],
    ],
  );
  assert.equal(first[1].file, 'src/pay ment.ts');
  assert.equal(first[1].timestamp, new Date(T0 + 1000).toISOString());
  // The terminal call finishes, a denied call is added, and the request ends with its reply and tokens.
  const later = feed(
    parser,
    {
      kind: 1,
      k: ['requests', 0, 'response', 2],
      v: tool('c2', 'run_in_terminal', {
        toolSpecificData: {
          kind: 'terminal',
          commandLine: { original: 'npm tset', userEdited: 'npm test' },
          terminalCommandState: { exitCode: 1, timestamp: T0 + 3000, duration: 1500 },
          terminalCommandOutput: { text: 'FAIL charge.test.ts' },
        },
      }),
    },
    {
      kind: 2,
      k: ['requests', 0, 'response'],
      v: [tool('c3', 'mcp_deploy', { isConfirmed: { type: 0 }, invocationMessage: 'Deploying' })],
    },
    {
      kind: 2,
      k: ['requests', 0, 'response'],
      v: [{ value: 'The card ' }, { value: 'is expired.', supportHtml: false }],
    },
    { kind: 1, k: ['requests', 0, 'promptTokens'], v: 120 },
    { kind: 1, k: ['requests', 0, 'completionTokens'], v: 30 },
    { kind: 1, k: ['requests', 0, 'elapsedMs'], v: 9000 },
    {
      kind: 1,
      k: ['requests', 0, 'result'],
      v: { metadata: { resolvedModel: 'gpt-test', renderedUserMessage: [{}] } },
    },
    { kind: 1, k: ['customTitle'], v: 'Checkout failure' },
  );
  assert.deepEqual(
    later.map((record) => [record.action, record.level, record.message]),
    [
      ['tool', 'error', 'run_in_terminal  npm test  exit 1'],
      ['tool', 'warn', 'mcp_deploy  Deploying  denied'],
      ['reply', 'info', 'The card is expired.'],
    ],
  );
  const [terminal, , reply] = later;
  assert.equal(terminal.command, 'npm test');
  assert.equal(terminal.exitCode, 1);
  assert.equal(terminal.durationMs, 1500);
  assert.equal(terminal.timestamp, new Date(T0 + 3000).toISOString());
  assert.equal(terminal.output, 'FAIL charge.test.ts');
  assert.equal(reply.timestamp, new Date(T0 + 10_000).toISOString());
  assert.equal(reply.model, 'gpt-test');
  assert.equal(parser.info.id, 'chat-1');
  assert.equal(parser.label, 'Checkout failure');
  assert.equal(parser.info.toolCalls, 3);
  assert.equal(parser.info.failedCalls, 1);
  assert.deepEqual(parser.info.tokens, { input: 120, output: 30, cached: 0 });
  // The file rewritten from the start, as VS Code does when it compacts it, logs nothing again.
  const again = feed(parser, { kind: 0, v: { sessionId: 'chat-1', requests: [] } });
  assert.deepEqual(again, []);
});

test('Copilot Chat: a failed request is an error, and a new request after it is read', () => {
  const parser = new AgentSessionParser('copilot');
  feed(parser, { kind: 0, v: { sessionId: 'chat-2', requests: [] } });
  const records = feed(
    parser,
    { kind: 2, k: ['requests'], v: [chatRequest('r1', 1, 'Deploy it')] },
    {
      kind: 1,
      k: ['requests', 0, 'result'],
      v: { errorDetails: { message: 'Sorry, the request failed.' } },
    },
    { kind: 1, k: ['requests', 0, 'elapsedMs'], v: 2000 },
    { kind: 2, k: ['requests'], v: [chatRequest('r2', 5, 'Try again')] },
    { kind: 1, k: ['requests', 1, 'modelState'], v: { value: 1, completedAt: T0 + 7000 } },
    { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'Done.' }] },
    { kind: 1, k: ['requests', 1, 'result'], v: {} },
    { kind: 1, k: ['nowhere', 'deep'], v: 1 },
    'not an object',
  );
  assert.deepEqual(
    records.map((record) => [record.action, record.level, record.message, record.timestamp]),
    [
      ['prompt', 'info', 'Deploy it', new Date(T0 + 1000).toISOString()],
      ['reply', 'error', 'Sorry, the request failed.', new Date(T0 + 1000).toISOString()],
      ['prompt', 'info', 'Try again', new Date(T0 + 5000).toISOString()],
      ['reply', 'info', 'Done.', new Date(T0 + 7000).toISOString()],
    ],
  );
});
