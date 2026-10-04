import * as vscode from 'vscode';
import { registerCommands, startAutoServers } from './vscode/commands';
import { LogsController } from './vscode/logs-controller';
import { LogsProvider } from './vscode/logs-view-provider';
import { registerTasks } from './vscode/tasks/provider';
import { GuidePanel } from './vscode/guide-panel';
import { registerAgentTools } from './vscode/agent-tools';
import { registerDebugCapture } from './vscode/debug-capture';
import { LogBreakpoints } from './vscode/log-breakpoints';
import { LogDoctor } from './vscode/log-doctor';
import { LogLens } from './vscode/log-lens';

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
    ...registerDebugCapture(controller.debug),
    ...controller.otel.registerDebugEnvironment(),
    controller,
    guide
  );
  // Editor surfaces are optional: hosts without CodeLens support still capture logs.
  if (typeof vscode.languages?.registerCodeLensProvider === 'function') {
    const logController = controller;
    controller.lens = new LogLens({
      store: logController.store, config: logController.config, index: logController.logSites, tracker: logController.siteTracker,
      generation: () => logController.state.generation, showQuery: query => logController.showQuery(query)
    }, context.extensionUri);
    context.subscriptions.push(controller.lens);
    if (typeof vscode.languages.createDiagnosticCollection === 'function') {
      controller.doctor = new LogDoctor({
        config: logController.config, index: logController.logSites, tracker: logController.siteTracker, lens: controller.lens,
        askCopilot: prompt => logController.openChat(prompt),
        showQuery: query => logController.showQuery(query),
        onChanged: () => logController.notifications.notify()
      });
      context.subscriptions.push(controller.doctor);
    }
  }
  if (typeof vscode.debug?.addBreakpoints === 'function') {
    const logController = controller;
    const breakpoints = controller.breakpoints = new LogBreakpoints({
      store: logController.store, index: logController.logSites, lens: () => logController.lens,
      showEvent: id => logController.showQuery(`id:${id}`)
    });
    controller.debug.onEvent = (event, session) => breakpoints.onDebugEvent(event, session);
    context.subscriptions.push(breakpoints);
  }
  startAutoServers(controller);
  return { provider };
}

export function deactivate(): Promise<void> | undefined { return controller?.dispose(); }
