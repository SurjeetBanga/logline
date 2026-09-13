import * as vscode from 'vscode';
import { registerCommands, startAutoServers } from './vscode/commands';
import { LogsController } from './vscode/logs-controller';
import { LogsProvider } from './vscode/logs-view-provider';
import { registerTasks } from './vscode/tasks/provider';

let controller: LogsController | undefined;

export function activate(context: vscode.ExtensionContext): { provider: LogsProvider; } {
  controller = new LogsController(context);
  const provider = new LogsProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('logline.logs', provider),
    ...registerCommands(controller),
    ...registerTasks(controller.runner, controller.registry, controller.tasks),
    controller
  );
  startAutoServers(controller);
  return { provider };
}

export function deactivate(): Promise<void> | undefined { return controller?.dispose(); }
