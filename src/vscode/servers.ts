import * as vscode from 'vscode';
import { nextServerId } from '../core/server-config';
import type { ServerConfig } from '../core/types';

export async function manageServers(): Promise<void> {
  const config = vscode.workspace.getConfiguration('logline');
  const servers = [...config.get<ServerConfig[]>('servers', [])];
  const choice = await vscode.window.showQuickPick(['Add server', ...servers.map(server => `Edit: ${server.label}`), 'Delete server'], { title: 'Manage Logline servers' });
  if (!choice) return;
  if (choice === 'Add server') {
    const label = await vscode.window.showInputBox({ prompt: 'Server name' });
    const command = label && await vscode.window.showInputBox({ prompt: 'Command', placeHolder: 'mvn spring-boot:run' });
    if (!label || !command) return;
    servers.push({ id: nextServerId(servers, label), label, command });
  } else if (choice.startsWith('Edit: ')) {
    const index = servers.findIndex(server => `Edit: ${server.label}` === choice);
    const server = servers[index];
    const label = await vscode.window.showInputBox({ prompt: 'Server name', value: server.label });
    const command = label && await vscode.window.showInputBox({ prompt: 'Command', value: server.command });
    if (!label || !command) return;
    servers[index] = { ...server, label, command };
  } else {
    const selected = await vscode.window.showQuickPick(servers.map(server => server.label), { title: 'Delete server' });
    if (!selected) return;
    await config.update('servers', servers.filter(server => server.label !== selected), vscode.ConfigurationTarget.Workspace);
    return;
  }
  await config.update('servers', servers, vscode.ConfigurationTarget.Workspace);
}
