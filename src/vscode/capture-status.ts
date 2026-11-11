import * as vscode from 'vscode';
import type { LogStore } from '../core/log-store';
import type { LogEvent } from '../core/types';
import type { NudgeStep } from '../core/usage-events';

/** Set by Don't Show Again on the errors notification. */
export const ERROR_NUDGE_OFF_KEY = 'logline.errorNudge.off';
/** How often the counts are read: the capture path is never touched. */
export const STATUS_POLL_MS = 2000;
/** The least time between two errors notifications, however many runs fail. */
export const ERROR_NUDGE_GAP_MS = 10 * 60 * 1000;

const SHOW_COMMAND = 'logline.showCaptured';

export interface CaptureStatusSources {
  store: Pick<LogStore, 'eventsAfter' | 'stats'>;
  /** Changes when retained logs are cleared. */
  generation(): number;
  /** Whether the Logs panel is on screen: nothing is said about logs someone is looking at. */
  panelVisible(): boolean;
  /** Whether `logline.statusBar.enabled` is on. */
  enabled(): boolean;
  /** Filter the Logs panel and bring it into view. */
  showQuery(query: string): Promise<void>;
  memento: Pick<vscode.Memento, 'get' | 'update'>;
  entered?: () => void;
  nudged?: (step: NudgeStep) => void;
  now?: () => number;
}

export function isError(event: Pick<LogEvent, 'level'>): boolean {
  const level = String(event.level).toLowerCase();
  return level === 'error' || level === 'fatal';
}

/** `128 logs · 3 errors`, with large counts shortened. */
export function statusText(logs: number, errors: number): string {
  const short = (n: number) =>
    n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
  return `$(pulse) ${short(logs)} log${logs === 1 ? '' : 's'}${errors ? ` · ${short(errors)} error${errors === 1 ? '' : 's'}` : ''}`;
}

/**
 * Says, outside the Logs panel, that Logline has captured something: a status
 * bar item with how many logs and errors, and a notification the first time a
 * run logs errors while the panel is hidden.
 */
export class CaptureStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private generation?: number;
  private watermark = 0;
  private errors = 0;
  /** Errors per run. A run is announced, or passed over, when its first errors arrive, and never later. */
  private readonly runs = new Map<string, { errors: number; label: string }>();
  private lastNudge?: number;

  constructor(private readonly sources: CaptureStatusSources) {
    this.item = vscode.window.createStatusBarItem?.('logline.captured', vscode.StatusBarAlignment.Left, 49);
    if (this.item) {
      this.item.name = 'Logline captured logs';
      this.item.command = SHOW_COMMAND;
    }
    this.disposables.push(vscode.commands.registerCommand(SHOW_COMMAND, () => this.show()));
    this.timer = setInterval(() => this.refresh(), STATUS_POLL_MS);
    this.timer.unref?.();
  }

  /** Open the Logs panel from the status bar, on the errors when there are some. */
  async show(): Promise<void> {
    this.sources.entered?.();
    if (this.errors) await this.sources.showQuery('level:error');
    else await vscode.commands.executeCommand('logline.logs.focus');
  }

  /** Count what arrived since the last look, and say so. */
  refresh(): void {
    const { store } = this.sources;
    const generation = this.sources.generation();
    if (generation !== this.generation) {
      this.generation = generation;
      this.watermark = 0;
      this.errors = 0;
      this.runs.clear();
    }
    const fresh: string[] = [];
    for (const event of store.eventsAfter(this.watermark)) {
      this.watermark = event.id;
      if (!isError(event)) continue;
      this.errors++;
      const id = event.sessionId ?? event.serverId;
      if (!id) continue;
      let run = this.runs.get(id);
      if (!run) {
        this.runs.set(id, (run = { errors: 0, label: event.server ?? '' }));
        fresh.push(id);
      }
      run.errors++;
    }
    this.render(store.stats().retained);
    if (fresh.length) void this.nudge(fresh);
  }

  private render(retained: number): void {
    if (!this.item) return;
    if (!retained || !this.sources.enabled()) {
      this.item.hide();
      return;
    }
    this.item.text = statusText(retained, this.errors);
    this.item.tooltip = this.errors
      ? 'Logline captured errors. Click to see them in the Logs panel.'
      : 'Logline is capturing logs. Click to search them in the Logs panel.';
    this.item.show();
  }

  /** Tell someone who is not looking that a run logged errors: once per run, and not often. */
  private async nudge(fresh: string[]): Promise<void> {
    const { memento, nudged } = this.sources;
    const now = (this.sources.now ?? Date.now)();
    const runs = fresh.map((id) => this.runs.get(id)!);
    if (
      this.sources.panelVisible() ||
      memento.get<boolean>(ERROR_NUDGE_OFF_KEY) ||
      (this.lastNudge !== undefined && now - this.lastNudge < ERROR_NUDGE_GAP_MS)
    )
      return;
    this.lastNudge = now;
    const count = runs.reduce((sum, run) => sum + run.errors, 0);
    const from = runs.length === 1 && runs[0].label ? ` from ${runs[0].label}` : '';
    nudged?.('shown');
    const answer = await vscode.window.showInformationMessage(
      `Logline caught ${count} error${count === 1 ? '' : 's'}${from}.`,
      'Show Errors',
      "Don't Show Again",
    );
    if (answer === 'Show Errors') {
      nudged?.('accepted');
      await this.sources.showQuery('level:error');
    } else if (answer === "Don't Show Again") {
      nudged?.('never');
      await Promise.resolve(memento.update(ERROR_NUDGE_OFF_KEY, true)).catch(() => undefined);
    } else nudged?.('dismissed');
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
