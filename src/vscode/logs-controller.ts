import * as vscode from 'vscode';
import { Ingestion } from '../capture/ingestion';
import { ProcessRunner } from '../capture/process-runner';
import { RuntimeState } from '../capture/runtime-state';
import { SessionRegistry } from '../capture/session-registry';
import { LogStore } from '../core/log-store';
import type { HostMessage, ViewRequest } from '../protocol/messages';
import { LogPersistence } from '../storage/log-persistence';
import { SavedSearches } from '../storage/saved-searches';
import { Configuration } from './configuration';
import { LogTransfer } from './log-transfer';
import { handleMessage } from './message-router';
import { buildSnapshot } from './snapshot';
import { TaskLifecycle } from './tasks/lifecycle';
import { ViewNotifications } from './view-notifications';
import { GUIDE_STATE_KEY, guideStatus as getGuideStatus } from './guide-content';

/** Composition root for services used by commands, tasks and the Logs view. */
export class LogsController {
  readonly config = new Configuration();
  readonly notifications = new ViewNotifications(this.config);
  readonly state = new RuntimeState(() => this.notifications.notify());
  readonly store = new LogStore(this.config.get('maxEvents', 50000), this.config.get('maxMemoryMb', 100) * 1024 * 1024);
  readonly registry = new SessionRegistry();
  readonly persistence = new LogPersistence(this.config, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    message => { void vscode.window.showWarningMessage(message); });
  readonly ingestion = new Ingestion(this.store, raw => this.persistence.persist(raw));
  readonly runner = new ProcessRunner(this.config, this.registry, this.ingestion, this.state);
  readonly tasks = new TaskLifecycle(this.registry, this.ingestion, this.state, () => this.runner.sessions.size > 0);
  readonly transfer = new LogTransfer(this.store, this.config, this.ingestion, this.state);
  readonly searches: SavedSearches;
  private readonly globalState: Pick<vscode.ExtensionContext, 'globalState'>['globalState'];
  private readonly configSubscription: vscode.Disposable;
  private disposing?: Promise<void>;
  private guideOpener?: (section: 'guide' | 'whatsNew') => void;

  constructor(context: Pick<vscode.ExtensionContext, 'globalState'>) {
    this.globalState = context.globalState;
    this.searches = new SavedSearches(context.globalState);
    this.configSubscription = vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('logline')) return;
      this.config.refresh();
      if (event.affectsConfiguration('logline.maxEvents') || event.affectsConfiguration('logline.maxMemoryMb')) {
        const maxRows = this.config.get('maxEvents', 50000), maxBytes = this.config.get('maxMemoryMb', 100) * 1024 * 1024;
        if (maxRows !== this.store.maxRows || maxBytes !== this.store.maxBytes) {
          this.store.resize(maxRows, maxBytes);
          this.state.invalidate();
        }
      }
      if (event.affectsConfiguration('logline.persistLogs') || event.affectsConfiguration('logline.maxDiskMb')) this.persistence.invalidate();
      if (event.affectsConfiguration('logline.servers')) this.notifications.send({ type: 'serversChanged' });
    });
  }
  snapshot(request: Extract<ViewRequest, { type: 'snapshot'; }>) {
    return buildSnapshot(request, { store: this.store, config: this.config, registry: this.registry, state: this.state,
      ingestion: this.ingestion, persistence: this.persistence, searches: this.searches,
      running: this.runner.sessions.size > 0 || this.tasks.executions.size > 0,
      guideStatus: this.guideStatus() });
  }
  guideStatus() {
    return getGuideStatus(this.globalState.get<string>(GUIDE_STATE_KEY));
  }
  async acknowledgeGuide(): Promise<void> {
    await this.globalState.update(GUIDE_STATE_KEY, this.guideStatus().version);
    this.notifications.send({ type: 'guideStatus', ...this.guideStatus() });
  }
  setGuideOpener(opener: (section: 'guide' | 'whatsNew') => void): void { this.guideOpener = opener; }
  handleMessage(send: (message: HostMessage) => void, message: unknown): Promise<void> {
    return handleMessage({
      store: this.store, config: this.config, transfer: this.transfer, searches: this.searches,
      snapshot: request => this.snapshot(request), clear: () => this.clear(), stop: id => this.stop(id), runner: this.runner,
      showGuide: section => this.guideOpener?.(section)
    }, send, message);
  }
  clear(): void {
    this.store.clear();
    this.registry.clearCompleted();
    // A clear must also remove a completed import's status. Active capture is
    // intentionally retained, so keep its truthful running state instead.
    this.state.reset(this.runner.sessions.size > 0 || this.tasks.executions.size > 0);
  }
  stop(serverId?: string): void {
    if (serverId) this.runner.stopServer(serverId); else this.runner.stop();
    this.tasks.stop(serverId);
  }
  dispose(): Promise<void> {
    return this.disposing ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    this.configSubscription.dispose();
    this.notifications.dispose();
    this.tasks.stop();
    // Closing streams may emit a final partial line; flush persistence afterwards.
    await this.runner.dispose();
    await this.persistence.dispose();
  }
}
