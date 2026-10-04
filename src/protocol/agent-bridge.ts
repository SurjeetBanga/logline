import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How MCP clients such as Claude Code and Codex reach the logs a VS Code
 * window shares. Each window running Logline listens on 127.0.0.1 and writes
 * a discovery file, readable only by the user, with its port, a random token,
 * and its workspace folders. The `logline` MCP server that the agent starts
 * picks the window whose folders contain the agent's working directory and
 * forwards each tool call to it, one connection per call.
 */
export const BRIDGE_VERSION = 1;

/** One window's discovery file. */
export interface BridgeWindow {
  version: number;
  pid: number;
  port: number;
  token: string;
  folders: string[];
  name: string;
}

/** One line from the MCP server: a tool call. */
export interface BridgeRequest { token: string; tool: string; input: unknown; client?: string; }

/** One line back: the tool's bounded JSON text, or why the call was refused. */
export type BridgeResponse = { text: string } | { error: string };

/** Largest request accepted on the bridge; tool inputs are small. */
export const MAX_BRIDGE_REQUEST_BYTES = 1024 * 1024;

export function loglineHome(home = homedir()): string { return join(home, '.logline'); }
export function agentsDirectory(home = homedir()): string { return join(loglineHome(home), 'agents'); }
/** The MCP server script agents run, kept at a path that survives extension updates. */
export function mcpScriptPath(home = homedir()): string { return join(loglineHome(home), 'mcp.js'); }

/** A friendly name for an MCP client from the name it reports when it connects. */
export function agentLabel(client: string): string {
  if (/claude/i.test(client)) return 'Claude Code';
  if (/codex/i.test(client)) return 'Codex';
  const cleaned = client.replace(/[^\w .@/-]/g, '').trim().slice(0, 40);
  return cleaned || 'an MCP client';
}

/** Whether a process is still running, so files of closed windows are ignored. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
