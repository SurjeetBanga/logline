import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

/** How an MCP client starts the Logline server: VS Code's own runtime, so Node.js need not be installed. */
export interface AgentLaunch { command: string; args: string[]; env: Record<string, string>; }

export function agentLaunch(script: string, runtime = process.execPath): AgentLaunch {
  return { command: runtime, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

type Agent = 'claude' | 'codex';
const AGENT_NAMES: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };

const EXTENSIONS: Record<Agent, string> = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

/**
 * The agent's CLI. The Claude Code and Codex extensions ship their own copy
 * without putting it on PATH, so prefer that one; otherwise rely on PATH.
 */
export function agentCli(agent: Agent, extensionPath: string | undefined, platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync, list: (directory: string) => string[] = safeList): string {
  const binary = platform === 'win32' ? `${agent}.exe` : agent;
  if (!extensionPath) return agent;
  if (agent === 'claude') {
    const bundled = join(extensionPath, 'resources', 'native-binary', binary);
    return exists(bundled) ? bundled : agent;
  }
  // The Codex extension keeps one binary per platform under bin/<platform>/.
  for (const platformDirectory of list(join(extensionPath, 'bin'))) {
    const bundled = join(extensionPath, 'bin', platformDirectory, binary);
    if (exists(bundled)) return bundled;
  }
  return agent;
}

function safeList(directory: string): string[] { try { return readdirSync(directory); } catch { return []; } }

/** The shell family a command is written for. */
export type Shell = 'posix' | 'powershell' | 'cmd';

/**
 * The family of the terminal's shell. On Windows the default may be
 * PowerShell, Command Prompt, or Git Bash, and each quotes differently.
 */
export function shellKind(shellPath: string | undefined, platform: NodeJS.Platform = process.platform): Shell {
  if (platform !== 'win32') return 'posix';
  const name = (shellPath ?? '').split(/[\\/]/).pop()!.toLowerCase();
  if (/^cmd(\.exe)?$/.test(name)) return 'cmd';
  if (/^(bash|sh|zsh|fish)(\.exe)?$/.test(name)) return 'posix';
  return 'powershell';
}

/** The command that registers Logline with an agent's CLI, for every project. */
export function setupCommand(agent: Agent, launch: AgentLaunch, shell: Shell = shellKind(vscode.env?.shell), cli: string = agent): string {
  const quote = shell === 'posix'
    ? (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
    : (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  const env = Object.entries(launch.env).map(([key, value]) => `--env ${key}=${quote(value)}`).join(' ');
  const server = [launch.command, ...launch.args].map(quote).join(' ');
  // Claude Code needs an option between --env and the server name.
  // PowerShell needs & to run a quoted program path.
  const program = cli === agent ? agent : `${shell === 'powershell' ? '& ' : ''}${quote(cli)}`;
  return agent === 'claude'
    ? `${program} mcp add ${env} --transport stdio --scope user logline -- ${server}`
    : `${program} mcp add logline ${env} -- ${server}`;
}

/** A stdio server entry in the `mcpServers` format most MCP clients read. */
export function mcpConfiguration(launch: AgentLaunch): string {
  return JSON.stringify({ mcpServers: { logline: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2);
}

/**
 * Register Logline with Claude Code, Codex, or another MCP client. Agents
 * then read only what is shared with Share with agent, like Copilot.
 */
export async function connectAgent(launch: AgentLaunch): Promise<void> {
  const picked = await vscode.window.showQuickPick([
    { label: 'Claude Code', description: 'claude mcp add', detail: 'For all your projects, in the terminal and the Claude Code extension.', agent: 'claude' as const },
    { label: 'Codex', description: 'codex mcp add', detail: 'For all your projects. The Codex CLI, IDE extension, and app share this setting.', agent: 'codex' as const },
    { label: 'Other MCP client', description: 'Copy configuration', detail: 'Copy a stdio server entry (command, args, env) to add to your client.', agent: undefined }
  ], { title: 'Connect an agent to Logline', placeHolder: 'Which agent should read the logs you share?' });
  if (!picked) return;
  const after = 'Restart the agent so it loads Logline, then choose Share with agent in the Logs panel. Agents read only what you share, always redacted.';
  if (!picked.agent) {
    await vscode.env.clipboard.writeText(mcpConfiguration(launch));
    void vscode.window.showInformationMessage(`Copied the Logline MCP server configuration. Add it to your client's MCP settings. ${after}`);
    return;
  }
  const name = AGENT_NAMES[picked.agent];
  const command = setupCommand(picked.agent, launch, shellKind(vscode.env.shell), agentCli(picked.agent, vscode.extensions?.getExtension(EXTENSIONS[picked.agent])?.extensionPath));
  const choice = await vscode.window.showInformationMessage(`Add Logline to ${name}?`, {
    modal: true,
    detail: `This runs:\n\n${command}\n\nIt registers the Logline MCP server for your user. ${name} must be installed, as a CLI or as its VS Code extension.`
  }, 'Run in Terminal', 'Copy Command');
  if (choice === 'Copy Command') {
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(`Copied. Run it in a terminal to add Logline to ${name}. ${after}`);
  } else if (choice === 'Run in Terminal') {
    const terminal = vscode.window.createTerminal({ name: `Logline · ${name}` });
    terminal.show();
    terminal.sendText(command);
    void vscode.window.showInformationMessage(`${after}`);
  }
}
