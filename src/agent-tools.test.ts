import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

const registrations = new Map<string, any>();
const { registerAgentTools } = withVscode({
  lm: { registerTool: (name: string, tool: unknown) => { registrations.set(name, tool); return { dispose() { registrations.delete(name); } }; } },
  MarkdownString: class { constructor(readonly value: string) {} }
}, () => require('./vscode/agent-tools') as typeof import('./vscode/agent-tools'));

test('agent tools register all actions, format bounded results, and translate validation errors', async () => {
  registrations.clear();
  const access = {
    status: () => ({ scope: 'selected', sources: [{ runs: [{ id: 'run' }] }] }),
    list: () => ({ active: true, sources: [] }),
    search: () => ({ events: Array.from({ length: 400 }, (_, id) => ({ id, message: 'x'.repeat(400) })), matched: 400, newest: 400, partial: true, hasMore: true }),
    inspect: () => ({ event: { id: 1 }, details: '', exceptions: [], context: [] }),
    analyze: () => ({ coverage: { matched: 1 } }),
    wait: async () => ({ events: [], matched: 0, newest: 1, partial: false, hasMore: false })
  } as any;
  const disposables = registerAgentTools({} as any, access);
  assert.equal(registrations.size, 5);
  assert.equal(disposables.length, 5);
  const prepared = await registrations.get('logline_search_logs').prepareInvocation({ input: {} });
  assert.match(prepared.invocationMessage, /Reading shared/);
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
  for (const disposable of disposables) disposable.dispose();
  assert.equal(registrations.size, 0);
});
