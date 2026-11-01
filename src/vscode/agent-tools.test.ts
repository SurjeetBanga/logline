import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

const registrations = new Map<string, any>();
const { registerAgentTools, runAgentTool } = withVscode(
  {
    lm: {
      registerTool: (name: string, tool: unknown) => {
        registrations.set(name, tool);
        return {
          dispose() {
            registrations.delete(name);
          },
        };
      },
    },
    MarkdownString: class {
      constructor(readonly value: string) {}
    },
  },
  () => require('./agent-tools') as typeof import('./agent-tools'),
);

test('agent tools register all actions, format bounded results, and translate validation errors', async () => {
  registrations.clear();
  const access = {
    status: () => ({ scope: 'selected', sources: [{ runs: [{ id: 'run' }] }] }),
    list: () => ({ active: true, sources: [] }),
    search: () => ({
      events: Array.from({ length: 400 }, (_, id) => ({ id, message: 'x'.repeat(400) })),
      matched: 400,
      newest: 400,
      partial: true,
      hasMore: true,
    }),
    inspect: () => ({ event: { id: 1 }, details: '', exceptions: [], context: [] }),
    analyze: () => ({ coverage: { matched: 1 } }),
    wait: async () => ({ events: [], matched: 0, newest: 1, partial: false, hasMore: false }),
    trace: (shareId: string, traceId: string) => ({ traceId, shareId, spans: [] }),
    aiCalls: (input: { shareId: string }) => ({ shareId: input.shareId, calls: [] }),
    production: { connections: () => [{ id: 'prod', label: 'Datadog · prod', type: 'datadog', agents: true }] },
    fetchProduction: async (input: { connectionId: string }) => ({ runId: 'r1', connection: input.connectionId }),
    compareWithProduction: (input: { prodRunId: string }) => ({ summary: `compared ${input.prodRunId}` }),
  } as any;
  const disposables = registerAgentTools({} as any, access);
  assert.equal(registrations.size, 9);
  assert.equal(disposables.length, 9);
  const prepared = await registrations.get('logline_search_logs').prepareInvocation({ input: {} });
  assert.match(prepared.invocationMessage, /Reading shared/);
  // Fetching production reaches outside the editor, so its confirmation names where and how much.
  const production = await registrations
    .get('logline_fetch_production')
    .prepareInvocation({ input: { connectionId: 'prod', query: 'level:error', range: '4h' } });
  assert.equal(production.invocationMessage, 'Fetching production logs from Datadog · prod');
  assert.equal(production.confirmationMessages.title, 'Fetch production logs from Datadog · prod');
  assert.match(production.confirmationMessages.message.value, /level:error from the last 4h/);
  const byTrace = await registrations
    .get('logline_fetch_production')
    .prepareInvocation({ input: { connectionId: 'other', traceId: 't1' } });
  assert.match(byTrace.confirmationMessages.message.value, /trace t1 from the last 1h/);
  assert.match(
    (await registrations.get('logline_fetch_production').invoke({ input: { connectionId: 'prod' } })).content[0].value,
    /"runId":"r1"/,
  );
  assert.match(
    (await registrations.get('logline_compare_with_production').invoke({ input: { prodRunId: 'r1' } })).content[0]
      .value,
    /compared r1/,
  );
  const result = await registrations.get('logline_search_logs').invoke({ input: { shareId: 'share' } });
  const text = result.content[0].value;
  assert.ok(Buffer.byteLength(text, 'utf8') <= 64 * 1024);
  assert.match(text, /"truncated":true/);
  assert.match(text, /"hasMore":true/);
  const invalid = await registrations.get('logline_inspect_event').invoke({ input: { shareId: 'share', id: -1 } });
  assert.match(invalid.content[0].value, /INVALID_INPUT/);
  await registrations.get('logline_list_shared_sources').invoke({ input: {} });
  await registrations.get('logline_analyze_logs').invoke({ input: { shareId: 'share' } });
  await registrations.get('logline_wait_for_logs').invoke({ input: { shareId: 'share', watermark: 0 } });
  const trace = await registrations.get('logline_get_trace').invoke({ input: { shareId: 'share', traceId: 'abc' } });
  assert.match(trace.content[0].value, /"traceId":"abc"/);
  const missing = await registrations.get('logline_get_trace').invoke({ input: { shareId: 'share' } });
  assert.match(missing.content[0].value, /INVALID_INPUT/);
  const calls = await registrations.get('logline_get_ai_calls').invoke({ input: { shareId: 'share' } });
  assert.match(calls.content[0].value, /"calls":\[\]/);
  for (const disposable of disposables) disposable.dispose();
  assert.equal(registrations.size, 0);
});

test('each tool call is counted by tool, route, client, and outcome, never by what it asked or returned', async () => {
  registrations.clear();
  const calls: Record<string, unknown>[] = [];
  const usage = { agentTool: (call: Record<string, unknown>) => calls.push(call) } as any;
  const access = {
    status: () => ({ scope: 'all', sources: [] }),
    search: () => ({ events: [{ id: 1, message: 'secret order 42' }], matched: 1 }),
    trace: () => {
      throw new Error('no such trace');
    },
  } as any;
  registerAgentTools({} as any, access, usage);
  await registrations.get('logline_search_logs').invoke({ input: { shareId: 'share', query: 'user:42' } });
  const text = await runAgentTool(access, 'logline_get_trace', { shareId: 'share', traceId: 'abc' }, undefined, {
    usage,
    client: 'claude-code 2.1',
  });
  assert.match(text, /INVALID_INPUT/);
  await runAgentTool(access, 'logline_search_logs', {}, undefined, { usage, client: 'some-bot' });
  assert.deepEqual(
    calls.map(({ tool, via, client, ok, code, truncated }) => ({ tool, via, client, ok, code, truncated })),
    [
      { tool: 'logline_search_logs', via: 'copilot', client: 'copilot', ok: true, code: undefined, truncated: false },
      {
        tool: 'logline_get_trace',
        via: 'mcp',
        client: 'claude-code',
        ok: false,
        code: 'INVALID_INPUT',
        truncated: false,
      },
      { tool: 'logline_search_logs', via: 'mcp', client: 'other', ok: true, code: undefined, truncated: false },
    ],
  );
  assert.ok(calls.every((call) => typeof call.ms === 'number' && typeof call.resultSize === 'number'));
  assert.doesNotMatch(JSON.stringify(calls), /secret|user:42|abc/);
});
