import { join } from 'node:path';
import * as vscode from 'vscode';
import { registerCommands, startAutoServers } from './vscode/commands';
import { LogsController } from './vscode/logs-controller';
import { LogsProvider } from './vscode/logs-view-provider';
import { registerTasks } from './vscode/tasks/provider';
import { GuidePanel } from './vscode/guide-panel';
import { registerAgentTools, runAgentTool } from './vscode/agent-tools';
import { AgentBridge, installMcpScript } from './vscode/agent-bridge';
import { copilotAvailable, refreshInstalledSkills } from './vscode/agent-setup';
import { registerDebugCapture } from './vscode/debug-capture';
import { LogBreakpoints } from './vscode/log-breakpoints';
import { LogDoctor } from './vscode/log-doctor';
import { LogLens } from './vscode/log-lens';
import { GitChanges } from './vscode/git-changes';

let controller: LogsController | undefined;

export function activate(context: vscode.ExtensionContext): { provider: LogsProvider; } {
  controller = new LogsController(context);
  const guide = new GuidePanel(context, () => controller!.acknowledgeGuide());
  controller.setGuideOpener(section => guide.open(section));
  const provider = new LogsProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('logline.logs', provider),
    ...registerCommands(controller, section => guide.open(section), (context.extension?.packageJSON as { version?: string } | undefined)?.version),
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
        copilot: copilotAvailable,
        showQuery: query => logController.showQuery(query),
        onChanged: () => logController.notifications.notify(),
        unclaimed: () => logController.unclaimedSensitive(),
        telemetry: () => logController.telemetryFindings()
      });
      context.subscriptions.push(controller.doctor);
    }
  }
  // Changed lines come from the built-in git extension; without it, no code counts as changed.
  if (typeof vscode.extensions?.getExtension === 'function') {
    const logController = controller;
    controller.gitChanges = new GitChanges(logController.changedLines, () => logController.notifications.notify());
    context.subscriptions.push(controller.gitChanges);
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
  // Claude Code, Codex, and other MCP clients reach shared logs through a local bridge.
  const agentController = controller;
  const bridge = controller.agentBridge = new AgentBridge({
    run: (tool, input, token) => runAgentTool(agentController.agentAccess, tool, input, token),
    folders: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
    name: () => vscode.workspace.name ?? 'VS Code',
    onClient: () => agentController.notifications.notify(),
    grant: () => agentController.agentAccess.grant
  });
  const syncBridge = async () => {
    try {
      if (agentController.config.get('externalAgents', true)) { installMcpScript(join(context.extensionUri.fsPath, 'out', 'mcp.js')); refreshInstalledSkills(); await bridge.start(); }
      else await bridge.stop();
    } catch (error) { console.warn(`Logline could not start the agent bridge: ${error instanceof Error ? error.message : String(error)}`); }
  };
  void syncBridge();
  context.subscriptions.push({ dispose: () => void bridge.stop() },
    vscode.workspace.onDidChangeWorkspaceFolders?.(() => bridge.publish()) ?? { dispose() { } },
    vscode.workspace.onDidChangeConfiguration?.(event => { if (event.affectsConfiguration('logline.externalAgents')) void syncBridge(); }) ?? { dispose() { } });
  startAutoServers(controller);
  return { provider };
}

export function deactivate(): Promise<void> | undefined { return controller?.dispose(); }
