import * as vscode from 'vscode';
import { nextServerId } from '../core/server-config';
import { normalizeServers } from '../core/settings';

export async function manageServers(): Promise<void> {
  const config = vscode.workspace.getConfiguration('logline');
  const raw = config.get<unknown>('servers', []);
  if (!Array.isArray(raw)) { void vscode.window.showErrorMessage('logline.servers must be an array. Correct it in Settings before managing servers.'); return; }
  const servers = [...raw];
  const entries = servers.flatMap((value, index) => normalizeServers([value]).map(server => ({ server, index })));
  const choice = await vscode.window.showQuickPick([
    { label: 'Add server', action: 'add', index: -1 },
    ...entries.map(({ server, index }) => ({ label: `Edit: ${server.label}`, description: server.id, action: 'edit', index })),
    { label: 'Delete server', action: 'delete', index: -1 }
  ], { title: 'Manage Logline servers' });
  if (!choice) return;
  if (choice.action === 'add') {
    const label = await vscode.window.showInputBox({ prompt: 'Server name' });
    const command = label && await vscode.window.showInputBox({ prompt: 'Command', placeHolder: 'mvn spring-boot:run' });
    if (!label || !command) return;
    servers.push({ id: nextServerId(entries.map(entry => entry.server), label), label, command });
  } else if (choice.action === 'edit') {
    const index = choice.index;
    const server = servers[index];
    const label = await vscode.window.showInputBox({ prompt: 'Server name', value: server.label });
    const command = label && await vscode.window.showInputBox({ prompt: 'Command', value: server.command });
    if (!label || !command) return;
    servers[index] = { ...server, label, command };
  } else {
    const selected = await vscode.window.showQuickPick(entries.map(({ server, index }) => ({ label: server.label, description: server.id, index })), { title: 'Delete server' });
    if (!selected) return;
    await config.update('servers', servers.filter((_, index) => index !== selected.index), vscode.ConfigurationTarget.Workspace);
    return;
  }
  await config.update('servers', servers, vscode.ConfigurationTarget.Workspace);
}
