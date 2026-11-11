import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveAutoStartServers, resolveCwd } from '../core/server-config';
import type { ServerConfig } from '../core/types';
import type { LogsController } from './logs-controller';
import { convertTask } from './tasks/conversion';
import { showStatus } from './status';
import { counted, type Usage } from './usage';

/** How much of an existing file Open in Logline reads before following it. */
const OPEN_FILE_BYTES = 8 * 1024 * 1024;

export function registerCommands(
  controller: LogsController,
  openGuide?: (section: 'guide' | 'whatsNew') => void,
  version = '',
  usage?: Usage,
): vscode.Disposable[] {
  const registerCommand = (id: string, handler: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, counted(usage, id, handler));
  return [
    registerCommand('logline.runCommand', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before running a server command.');
        return;
      }
      const command = await vscode.window.showInputBox({
        title: 'Run server in Logs',
        prompt: 'Server command',
        placeHolder: 'npm run dev',
        ignoreFocusOut: true,
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
    registerCommand('logline.followFile', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before following a log file.');
        return;
      }
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: 'Follow',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        filters: { Logs: ['log', 'txt', 'jsonl', 'ndjson', 'out'], 'All files': ['*'] },
      });
      const files = uris?.filter((uri) => uri.scheme === 'file') ?? [];
      if (uris?.length && !files.length) {
        vscode.window.showWarningMessage('Logline can only follow files on the local filesystem.');
        return;
      }
      for (const uri of files) await controller.files.follow(uri.fsPath);
      if (files.length) await vscode.commands.executeCommand('logline.logs.focus');
    }),
    registerCommand('logline.openInLogline', async (clicked?: unknown, selected?: unknown) => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before opening a log file in Logline.');
        return;
      }
      // The Explorer passes the file clicked and every file selected; an editor title passes its own.
      const isUri = (value: unknown): value is vscode.Uri =>
        typeof (value as vscode.Uri | undefined)?.scheme === 'string' &&
        typeof (value as vscode.Uri | undefined)?.fsPath === 'string';
      const picked = Array.isArray(selected) && selected.some(isUri) ? selected.filter(isUri) : [clicked].filter(isUri);
      const uris = picked.length ? picked : [vscode.window.activeTextEditor?.document.uri].filter(isUri);
      if (!uris.length) return vscode.commands.executeCommand('logline.followFile');
      const files = uris.filter((uri) => uri.scheme === 'file');
      if (!files.length) {
        vscode.window.showWarningMessage('Logline can only open files on the local filesystem.');
        return;
      }
      usage?.record('entry', { from: Array.isArray(selected) ? 'explorer' : 'editor' });
      // The whole of an ordinary log file, and whatever is written to it afterwards.
      for (const uri of files) await controller.files.follow(uri.fsPath, { tailBytes: OPEN_FILE_BYTES });
      await vscode.commands.executeCommand('logline.logs.focus');
    }),
    registerCommand('logline.captureThisTerminal', async () => {
      usage?.record('entry', { from: 'terminal_menu' });
      const terminal = vscode.window.activeTerminal;
      if (terminal) controller.terminalCapture.resetTerminalIgnore(terminal);
      await controller.toggleTerminalCapture(true);
      void vscode.window.showInformationMessage(
        'Logline will capture the next command you run in this terminal. Output from a command already in progress cannot be recovered.',
      );
      await vscode.commands.executeCommand('logline.logs.focus');
    }),
    registerCommand('logline.followCompose', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before following a Docker Compose project.');
        return;
      }
      const files = await vscode.workspace.findFiles(
        '**/{compose,docker-compose}{,.*}.{yaml,yml}',
        '**/node_modules/**',
        50,
      );
      if (!files.length) {
        vscode.window.showWarningMessage('Logline found no compose.yaml or docker-compose.yml in this workspace.');
        return;
      }
      const picked =
        files.length === 1
          ? files[0]
          : (
              await vscode.window.showQuickPick(
                files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
                { title: 'Follow Docker Compose project' },
              )
            )?.uri;
      if (!picked) return;
      const folder = path.dirname(picked.fsPath);
      // `logs --follow` attaches to running services without starting them, and
      // keeps following containers that restart. Timestamps order lines from
      // services whose own logs carry none.
      controller.runner.run(
        'docker',
        folder,
        { id: `compose:${picked.fsPath}`, label: `Compose · ${path.basename(folder)}` },
        undefined,
        undefined,
        ['compose', '-f', picked.fsPath, 'logs', '--follow', '--no-color', '--timestamps', '--tail', '200'],
      );
      await vscode.commands.executeCommand('logline.logs.focus');
    }),
    registerCommand('logline.addConnection', () => controller.connections.add()),
    registerCommand('logline.searchConnection', (id?: unknown) =>
      controller.connections.query(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.runConnectionSql', (id?: unknown) =>
      controller.connections.runSql(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.openConnectionLink', (id?: unknown) =>
      controller.connections.openLink(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.allowAgentConnection', (id?: unknown) =>
      controller.connections.allowAgents(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.revokeAgentConnection', (id?: unknown) =>
      controller.connections.revokeAgents(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.tailConnection', (id?: unknown) =>
      controller.connections.tail(typeof id === 'string' ? id : undefined, ''),
    ),
    registerCommand('logline.testConnection', (id?: unknown) =>
      controller.connections.test(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.editConnection', (id?: unknown) =>
      controller.connections.edit(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.removeConnection', (id?: unknown) =>
      controller.connections.remove(typeof id === 'string' ? id : undefined),
    ),
    registerCommand('logline.stopCommand', () => controller.stop()),
    registerCommand('logline.export', () => controller.transfer.exportLogs()),
    registerCommand('logline.import', () => controller.transfer.importLogs()),
    registerCommand('logline.exportForAI', () => {
      usage?.record('exported_for_ai');
      return controller.transfer.exportForAI();
    }),
    registerCommand('logline.convertTask', () => convertTask()),
    // Keep a task-oriented alias for command palettes and keybindings.
    registerCommand('logline.captureTask', () => convertTask()),
    registerCommand('logline.showGuide', () => openGuide?.('guide')),
    registerCommand('logline.showWhatsNew', () => openGuide?.('whatsNew')),
    registerCommand('logline.takeTour', () => controller.startTour()),
    registerCommand('logline.showLogs', () => vscode.commands.executeCommand('logline.logs.focus')),
    registerCommand('logline.enableTerminalCapture', async () => {
      await vscode.workspace
        .getConfiguration('logline')
        .update('captureTerminals', true, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(
        'Logline will capture the next command in a supported terminal. Output from commands already in progress cannot be recovered.',
      );
    }),
    registerCommand('logline.disableTerminalCapture', async () => {
      await vscode.workspace
        .getConfiguration('logline')
        .update('captureTerminals', false, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage('Logline terminal capture is off. Running commands are not stopped.');
    }),
    registerCommand('logline.shareWithAgent', () => controller.shareWithAgent()),
    registerCommand('logline.shareSpecificRuns', () =>
      controller.shareWithAgent(undefined, undefined, undefined, true),
    ),
    registerCommand('logline.stopSharing', () => controller.stopSharing()),
    registerCommand('logline.askCopilot', () => controller.askCopilot()),
    registerCommand('logline.connectAgent', () => controller.connectAgent()),
    registerCommand('logline.setUpForAgent', () => controller.setUpForAgent()),
    registerCommand('logline.showStatus', () => showStatus(controller, version)),
    registerCommand('logline.startOtlpReceiver', () => controller.toggleOtlp(true)),
    registerCommand('logline.stopOtlpReceiver', () => controller.toggleOtlp(false)),
    registerCommand('logline.showTrace', async (value?: unknown) => {
      const traceId =
        typeof value === 'string'
          ? value
          : await vscode.window.showInputBox({
              title: 'Show trace',
              prompt: 'Trace id (32 hex characters)',
              ignoreFocusOut: true,
              validateInput: (input) =>
                /^[A-Za-z0-9_-]{1,128}$/.test(input.trim())
                  ? undefined
                  : 'Enter a trace id of letters, digits, - or _.',
            });
      if (traceId?.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(traceId.trim())) await controller.showTrace(traceId.trim());
    }),
    registerCommand('logline.showUsageData', () => usage?.showData()),
    registerCommand('logline.resetUsageId', () => usage?.resetId()),
    registerCommand('logline.suggestFeature', () => controller.openFeedback('suggest')),
    registerCommand('logline.voteOnNext', () => controller.openFeedback('vote')),
    registerCommand('logline.manageTerminalCapture', async () => {
      const terminals = controller.terminalCapture.availableTerminals();
      const choice = await vscode.window.showQuickPick(
        terminals.map((item) => ({
          label: `${item.ignored ? 'Enable' : 'Ignore'} · ${item.label}`,
          id: item.id,
        })),
        { title: 'Manage terminal capture', placeHolder: 'Toggle capture for a terminal' },
      );
      if (choice) {
        controller.terminalCapture.toggleSource(choice.id);
        void vscode.window.showInformationMessage(
          `Terminal capture ${terminals.find((item) => item.id === choice.id)?.ignored ? 'enabled' : 'ignored'} for ${choice.id}.`,
        );
      }
    }),
  ];
}

export function startAutoServers(controller: LogsController): void {
  const config = controller.config;
  const { blocked, servers } = resolveAutoStartServers(
    config.get<ServerConfig[]>('servers', []),
    vscode.workspace.isTrusted,
  );
  if (blocked) {
    vscode.window.showWarningMessage('Trust this workspace to auto-start saved servers.');
    return;
  }
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  for (const server of servers)
    controller.runner.run(server.command, resolveCwd(server.cwd, workspaceCwd), server, undefined, server.env);
}
