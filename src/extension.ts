import { join } from 'node:path';
import * as vscode from 'vscode';
import { agentClient } from './core/usage-events';
import { registerCommands, startAutoServers } from './vscode/commands';
import { LogsController } from './vscode/logs-controller';
import { LogsProvider } from './vscode/logs-view-provider';
import { registerTasks } from './vscode/tasks/provider';
import { GuidePanel } from './vscode/guide-panel';
import { GUIDE_SECTIONS, latestGuideRelease } from './vscode/guide-content';
import { registerAgentTools, runAgentTool } from './vscode/agent-tools';
import { AgentBridge, installMcpScript } from './vscode/agent-bridge';
import { copilotAvailable, refreshCopilot, refreshInstalledSkills } from './vscode/agent-setup';
import { registerDebugCapture } from './vscode/debug-capture';
import { LogBreakpoints } from './vscode/log-breakpoints';
import { LogDoctor } from './vscode/log-doctor';
import { LogLens } from './vscode/log-lens';
import { GitChanges } from './vscode/git-changes';
import { RatingPrompt } from './vscode/rating-prompt';
import { Usage, usageEnvironment, usageVocabulary } from './vscode/usage';
import { FeedbackPrompt } from './vscode/feedback';

let controller: LogsController | undefined;
let usage: Usage | undefined;

export function activate(context: vscode.ExtensionContext): { provider: LogsProvider } {
  const started = performance.now();
  const packageJSON = context.extension?.packageJSON as { version?: string } | undefined;
  usage = new Usage(context, {
    vocabulary: usageVocabulary(
      packageJSON,
      GUIDE_SECTIONS.map((section) => section.id),
    ),
    environment: usageEnvironment(packageJSON?.version ?? ''),
  });
  // Built-in Copilot shows only as a chat command, which can only be looked up asynchronously.
  void refreshCopilot().then(() => controller?.notifications.notify());
  controller = new LogsController(context);
  controller.usage = usage;
  usage.start(controller.usageSummary());
  const guide = new GuidePanel(context, () => controller!.acknowledgeGuide(), {
    progress: () => controller!.guideProgress(),
    reveal: (target, fallback) => void controller!.reveal(target, fallback),
    takeTour: () => void controller!.startTour(),
    unreadHighlights: () => (controller!.guideStatus().unread ? (latestGuideRelease.highlights.length ?? 0) : 0),
    newSections: () => controller!.guideNewSections(),
    sectionSeen: (id) => void controller!.guideSectionSeen(id),
  });
  controller.setGuideOpener((section) => guide.open(section));
  const provider = new LogsProvider(context, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('logline.logs', provider),
    ...registerCommands(controller, (section) => guide.open(section), packageJSON?.version, usage),
    ...registerTasks(controller.runner, controller.registry, controller.tasks),
    ...registerAgentTools(context, controller.agentAccess, usage),
    ...registerDebugCapture(controller.debug),
    ...controller.otel.registerDebugEnvironment(),
    controller,
    guide,
  );
  const logs = controller;
  const rating = new RatingPrompt(
    context.globalState,
    () => logs.store.total > 0,
    undefined,
    (answer) => usage?.record('prompt_answered', { prompt: 'rating', answer }),
  );
  rating.start();
  const feedback = new FeedbackPrompt(
    context.globalState,
    () => logs.openFeedback('vote'),
    () => logs.store.total > 0,
    undefined,
    (answer) => usage?.record('prompt_answered', { prompt: 'feedback', answer }),
  );
  feedback.start();
  context.subscriptions.push(rating, feedback);
  // Editor surfaces are optional: hosts without CodeLens support still capture logs.
  if (typeof vscode.languages?.registerCodeLensProvider === 'function') {
    const logController = controller;
    controller.lens = new LogLens(
      {
        store: logController.store,
        config: logController.config,
        index: logController.logSites,
        tracker: logController.siteTracker,
        generation: () => logController.state.generation,
        showQuery: (query) => logController.showQuery(query),
        usage,
      },
      context.extensionUri,
    );
    context.subscriptions.push(controller.lens);
    if (typeof vscode.languages.createDiagnosticCollection === 'function') {
      controller.doctor = new LogDoctor({
        usage,
        config: logController.config,
        index: logController.logSites,
        tracker: logController.siteTracker,
        lens: controller.lens,
        askCopilot: (prompt) => logController.openChat(prompt),
        copilot: copilotAvailable,
        showQuery: (query) => logController.showQuery(query),
        onChanged: () => {
          if (usage?.enabled && logController.doctor)
            usage.findings(logController.doctor.views().map((finding) => finding.code));
          logController.notifications.notify();
        },
        unclaimed: () => logController.unclaimedSensitive(),
        telemetry: () => logController.telemetryFindings(),
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
    const breakpoints = (controller.breakpoints = new LogBreakpoints({
      store: logController.store,
      index: logController.logSites,
      lens: () => logController.lens,
      showEvent: (id) => logController.showQuery(`id:${id}`),
      usage,
    }));
    controller.debug.onEvent = (event, session) => breakpoints.onDebugEvent(event, session);
    context.subscriptions.push(breakpoints);
  }
  // Claude Code, Codex, and other MCP clients reach shared logs through a local bridge.
  const agentController = controller;
  const bridge = (controller.agentBridge = new AgentBridge({
    run: (tool, input, token, client) =>
      runAgentTool(agentController.agentAccess, tool, input, token, { usage, client }),
    folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    name: () => vscode.workspace.name ?? 'VS Code',
    onClient: (client) => {
      usage?.agentConnected(agentClient(client));
      agentController.notifications.notify();
    },
    grant: () => agentController.agentAccess.grant,
  }));
  const syncBridge = async () => {
    try {
      if (agentController.config.get('externalAgents', true)) {
        installMcpScript(join(context.extensionUri.fsPath, 'out', 'mcp.js'));
        refreshInstalledSkills();
        await bridge.start();
      } else await bridge.stop();
    } catch (error) {
      usage?.record('error', { area: 'bridge', code: 'start_failed' });
      console.warn(
        `Logline could not start the agent bridge: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  void syncBridge();
  context.subscriptions.push(
    { dispose: () => void bridge.stop() },
    vscode.workspace.onDidChangeWorkspaceFolders?.(() => bridge.publish()) ?? { dispose() {} },
    vscode.workspace.onDidChangeConfiguration?.((event) => {
      if (event.affectsConfiguration('logline.externalAgents')) void syncBridge();
    }) ?? { dispose() {} },
  );
  startAutoServers(controller);
  context.subscriptions.push(usage);
  if (opensPanelOnInstall(usage.newInstall, context.extensionMode, vscode.env?.remoteName))
    void vscode.commands.executeCommand('logline.logs.focus');
  usage.record('perf', { op: 'activate', ms: performance.now() - started });
  return { provider };
}

/**
 * A new install opens the Logs panel once, so its welcome is seen. Not on a remote
 * host: a synced extension installs afresh in every new Codespace or container.
 */
export function opensPanelOnInstall(
  newInstall: boolean,
  mode: vscode.ExtensionMode | undefined,
  remoteName: string | undefined,
): boolean {
  return newInstall && mode === (vscode.ExtensionMode?.Production ?? 1) && !remoteName;
}

export async function deactivate(): Promise<void> {
  await Promise.all([controller?.dispose(), usage?.close()]);
}
