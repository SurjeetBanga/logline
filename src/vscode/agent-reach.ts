import * as vscode from 'vscode';
import { agentLabel, type BridgeHello } from '../protocol/agent-bridge';

/** What to tell someone whose agent started Logline's server but could not reach this window's logs. */
export function unreachableMessage(hello: BridgeHello): string {
  const label = agentLabel(hello.client ?? '');
  const who = label === 'an MCP client' ? 'Your agent' : label;
  if (hello.reason === 'unexpanded')
    return `${who} started Logline's MCP server without saying which project it is in, so it cannot read the logs shared here. Close the other windows running Logline, or set LOGLINE_WORKSPACE to the project folder in the agent's MCP settings.`;
  const where = hello.folder ? ` for ${hello.folder}` : '';
  return `${who} started Logline's MCP server${where}, which is not a folder open in this window, so it cannot read the logs shared here. Start the agent in this window's project, or open that folder in the editor.`;
}

/**
 * Tells the user, once a window for each agent, that an agent could not reach
 * the logs this window shares. The agent sees an error too, but people read
 * the editor, and an agent's error is easy to miss or to explain away.
 */
export class AgentReachNotice {
  private readonly told = new Set<string>();

  /** Returns whether it was said. */
  unreachable(hello: BridgeHello): boolean {
    if (hello.matched) return false;
    const label = agentLabel(hello.client ?? '');
    if (this.told.has(label)) return false;
    this.told.add(label);
    void vscode.window.showWarningMessage(unreachableMessage(hello));
    return true;
  }
}
