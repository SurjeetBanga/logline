import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMcpServer, mcpTools } from '../mcp/server';
import { AGENT_WORKFLOWS, skillFile, skillName } from './agent-workflows';
import { withVscode } from '../test/vscode-mock';

const temp = () => mkdtempSync(join(tmpdir(), 'logline-skills-'));
const setup = () => withVscode({}, () => require('../vscode/agent-setup') as typeof import('../vscode/agent-setup'));

test('workflows only name tools Logline declares, and their skill files have the required front matter', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { languageModelTools: { name: string }[] } };
  const declared = new Set(manifest.contributes.languageModelTools.map(tool => tool.name));
  for (const workflow of AGENT_WORKFLOWS) {
    for (const [tool] of workflow.body.matchAll(/logline_\w+/g)) assert.ok(declared.has(tool), `${workflow.name} names ${tool}`);
    const file = skillFile(workflow);
    const front = file.match(/^---\nname: (.+)\ndescription: (.+)\n---\n\n# /);
    assert.ok(front, `${workflow.name} starts with front matter and a heading`);
    assert.equal(front[1], skillName(workflow));
    assert.match(front[1], /^[a-z0-9-]{1,64}$/, 'skill names are lowercase words joined by hyphens');
    assert.equal(JSON.parse(front[2]), workflow.description, 'the description is quoted so colons stay valid YAML');
    assert.ok(workflow.description.length <= 1024);
  }
});

test('the MCP server offers the workflows as prompts', async () => {
  const server = createMcpServer({ tools: mcpTools([{ name: 'logline_search_logs' }]), prompts: AGENT_WORKFLOWS, version: '1', cwd: '/w', windows: () => [] });
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as any;
  assert.deepEqual(init.result.capabilities.prompts, { listChanged: false });
  const list = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'prompts/list' }) as any).result.prompts;
  assert.deepEqual(list.map((prompt: { name: string }) => prompt.name), ['verify', 'triage', 'slow-request']);
  assert.ok(list.every((prompt: { title?: string; description?: string }) => prompt.title && prompt.description));
  const triage = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'triage' } }) as any).result;
  assert.equal(triage.messages[0].role, 'user');
  assert.match(triage.messages[0].content.text, /logline_analyze_logs/);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'nope' } }) as any).error.code, -32602);

  const bare = createMcpServer({ tools: [], version: '1', cwd: '/w', windows: () => [] });
  assert.equal((await bare.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as any).result.capabilities.prompts, undefined,
    'a server without prompts does not advertise them');
});

test('skills install into each agent\'s folder and stay current without touching agents that were never connected', () => {
  const { installSkills, refreshInstalledSkills, skillsDirectory, agentsWithSkills } = setup();
  assert.equal(skillsDirectory('claude', {}, '/home/me'), join('/home/me', '.claude', 'skills'));
  assert.equal(skillsDirectory('claude', { CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me'), join('/cfg', 'skills'));
  assert.equal(skillsDirectory('codex', {}, '/home/me'), join('/home/me', '.agents', 'skills'));

  const claude = join(temp(), 'skills');
  assert.deepEqual(installSkills(claude), ['logline-verify', 'logline-triage', 'logline-slow-request']);
  const verify = join(claude, 'logline-verify', 'SKILL.md');
  assert.equal(readFileSync(verify, 'utf8'), skillFile(AGENT_WORKFLOWS[0]));
  const written = statSync(verify).mtimeMs;
  installSkills(claude);
  assert.equal(statSync(verify).mtimeMs, written, 'an unchanged skill is not rewritten');

  writeFileSync(verify, 'old');
  const untouched = join(temp(), 'skills');
  mkdirSync(join(untouched, 'someone-else'), { recursive: true });
  refreshInstalledSkills([claude, untouched, join(temp(), 'missing')]);
  assert.equal(readFileSync(verify, 'utf8'), skillFile(AGENT_WORKFLOWS[0]), 'an older Logline skill is updated');
  assert.equal(existsSync(join(untouched, 'logline-verify')), false, 'a folder without Logline skills gets none');
  assert.deepEqual(agentsWithSkills(agent => agent === 'claude' ? claude : untouched), ['Claude Code'], 'Show Status names only agents with Logline skills');
});

test('the editor\'s own agent is found by name, and Logline joins its MCP file without losing other servers', () => {
  const { hostAgent, withLoglineServer, agentLaunch } = setup();
  assert.equal(hostAgent('Visual Studio Code', '/h'), undefined);
  assert.deepEqual(hostAgent('Cursor', '/h'), { name: 'Cursor', file: join('/h', '.cursor', 'mcp.json') });
  assert.deepEqual(hostAgent('Windsurf', '/h'), { name: 'Windsurf', file: join('/h', '.codeium', 'windsurf', 'mcp_config.json') });
  assert.deepEqual(hostAgent('Devin Desktop', '/h'), { name: 'Devin Desktop', file: join('/h', '.codeium', 'windsurf', 'mcp_config.json') });
  assert.deepEqual(hostAgent('Kiro', '/h'), { name: 'Kiro', file: join('/h', '.kiro', 'settings', 'mcp.json') });

  const launch = agentLaunch('/h/.logline/mcp.js', '/apps/Cursor Helper');
  const entry = { command: '/apps/Cursor Helper', args: ['/h/.logline/mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  assert.deepEqual(JSON.parse(withLoglineServer(undefined, launch)), { mcpServers: { logline: entry } });
  const merged = JSON.parse(withLoglineServer(JSON.stringify({ theme: 'x', mcpServers: { github: { command: 'gh' }, logline: { command: 'old' } } }), launch));
  assert.deepEqual(merged, { theme: 'x', mcpServers: { github: { command: 'gh' }, logline: entry } }, 'other servers and settings stay; an older Logline entry is replaced');
  assert.throws(() => withLoglineServer('{ // comment\n}', launch), 'a file that is not plain JSON is left to the user');
  assert.throws(() => withLoglineServer('[]', launch), /not a JSON object/);
  assert.throws(() => withLoglineServer('{"mcpServers":[]}', launch), /mcpServers is not an object/);
});
