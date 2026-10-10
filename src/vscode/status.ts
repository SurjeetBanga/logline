import * as vscode from 'vscode';
import { statusItems, statusText, type StatusInput, type StatusItem } from '../core/status';
import { agentsWithSkills, copilotAvailable } from './agent-setup';
import { doctorMode } from './log-doctor';
import type { LogsController } from './logs-controller';

/** What Show Status reports, read from the running controller. */
export function statusInput(controller: LogsController): StatusInput {
  const { config, otlp } = controller;
  const receiver = otlp.status();
  const stats = controller.store.stats();
  const sharing = controller.agentAccess.status();
  return {
    receiver: {
      running: receiver.running,
      endpoint: receiver.endpoint,
      error: receiver.error,
      requestedPort: otlp.requestedPort,
      port: config.get('otlp.port', 4318),
      injectEnvironment: config.get('otlp.injectEnvironment', true),
      traces: controller.spans.traceCount,
      metricSeries: controller.metrics.size,
    },
    agents: {
      enabled: config.get('externalAgents', true),
      bridgeRunning: controller.agentBridge?.running ?? false,
      clients: controller.agentBridge?.recentClients() ?? [],
      skills: agentsWithSkills(),
      sharing: { active: sharing.active, scope: sharing.scope, sources: sharing.sources.length },
      copilot: copilotAvailable(),
    },
    capture: {
      terminal: controller.terminalCapture.status(),
      debugSessions: config.get('captureDebugSessions', true),
      running: controller.runner.sessions.size + controller.tasks.executions.size + controller.files.active,
    },
    retention: {
      events: stats.retained,
      bytes: stats.bytes,
      maxBytes: stats.maxBytes,
      discarded: stats.discarded,
      persist: config.get('persistLogs', false),
    },
    editor: {
      lenses: controller.lens?.enabled ?? false,
      doctor: doctorMode(config),
      findings: controller.doctor?.total ?? 0,
      changedFiles: controller.gitChanges?.status()?.files,
    },
  };
}

const ICONS: Record<StatusItem['state'], string> = { ok: '$(pass)', off: '$(circle-slash)', problem: '$(warning)' };

/**
 * Logline: Show Status. Lists the receiver, agent connections, sharing,
 * capture, retention, and editor features; choosing one runs its fix.
 */
export async function showStatus(controller: LogsController, version: string): Promise<void> {
  const items = statusItems(statusInput(controller));
  const problems = items.filter((item) => item.state === 'problem').length;
  type Pick = vscode.QuickPickItem & { item?: StatusItem; copy?: boolean };
  const picks: Pick[] = items.map((item) => ({
    label: `${ICONS[item.state]} ${item.area}`,
    description: item.summary,
    detail: [item.detail, item.action ? `→ ${item.action.label}` : ''].filter(Boolean).join(' '),
    item,
  }));
  picks.push(
    { label: '', kind: vscode.QuickPickItemKind?.Separator ?? -1 },
    { label: '$(copy) Copy status', description: 'For a bug report or a message', copy: true },
  );
  const chosen = await vscode.window.showQuickPick(picks, {
    title: `Logline status${problems ? ` · ${problems} ${problems === 1 ? 'problem' : 'problems'}` : ''}`,
    placeHolder: 'Choose an item to fix or change it',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!chosen) return;
  if (chosen.copy) {
    await vscode.env.clipboard.writeText(statusText(items, version));
    void vscode.window.showInformationMessage('Copied Logline status.');
    return;
  }
  const action = chosen.item?.action;
  if (action) await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
}
