import * as vscode from 'vscode';
import type { ProcessRunner } from '../capture/process-runner';
import { extractExceptions } from '../core/exceptions';
import { formatDetails } from '../core/format-details';
import type { LogStore } from '../core/log-store';
import { resolveRunTarget } from '../core/server-config';
import type { Settings } from '../core/settings';
import { parseViewRequest, type HostMessage, type Snapshot, type ViewRequest } from '../protocol/messages';
import type { SavedSearches } from '../storage/saved-searches';
import type { LogTransfer } from './log-transfer';
import { manageServers } from './servers';
import { openSource } from './source-navigation';
import type { AgentLogAccess } from './agent-access';

interface MessageServices {
  store: LogStore; config: Settings; runner: ProcessRunner; transfer: LogTransfer; searches: SavedSearches;
  snapshot(request: Extract<ViewRequest, { type: 'snapshot'; }>): Snapshot;
  clear(): void; stop(serverId?: string): void;
  showGuide(section: 'guide' | 'whatsNew'): void;
  agentAccess: AgentLogAccess;
  shareWithAgent(sourceIds?: string[], anchor?: number, sessionIds?: string[], chooseRuns?: boolean): Promise<void>;
  stopSharing(): void;
  askCopilot(anchor?: number): Promise<boolean>;
  toggleTerminalCapture(enabled: boolean): Promise<void>;
}
export async function handleMessage(services: MessageServices, send: (message: HostMessage) => void, value: unknown): Promise<void> {
  const msg = parseViewRequest(value);
  if (!msg) return;
  const { store, config, transfer, searches } = services;
  switch (msg.type) {
    case 'snapshot': send(services.snapshot(msg)); return;
    case 'context': send({ type: 'context', id: msg.id, ...store.context(msg.id) }); return;
    case 'openSource': await openSource(store, msg); return;
    case 'saveSearch': {
      const saved = searches.saveSearch(msg.name, msg.query ?? '', msg.levels, msg.serverId);
      send({ type: 'searches', searches: { saved: searches.savedSearches() }, saved }); return;
    }
    case 'deleteSavedSearch': searches.deleteSavedSearch(msg.id); send({ type: 'searches', searches: { saved: searches.savedSearches() } }); return;
    case 'autocomplete': send({ type: 'autocomplete', input: msg.input ?? '', serverId: msg.serverId,
      ...store.fieldSuggestions(msg.input, msg.serverId) }); return;
    case 'analysis': send({ type: 'analysis', analysis: store.analysis(msg) }); return;
    case 'export': await transfer.exportLogs(msg); return;
    case 'exportForAI': await transfer.exportForAI(msg); return;
    case 'copyFiltered': await transfer.copyFiltered(msg); return;
    case 'exportContext': await transfer.exportContext(msg.ids); return;
    case 'shareWithAgent': await services.shareWithAgent(msg.sourceIds, msg.anchor, msg.sessionIds, msg.chooseRuns); return;
    case 'stopSharing': services.stopSharing(); return;
    case 'askCopilot': await services.askCopilot(msg.anchor); return;
    case 'shareEvent': {
      const event = store.find(msg.id);
      if (event?.serverId) await services.shareWithAgent([event.serverId], msg.id);
      else void vscode.window.showWarningMessage('This event is no longer available to share.');
      return;
    }
    case 'toggleTerminalCapture': await services.toggleTerminalCapture(msg.enabled); return;
    case 'showGuide': services.showGuide(msg.section ?? 'guide'); return;
    case 'import': await transfer.importLogs(); return;
    case 'details': case 'copy': {
      const event = store.find(msg.id);
      let text = event?.raw ?? 'This event has been discarded from the retained history.';
      if (event?.isJson && event.raw !== undefined) text = formatDetails(event.raw, config.get('indentation', 2));
      if (event?.truncated) text += `\n[Truncated: line exceeded ${config.get('maxLineLength', 65536).toLocaleString()} characters]`;
      if (msg.type === 'copy' && event) await vscode.env.clipboard.writeText(text);
      if (msg.type === 'details') send({ type: 'details', id: msg.id, text, target: msg.target ?? 'main', exceptions: event ? extractExceptions(event) : [] });
      return;
    }
    case 'clear': services.clear(); return;
    case 'stop': services.stop(msg.serverId); return;
    case 'config': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:surjeetbanga.logline'); return;
    case 'manageServers': await manageServers(); return;
    case 'run': {
      if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('Trust this workspace before running a server command.'); return; }
      const target = resolveRunTarget(config.get('servers', []), msg.serverId ?? '', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (target) services.runner.run(target.command, target.cwd, target.server, undefined, target.env);
      else await vscode.commands.executeCommand('logline.runCommand');
    }
  }
}
