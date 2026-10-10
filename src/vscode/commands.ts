import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveAutoStartServers, resolveCwd } from '../core/server-config';
import type { ServerConfig } from '../core/types';
import type { LogsController } from './logs-controller';
import { convertTask } from './tasks/conversion';
import { showStatus } from './status';

export function registerCommands(controller: LogsController, openGuide?: (section: 'guide' | 'whatsNew') => void, version = ''): vscode.Disposable[] {
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
    vscode.commands.registerCommand('logline.followFile', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before following a log file.');
        return;
      }
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Follow',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        filters: { Logs: ['log', 'txt', 'jsonl', 'ndjson', 'out'], 'All files': ['*'] }
      });
      const files = uris?.filter(uri => uri.scheme === 'file') ?? [];
      if (uris?.length && !files.length) {
        vscode.window.showWarningMessage('Logline can only follow files on the local filesystem.');
        return;
      }
      for (const uri of files) await controller.files.follow(uri.fsPath);
      if (files.length) await vscode.commands.executeCommand('logline.logs.focus');
    }),
    vscode.commands.registerCommand('logline.followCompose', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before following a Docker Compose project.');
        return;
      }
      const files = await vscode.workspace.findFiles('**/{compose,docker-compose}{,.*}.{yaml,yml}', '**/node_modules/**', 50);
      if (!files.length) {
        vscode.window.showWarningMessage('Logline found no compose.yaml or docker-compose.yml in this workspace.');
        return;
      }
      const picked = files.length === 1 ? files[0] : (await vscode.window.showQuickPick(
        files.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), { title: 'Follow Docker Compose project' }))?.uri;
      if (!picked) return;
      const folder = path.dirname(picked.fsPath);
      // `logs --follow` attaches to running services without starting them, and
      // keeps following containers that restart. Timestamps order lines from
      // services whose own logs carry none.
      controller.runner.run('docker', folder, { id: `compose:${picked.fsPath}`, label: `Compose · ${path.basename(folder)}` }, undefined, undefined,
        ['compose', '-f', picked.fsPath, 'logs', '--follow', '--no-color', '--timestamps', '--tail', '200']);
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
      void vscode.window.showInformationMessage('Logline will capture the next command in a supported terminal. Output from commands already in progress cannot be recovered.');
    }),
    vscode.commands.registerCommand('logline.disableTerminalCapture', async () => {
      await vscode.workspace.getConfiguration('logline').update('captureTerminals', false, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage('Logline terminal capture is off. Running commands are not stopped.');
    }),
    vscode.commands.registerCommand('logline.shareWithAgent', () => controller.shareWithAgent()),
    vscode.commands.registerCommand('logline.shareSpecificRuns', () => controller.shareWithAgent(undefined, undefined, undefined, true)),
    vscode.commands.registerCommand('logline.stopSharing', () => controller.stopSharing()),
    vscode.commands.registerCommand('logline.askCopilot', () => controller.askCopilot()),
    vscode.commands.registerCommand('logline.connectAgent', () => controller.connectAgent()),
    vscode.commands.registerCommand('logline.showStatus', () => showStatus(controller, version)),
    vscode.commands.registerCommand('logline.startOtlpReceiver', () => controller.toggleOtlp(true)),
    vscode.commands.registerCommand('logline.stopOtlpReceiver', () => controller.toggleOtlp(false)),
    vscode.commands.registerCommand('logline.showTrace', async (value?: unknown) => {
      const traceId = typeof value === 'string' ? value : await vscode.window.showInputBox({
        title: 'Show trace', prompt: 'Trace id (32 hex characters)', ignoreFocusOut: true,
        validateInput: input => /^[A-Za-z0-9_-]{1,128}$/.test(input.trim()) ? undefined : 'Enter a trace id of letters, digits, - or _.'
      });
      if (traceId?.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(traceId.trim())) await controller.showTrace(traceId.trim());
    }),
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
