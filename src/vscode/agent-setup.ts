import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { AGENT_WORKFLOWS, skillFile, skillName } from '../protocol/agent-workflows';

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

/** Where an agent reads the skills that apply to all of a user's projects. */
export function skillsDirectory(agent: Agent, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return agent === 'claude' ? join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills') : join(home, '.agents', 'skills');
}

/** Write the Logline skills into an agent's skills folder, leaving unchanged files alone. Returns the skill names. */
export function installSkills(directory: string): string[] {
  for (const workflow of AGENT_WORKFLOWS) {
    const folder = join(directory, skillName(workflow));
    const file = join(folder, 'SKILL.md');
    const text = skillFile(workflow);
    try { if (readFileSync(file, 'utf8') === text) continue; } catch { /* not installed yet */ }
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, text);
  }
  return AGENT_WORKFLOWS.map(skillName);
}

/**
 * Bring skills installed by an earlier version up to date. Agents that were
 * never connected get none: only folders that already have a Logline skill are updated.
 */
export function refreshInstalledSkills(directories: string[] = (['claude', 'codex'] as const).map(agent => skillsDirectory(agent))): void {
  for (const directory of directories) {
    if (!safeList(directory).some(name => name.startsWith('logline-'))) continue;
    try { installSkills(directory); } catch { /* read-only or removed; Connect reports errors */ }
  }
}

/** The agents whose skills folder has the Logline skills. */
export function agentsWithSkills(directory: (agent: Agent) => string = agent => skillsDirectory(agent)): string[] {
  return (['claude', 'codex'] as const).filter(agent => safeList(directory(agent)).some(name => name.startsWith('logline-'))).map(agent => AGENT_NAMES[agent]);
}

/**
 * Whether GitHub Copilot Chat is installed; Ask Copilot and Fix with Copilot
 * need it. Editors such as Cursor, Windsurf, and Kiro ship their own agent
 * instead. A host that cannot list extensions is given the benefit of the doubt.
 */
export function copilotAvailable(): boolean {
  const getExtension = vscode.extensions?.getExtension;
  return typeof getExtension !== 'function' || Boolean(getExtension('GitHub.copilot-chat'));
}

/** How a user starts an installed skill in each agent. */
function skillCommand(agent: Agent, name: string): string { return agent === 'claude' ? `/${name}` : `$${name}`; }

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

/** An editor built on VS Code whose own agent reads MCP servers from a file in the user's home folder. */
export interface HostAgent { name: string; file: string; }

/** The agent built into the editor Logline runs in, from the editor's name. */
export function hostAgent(appName: string = vscode.env?.appName ?? '', home = homedir()): HostAgent | undefined {
  if (/cursor/i.test(appName)) return { name: 'Cursor', file: join(home, '.cursor', 'mcp.json') };
  // Windsurf became Devin Desktop and kept its data folder.
  if (/windsurf|devin/i.test(appName)) return { name: /devin/i.test(appName) ? 'Devin Desktop' : 'Windsurf', file: join(home, '.codeium', 'windsurf', 'mcp_config.json') };
  if (/kiro/i.test(appName)) return { name: 'Kiro', file: join(home, '.kiro', 'settings', 'mcp.json') };
  return undefined;
}

/**
 * An MCP configuration file with the Logline server added or updated, and
 * everything else in it kept. Throws when the file is not a JSON object, so
 * a file the user wrote by hand is never replaced.
 */
export function withLoglineServer(text: string | undefined, launch: AgentLaunch): string {
  const config: unknown = text?.trim() ? JSON.parse(text) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('it is not a JSON object');
  const servers = (config as { mcpServers?: unknown }).mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('its mcpServers is not an object');
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, logline: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2)}\n`;
}

/** Add Logline to the editor's own agent by editing its MCP configuration file. */
async function connectHost(host: HostAgent, launch: AgentLaunch, after: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(`Add Logline to ${host.name}'s agent?`, {
    modal: true, detail: `This adds a logline server to ${host.file}, keeping the servers already there.`
  }, 'Add Server');
  if (choice !== 'Add Server') return;
  let existing: string | undefined;
  try { existing = readFileSync(host.file, 'utf8'); } catch { /* not created yet */ }
  try {
    // The editor starts its MCP servers for every project, so name the open folder for the server to pick this window's logs.
    const text = withLoglineServer(existing, { ...launch, args: [...launch.args, '--workspace', '${workspaceFolder}'] });
    mkdirSync(dirname(host.file), { recursive: true });
    writeFileSync(host.file, text);
  } catch (error) {
    await vscode.env.clipboard.writeText(mcpConfiguration(launch));
    void vscode.window.showWarningMessage(`Logline did not change ${host.file} because ${(error as Error).message}. The server entry was copied; add it under mcpServers yourself.`);
    return;
  }
  void vscode.window.showInformationMessage(`Added Logline to ${host.file}. ${after}`);
}

/**
 * Register Logline with Claude Code, Codex, the editor's own agent, or
 * another MCP client. Agents then read only what is shared with Share with
 * agent, like Copilot.
 */
export async function connectAgent(launch: AgentLaunch, host: HostAgent | undefined = hostAgent()): Promise<void> {
  const picked = await vscode.window.showQuickPick([
    ...(host ? [{ label: `${host.name} agent`, description: 'Edit MCP settings', detail: `Add Logline to ${host.file}, for all your projects.`, agent: 'host' as const }] : []),
    { label: 'Claude Code', description: 'claude mcp add', detail: 'For all your projects, in the terminal and the Claude Code extension.', agent: 'claude' as const },
    { label: 'Codex', description: 'codex mcp add', detail: 'For all your projects. The Codex CLI, IDE extension, and app share this setting.', agent: 'codex' as const },
    { label: 'Other MCP client', description: 'Copy configuration', detail: 'Copy a stdio server entry (command, args, env) to add to your client.', agent: undefined }
  ], { title: 'Connect an agent to Logline', placeHolder: 'Which agent should read the logs you share?' });
  if (!picked) return;
  const after = 'Restart the agent so it loads Logline, then choose Share with agent in the Logs panel. Agents read only what you share, always redacted.';
  if (picked.agent === 'host') { await connectHost(host!, launch, after); return; }
  if (!picked.agent) {
    await vscode.env.clipboard.writeText(mcpConfiguration(launch));
    void vscode.window.showInformationMessage(`Copied the Logline MCP server configuration. Add it to your client's MCP settings. ${after} Clients that support MCP prompts also list Logline's verify, triage, and slow-request workflows.`);
    return;
  }
  const name = AGENT_NAMES[picked.agent];
  const command = setupCommand(picked.agent, launch, shellKind(vscode.env.shell), agentCli(picked.agent, vscode.extensions?.getExtension(EXTENSIONS[picked.agent])?.extensionPath));
  const skills = skillsDirectory(picked.agent);
  const choice = await vscode.window.showInformationMessage(`Add Logline to ${name}?`, {
    modal: true,
    detail: `This runs:\n\n${command}\n\nIt registers the Logline MCP server for your user. ${name} must be installed, as a CLI or as its VS Code extension.\n\n`
      + `It also adds the skills ${AGENT_WORKFLOWS.map(skillName).join(', ')} to ${skills}, so ${name} can verify a change, triage errors, and explain slow requests from your logs.`
  }, 'Run in Terminal', 'Copy Command');
  if (!choice) return;
  let installed: string[] = [];
  try { installed = installSkills(skills); }
  catch (error) { void vscode.window.showWarningMessage(`Logline could not add its skills to ${skills}: ${(error as Error).message}`); }
  const example = installed.length ? ` Try ${skillCommand(picked.agent, installed[0])} after a change.` : '';
  if (choice === 'Copy Command') {
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(`Copied. Run it in a terminal to add Logline to ${name}. ${after}${example}`);
  } else {
    const terminal = vscode.window.createTerminal({ name: `Logline · ${name}` });
    terminal.show();
    terminal.sendText(command);
    void vscode.window.showInformationMessage(`${after}${example}`);
  }
}
