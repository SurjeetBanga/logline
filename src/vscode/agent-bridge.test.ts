import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentLabel, type BridgeWindow } from '../protocol/agent-bridge';
import { callWindow, createMcpServer, mcpTools, pickWindow, readWindows, workspaceArgument } from '../mcp/server';
import { AgentBridge, installMcpScript } from './agent-bridge';
import { withVscode } from '../test/vscode-mock';

const temp = () => mkdtempSync(join(tmpdir(), 'logline-agents-'));
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

test('the bridge publishes a private discovery file and answers only calls with its token', async () => {
  const directory = join(temp(), 'agents');
  let clientCalls = 0;
  const bridge = new AgentBridge({
    run: async (tool, input) => JSON.stringify({ tool, input }), folders: () => ['/work/api'], name: () => 'api',
    onClient: () => clientCalls++, directory, pid: process.pid
  });
  await bridge.start();
  const file = join(directory, `${process.pid}.json`);
  const window = JSON.parse(readFileSync(file, 'utf8')) as BridgeWindow;
  assert.deepEqual([window.version, window.pid, window.folders, window.name], [1, process.pid, ['/work/api'], 'api']);
  assert.match(window.token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'only the user can read the token');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  }

  assert.deepEqual(await callWindow(window, 'logline_search_logs', { shareId: 's' }, 'claude-code'),
    { text: JSON.stringify({ tool: 'logline_search_logs', input: { shareId: 's' } }) });
  assert.match(JSON.stringify(await callWindow({ ...window, token: 'f'.repeat(64) }, 'logline_search_logs', {}, undefined)), /did not accept the token/);
  await callWindow(window, 'logline_list_shared_sources', {}, 'claude-code');
  await callWindow(window, 'logline_list_shared_sources', {}, 'codex-mcp-client');
  assert.deepEqual(bridge.recentClients(), ['Claude Code', 'Codex']);
  assert.equal(clientCalls, 2, 'the panel hears about each agent once, not on every call');
  assert.deepEqual(bridge.recentClients(Date.now() + 11 * 60 * 1000), [], 'agents that stopped calling drop off');

  await bridge.stop();
  assert.deepEqual(readdirSync(directory), [], 'a closed window removes its file');
  assert.match(JSON.stringify(await callWindow(window, 'logline_list_shared_sources', {}, undefined)), /stopped responding|closed the connection/);
});

test('an agent that gives up cancels the call in the window', async () => {
  let release!: () => void;
  const finished = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const bridge = new AgentBridge({
    run: (_tool, _input, token) => new Promise(resolve => {
      const poll = setInterval(() => { if (token.isCancellationRequested) { clearInterval(poll); release(); resolve('{}'); } }, 5);
    }),
    folders: () => [], name: () => 'w', directory: join(temp(), 'agents'), pid: process.pid
  });
  await bridge.start();
  const window = JSON.parse(readFileSync(join(bridge['directory'], `${process.pid}.json`), 'utf8')) as BridgeWindow;
  const abort = new AbortController();
  const call = callWindow(window, 'logline_wait_for_logs', {}, undefined, abort.signal);
  setTimeout(() => abort.abort(), 20);
  assert.deepEqual(await call, { error: 'Cancelled.' });
  assert.equal(await finished, true, 'the wait stops instead of running to its timeout');
  await bridge.stop();
});

test('windows that closed without cleaning up are ignored and removed', async () => {
  const directory = join(temp(), 'agents');
  const bridge = new AgentBridge({ run: async () => '{}', folders: () => [], name: () => 'w', directory, pid: process.pid });
  await bridge.start();
  const dead = { version: 1, pid: exitedPid(), port: 1, token: 'x', folders: ['/old'], name: 'old' };
  writeFileSync(join(directory, `${dead.pid}.json`), JSON.stringify(dead));
  writeFileSync(join(directory, 'broken.json'), '{');
  assert.deepEqual(readWindows(directory).map(window => window.pid), [process.pid]);
  await bridge.stop();
  await bridge.start();
  assert.deepEqual(readdirSync(directory), [`${process.pid}.json`]);
  await bridge.stop();
});

test('the MCP server script is kept at a stable path and only rewritten when it changes', () => {
  const directory = temp();
  const source = join(directory, 'bundle.js');
  const target = join(directory, 'home', '.logline', 'mcp.js');
  writeFileSync(source, 'one');
  installMcpScript(source, target);
  assert.equal(readFileSync(target, 'utf8'), 'one');
  const written = statSync(target).mtimeMs;
  installMcpScript(source, target);
  assert.equal(statSync(target).mtimeMs, written);
  writeFileSync(source, 'two');
  installMcpScript(source, target);
  assert.equal(readFileSync(target, 'utf8'), 'two');
});

const window = (pid: number, folders: string[], name = 'w'): BridgeWindow => ({ version: 1, pid, port: 1, token: 't', folders, name });

test('an agent reaches the window whose workspace contains its working directory', () => {
  const api = window(1, ['/work/api'], 'api'), web = window(2, ['/work/web', '/work/shared'], 'web'), nested = window(3, ['/work/api/packages/billing'], 'billing');
  assert.equal(pickWindow([api, web, nested], '/work/api/src').window, api);
  assert.equal(pickWindow([api, web, nested], '/work/api/packages/billing/src').window, nested, 'the closest enclosing folder wins');
  assert.equal(pickWindow([api, web], '/work/shared').window, web);
  assert.equal(pickWindow([api, web], '/work/apix').window, undefined, 'a sibling with a common prefix is not inside');
  assert.match(pickWindow([api, web], '/elsewhere').error!, /2 VS Code windows \(api, web\).*LOGLINE_WORKSPACE/);
  assert.match(pickWindow([api], '/elsewhere').error!, /a VS Code window \(api\), but none contains .*elsewhere/, 'an agent in another project cannot read this one');
  const empty = { ...api, folders: [], name: 'Untitled' };
  assert.equal(pickWindow([empty], '/elsewhere').window, empty, 'a single window without folders is the one');
  assert.equal(pickWindow([api, web], '/elsewhere', '/work/web').window, web, 'LOGLINE_WORKSPACE chooses explicitly');
  assert.match(pickWindow([], '/work/api').error!, /No VS Code window with Logline is running/);
});

test('the workspace comes from --workspace, unless the editor left its variable unexpanded', () => {
  assert.equal(workspaceArgument(['node', 'mcp.js', '--workspace', '/work/api'], { LOGLINE_WORKSPACE: '/work/web' }), '/work/api');
  assert.equal(workspaceArgument(['node', 'mcp.js', '--workspace', '${workspaceFolder}'], { LOGLINE_WORKSPACE: '/work/web' }), '/work/web');
  assert.equal(workspaceArgument(['node', 'mcp.js', '--workspace', '${workspaceFolder}'], {}), undefined, 'an unexpanded variable names no folder');
  assert.equal(workspaceArgument(['node', 'mcp.js', '--workspace'], {}), undefined);
  assert.equal(workspaceArgument(['node', 'mcp.js'], { LOGLINE_WORKSPACE: '' }), undefined);
});

test('the MCP server speaks the protocol and forwards tool calls', async () => {
  const tools = mcpTools([
    { name: 'logline_list_shared_sources', displayName: 'List shared Logline runs', modelDescription: 'Read-only. Sharing is available to agent chats in this VS Code window; no chat selection or user-provided shareId is needed. Use the shareId.', inputSchema: { type: 'object' } },
    { name: 'logline_search_logs', modelDescription: 'Search.' }
  ]);
  assert.match(tools[0].description, /If nothing is shared, ask the user to choose Share with agent/);
  assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: {} });
  assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });

  let windows: BridgeWindow[] = [];
  const calls: unknown[][] = [];
  let reply: { text: string } | { error: string } = { text: '{"sources":[]}' };
  const server = createMcpServer({ tools, version: '9.9.9', cwd: '/work/api', windows: () => windows, call: async (...args) => { calls.push(args.slice(0, 4)); return reply; } });

  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-code' } } }) as any;
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.serverInfo, { name: 'logline', title: 'Logline', version: '9.9.9' });
  assert.equal(((await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as any).result.protocolVersion, '2025-06-18');
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(((await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as any).result.tools.length, 2);
  assert.equal(((await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } })) as any).error.code, -32602);
  assert.equal(((await server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })) as any).error.code, -32601);

  const notConnected = (await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'logline_search_logs', arguments: {} } })) as any;
  assert.equal(notConnected.result.isError, true);
  assert.match(notConnected.result.content[0].text, /NOT_CONNECTED.*No VS Code window/);

  windows = [window(1, ['/work/api'])];
  const ok = (await server.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'logline_list_shared_sources', arguments: { shareId: 'a' } } })) as any;
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: '{"sources":[]}' }], isError: false });
  assert.deepEqual(calls.at(-1), [windows[0], 'logline_list_shared_sources', { shareId: 'a' }, 'claude-code']);
  reply = { text: '{"error":"NOT_SHARED","message":"No Logline logs are shared."}' };
  assert.equal(((await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'logline_search_logs' } })) as any).result.isError, true, 'a tool error is reported as one');
  reply = { error: 'The Logline window stopped responding.' };
  assert.match(((await server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'logline_search_logs' } })) as any).result.content[0].text, /stopped responding/);
  assert.equal(((await server.handle([1, 2])) as any).error.code, -32600);
});

test('a cancelled MCP request aborts its call to the window', async () => {
  let signal: AbortSignal | undefined;
  const server = createMcpServer({
    tools: mcpTools([{ name: 'logline_wait_for_logs' }]), version: '1', cwd: '/w', windows: () => [window(1, ['/w'])],
    call: (_window, _tool, _input, _client, abort) => new Promise(resolve => { signal = abort; abort?.addEventListener('abort', () => resolve({ error: 'Cancelled.' })); })
  });
  const pending = server.handle({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'logline_wait_for_logs' } });
  await new Promise(resolve => setImmediate(resolve));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w1' } });
  assert.equal(signal?.aborted, true);
  assert.equal(((await pending) as any).result.isError, true);
});

test('agents are named for people, and setup commands quote paths for the shell', () => {
  assert.deepEqual(['claude-code', 'codex-mcp-client', 'cursor<script>', '!!!'].map(agentLabel), ['Claude Code', 'Codex', 'cursorscript', 'an MCP client']);
  const { agentLaunch, setupCommand, shellKind, mcpConfiguration } = withVscode({}, () => require('./agent-setup') as typeof import('./agent-setup'));
  const launch = agentLaunch('/Users/me/.logline/mcp.js', '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)');
  assert.deepEqual(launch.env, { ELECTRON_RUN_AS_NODE: '1' }, 'VS Code runs the server, so Node.js need not be installed');
  assert.equal(setupCommand('claude', launch, 'posix'),
    "claude mcp add --env ELECTRON_RUN_AS_NODE=1 --transport stdio --scope user logline -- '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)' /Users/me/.logline/mcp.js");
  assert.equal(setupCommand('codex', launch, 'posix'),
    "codex mcp add logline --env ELECTRON_RUN_AS_NODE=1 -- '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)' /Users/me/.logline/mcp.js");
  assert.equal(setupCommand('codex', agentLaunch('C:\\Users\\me\\.logline\\mcp.js', 'C:\\Program Files\\VS Code\\Code.exe'), 'powershell'),
    'codex mcp add logline --env ELECTRON_RUN_AS_NODE="1" -- "C:\\Program Files\\VS Code\\Code.exe" "C:\\Users\\me\\.logline\\mcp.js"');
  assert.equal(setupCommand('claude', agentLaunch("/tmp/it's/mcp.js", '/usr/bin/code'), 'posix').endsWith("-- /usr/bin/code '/tmp/it'\\''s/mcp.js'"), true);
  assert.deepEqual(JSON.parse(mcpConfiguration(launch)).mcpServers.logline.args, ['/Users/me/.logline/mcp.js']);

  // The Claude Code and Codex extensions bring their own CLI, which is often not on PATH.
  const { agentCli } = withVscode({}, () => require('./agent-setup') as typeof import('./agent-setup'));
  const files = new Set([join('/ext/claude', 'resources', 'native-binary', 'claude'), join('/ext/codex', 'bin', 'macos-aarch64', 'codex')]);
  const exists = (file: string) => files.has(file);
  const list = (directory: string) => directory === join('/ext/codex', 'bin') ? ['linux-x86_64', 'macos-aarch64'] : [];
  assert.equal(agentCli('claude', '/ext/claude', 'darwin', exists, list), join('/ext/claude', 'resources', 'native-binary', 'claude'));
  assert.equal(agentCli('codex', '/ext/codex', 'darwin', exists, list), join('/ext/codex', 'bin', 'macos-aarch64', 'codex'));
  assert.equal(agentCli('claude', undefined, 'darwin', exists, list), 'claude', 'without the extension, the CLI on PATH');
  assert.equal(agentCli('claude', '/ext/other', 'darwin', exists, list), 'claude');
  assert.equal(setupCommand('claude', launch, 'posix', '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.288/resources/native-binary/claude').split(' mcp add ')[0],
    '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.288/resources/native-binary/claude');
  const codex = 'C:\\Users\\me\\.vscode\\extensions\\openai.chatgpt\\bin\\example-platform\\codex.exe';
  const windows = agentLaunch('C:\\Users\\me\\.logline\\mcp.js', 'C:\\Program Files\\VS Code\\Code.exe');
  assert.match(setupCommand('codex', windows, 'powershell', codex), /^& "C:.*codex\.exe" mcp add logline /);
  assert.match(setupCommand('codex', windows, 'cmd', codex), /^"C:.*codex\.exe" mcp add logline /, 'Command Prompt has no & operator');
  assert.equal(setupCommand('codex', windows, 'posix', codex),
    "'C:\\Users\\me\\.vscode\\extensions\\openai.chatgpt\\bin\\example-platform\\codex.exe' mcp add logline --env ELECTRON_RUN_AS_NODE=1 -- 'C:\\Program Files\\VS Code\\Code.exe' 'C:\\Users\\me\\.logline\\mcp.js'",
    'Git Bash on Windows takes POSIX quoting and no &');

  // On Windows the default terminal may be PowerShell, Command Prompt, or Git Bash.
  assert.equal(shellKind('/bin/zsh', 'darwin'), 'posix');
  assert.equal(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix');
  assert.equal(shellKind('C:\\WINDOWS\\System32\\cmd.exe', 'win32'), 'cmd');
  assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'powershell');
  assert.equal(shellKind('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), 'powershell');
  assert.equal(shellKind(undefined, 'win32'), 'powershell');
});

test('the bridge drops oversized requests', async () => {
  const bridge = new AgentBridge({ run: async () => '{}', folders: () => [], name: () => 'w', directory: join(temp(), 'agents'), pid: process.pid });
  await bridge.start();
  const window = JSON.parse(readFileSync(join(bridge['directory'], `${process.pid}.json`), 'utf8')) as BridgeWindow;
  const response = await callWindow(window, 'logline_search_logs', { query: 'x'.repeat(2 * 1024 * 1024) }, undefined);
  assert.ok('error' in response, 'nothing is run for a request over 1 MiB');
  await bridge.stop();
});

test('stopping sharing cuts agents off at once, including a wait in progress', async () => {
  const { LogStore } = require('../core/log-store') as typeof import('../core/log-store');
  const { parseLogLine } = require('../core/log-event') as typeof import('../core/log-event');
  const { SessionRegistry } = require('../capture/session-registry') as typeof import('../capture/session-registry');
  const { AgentLogAccess } = require('./agent-access') as typeof import('./agent-access');
  const { runAgentTool } = withVscode({}, () => require('./agent-tools') as typeof import('./agent-tools'));
  const store = new LogStore();
  for (let id = 1; id <= 3; id++) {
    const event = parseLogLine(JSON.stringify({ level: id === 2 ? 'error' : 'info', message: `step ${id}`, traceId: 'abc' }), 'stdout', id, new Date());
    event.serverId = 'api';
    store.add(event);
  }
  const access = new AgentLogAccess(store, new SessionRegistry(), () => store.size);
  const bridge = new AgentBridge({
    run: (tool, input, token) => runAgentTool(access, tool, input, token), folders: () => ['/w'], name: () => 'w',
    grant: () => access.grant, directory: join(temp(), 'agents'), pid: process.pid
  });
  await bridge.start();
  const window = JSON.parse(readFileSync(join(bridge['directory'], `${process.pid}.json`), 'utf8')) as BridgeWindow;
  const server = createMcpServer({ tools: mcpTools(['logline_list_shared_sources', 'logline_search_logs', 'logline_inspect_event', 'logline_analyze_logs', 'logline_get_trace', 'logline_wait_for_logs'].map(name => ({ name }))),
    version: '1', cwd: '/w', windows: () => [window] });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) as any;
    return { isError: reply.result.isError as boolean, body: JSON.parse(reply.result.content[0].text) };
  };
  await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } });

  assert.equal((await call('logline_list_shared_sources')).body.error, 'NOT_SHARED', 'nothing is readable before sharing');
  access.shareAll();
  const shareId = (await call('logline_list_shared_sources')).body.shareId as string;
  assert.equal((await call('logline_search_logs', { shareId })).body.events.length, 3);
  assert.deepEqual(bridge.recentClients(), ['Claude Code']);

  // A wait in progress ends as soon as sharing stops, not at its timeout.
  const started = Date.now();
  const waiting = call('logline_wait_for_logs', { shareId, watermark: 3, timeoutMs: 8000 });
  setTimeout(() => access.revoke(), 50);
  const waited = await waiting;
  assert.equal(waited.isError, true);
  assert.equal(waited.body.error, 'NOT_SHARED');
  assert.ok(Date.now() - started < 1000, `the wait stopped within a second, took ${Date.now() - started} ms`);

  for (const [name, args] of [
    ['logline_list_shared_sources', {}], ['logline_search_logs', { shareId }], ['logline_inspect_event', { shareId, id: 2 }],
    ['logline_analyze_logs', { shareId }], ['logline_get_trace', { shareId, traceId: 'abc' }], ['logline_wait_for_logs', { shareId, watermark: 0, timeoutMs: 0 }]
  ] as const) {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} is refused after sharing stops`);
    assert.equal(result.body.error, 'NOT_SHARED', name);
    assert.doesNotMatch(JSON.stringify(result.body), /step \d/, `${name} returns no log content`);
  }
  assert.deepEqual(bridge.recentClients(), [], 'the status line no longer names the agent');

  // Sharing again issues a new grant; the old one stays dead.
  access.shareAll();
  assert.equal((await call('logline_search_logs', { shareId })).body.error, 'SHARE_CHANGED');
  assert.deepEqual(bridge.recentClients(), [], 'calls under the old grant do not count as reading the new one');
  const renewed = (await call('logline_list_shared_sources')).body.shareId as string;
  assert.notEqual(renewed, shareId);
  assert.equal((await call('logline_search_logs', { shareId: renewed })).body.events.length, 3);
  await bridge.stop();
});

test('overlapping starts share one listener and a stop during start leaves nothing running', async () => {
  const directory = join(temp(), 'agents');
  const bridge = new AgentBridge({ run: async () => '{}', folders: () => [], name: () => 'w', directory, pid: process.pid });
  await Promise.all([bridge.start(), bridge.start(), bridge.start()]);
  const server = bridge['server'];
  await bridge.start();
  assert.equal(bridge['server'], server, 'a running bridge is not started again');
  await bridge.stop();
  const starting = bridge.start();
  await bridge.stop();
  await starting;
  assert.equal(bridge.running, false);
  assert.deepEqual(readdirSync(directory), []);
});
