import * as vscode from 'vscode';
import { registerCommands, startAutoServers } from './vscode/commands';
import { LogsController } from './vscode/logs-controller';
import { LogsProvider } from './vscode/logs-view-provider';
import { registerTasks } from './vscode/tasks/provider';
import { GuidePanel } from './vscode/guide-panel';
import { registerAgentTools } from './vscode/agent-tools';

let controller: LogsController | undefined;

export function activate(context: vscode.ExtensionContext): { provider: LogsProvider; } {
  controller = new LogsController(context);
  const guide = new GuidePanel(context, () => controller!.acknowledgeGuide());
  controller.setGuideOpener(section => guide.open(section));
  const provider = new LogsProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('logline.logs', provider),
    ...registerCommands(controller, section => guide.open(section)),
    ...registerTasks(controller.runner, controller.registry, controller.tasks),
    ...registerAgentTools(context, controller.agentAccess),
    controller,
    guide
  );
  startAutoServers(controller);
  return { provider };
}

export function deactivate(): Promise<void> | undefined { return controller?.dispose(); }
