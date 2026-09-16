import * as vscode from 'vscode';
import { resolveAutoStartServers, resolveCwd } from '../core/server-config';
import type { ServerConfig } from '../core/types';
import type { LogsController } from './logs-controller';
import { convertTask } from './tasks/conversion';

export function registerCommands(controller: LogsController, openGuide?: (section: 'guide' | 'whatsNew') => void): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('logline.runCommand', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before running a server command.');
        return;
      }
      const command = await vscode.window.showInputBox({
        title: 'Run server in Logs', prompt: 'Server command',
        placeHolder: 'npm run dev', ignoreFocusOut: true
      });
      if (!command?.trim()) return;
      let folder = vscode.workspace.workspaceFolders?.[0];
      if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
        folder = await vscode.window.showWorkspaceFolderPick();
        if (!folder) return;
      }
      controller.runner.run(command.trim(), folder?.uri.fsPath, { id: 'custom', label: command.trim() });
      await vscode.commands.executeCommand('logline.logs.focus');
    }),
    vscode.commands.registerCommand('logline.stopCommand', () => controller.stop()),
    vscode.commands.registerCommand('logline.export', () => controller.transfer.exportLogs()),
    vscode.commands.registerCommand('logline.import', () => controller.transfer.importLogs()),
    vscode.commands.registerCommand('logline.exportForAI', () => controller.transfer.exportForAI()),
    vscode.commands.registerCommand('logline.convertTask', () => convertTask()),
    // Keep a task-oriented alias for command palettes and keybindings.
    vscode.commands.registerCommand('logline.captureTask', () => convertTask()),
    vscode.commands.registerCommand('logline.showGuide', () => openGuide?.('guide')),
    vscode.commands.registerCommand('logline.showWhatsNew', () => openGuide?.('whatsNew')),
    vscode.commands.registerCommand('logline.showLogs', () =>
      vscode.commands.executeCommand('logline.logs.focus')),
    vscode.commands.registerCommand('logline.enableTerminalCapture', async () => {
      await vscode.workspace.getConfiguration('logline').update('captureTerminals', true, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage('Logline will capture new commands in supported terminals. Run a command again to capture it.');
    }),
    vscode.commands.registerCommand('logline.disableTerminalCapture', async () => {
      await vscode.workspace.getConfiguration('logline').update('captureTerminals', false, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage('Logline terminal capture is off. Running commands are not stopped.');
    }),
    vscode.commands.registerCommand('logline.shareWithAgent', () => controller.shareWithAgent()),
    vscode.commands.registerCommand('logline.shareSpecificRuns', () => controller.shareWithAgent(undefined, undefined, undefined, true)),
    vscode.commands.registerCommand('logline.stopSharing', () => controller.stopSharing()),
    vscode.commands.registerCommand('logline.askCopilot', () => controller.askCopilot()),
    vscode.commands.registerCommand('logline.manageTerminalCapture', async () => {
      const terminals = controller.terminalCapture.availableTerminals();
      const choice = await vscode.window.showQuickPick(terminals.map(item => ({
        label: `${item.ignored ? 'Enable' : 'Ignore'} · ${item.label}`, id: item.id
      })), { title: 'Manage terminal capture', placeHolder: 'Toggle capture for a terminal' });
      if (choice) { controller.terminalCapture.toggleSource(choice.id); void vscode.window.showInformationMessage(`Terminal capture ${terminals.find(item => item.id === choice.id)?.ignored ? 'enabled' : 'ignored'} for ${choice.id}.`); }
    })
  ];
}

export function startAutoServers(controller: LogsController): void {
  const config = controller.config;
  const { blocked, servers } = resolveAutoStartServers(config.get<ServerConfig[]>('servers', []), vscode.workspace.isTrusted);
  if (blocked) {
    vscode.window.showWarningMessage('Trust this workspace to auto-start saved servers.');
    return;
  }
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  for (const server of servers) controller.runner.run(server.command, resolveCwd(server.cwd, workspaceCwd), server, undefined, server.env);
}
