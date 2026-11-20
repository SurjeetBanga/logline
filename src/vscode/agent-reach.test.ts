import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const said: string[] = [];
const { AgentReachNotice, unreachableMessage } = withVscode(
  { window: { showWarningMessage: async (message: string) => void said.push(message) } },
  () => require('./agent-reach') as typeof import('./agent-reach'),
);

test('an agent that could not reach this window is said once a window for each agent', () => {
  said.length = 0;
  const notice = new AgentReachNotice();
  assert.equal(
    notice.unreachable({ client: 'cursor-vscode', matched: true, reason: 'ok' }),
    false,
    'a found window says nothing',
  );
  assert.equal(
    notice.unreachable({ client: 'cursor-vscode', matched: false, reason: 'other_folder', folder: 'C:\\work\\api' }),
    true,
  );
  assert.equal(notice.unreachable({ client: 'cursor-vscode', matched: false, reason: 'other_folder' }), false);
  assert.equal(notice.unreachable({ client: 'claude-code', matched: false, reason: 'other_folder' }), true);
  assert.equal(said.length, 2);
  assert.match(said[0], /^cursor-vscode started Logline's MCP server for C:\\work\\api, which is not a folder open/);
  assert.match(said[1], /^Claude Code started/);
});

test('the message says what to do for each reason', () => {
  assert.match(
    unreachableMessage({ matched: false, reason: 'unexpanded' }),
    /^Your agent started Logline's MCP server without saying which project.*LOGLINE_WORKSPACE/,
  );
  assert.match(
    unreachableMessage({ client: 'Codex', matched: false, reason: 'other_folder' }),
    /^Codex started Logline's MCP server, which is not a folder open in this window.*Start the agent in this window's project/,
  );
});
