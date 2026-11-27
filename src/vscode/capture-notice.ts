import * as vscode from 'vscode';
import type { NudgeStep } from '../core/usage-events';

/** Set once the notice that terminal capture is on by default was shown on this profile. */
export const CAPTURE_NOTICE_KEY = 'logline.captureNotice.v1';

const SHOW_LOGS = 'Show Logs';
const TURN_OFF = 'Turn Off';

export interface CaptureNoticeOptions {
  global: Pick<vscode.Memento, 'get' | 'update'>;
  /** Whether capture is on because nobody set `logline.captureTerminals`, rather than by choice. */
  byDefault: () => boolean;
  /** Turn terminal capture off everywhere. */
  turnOff: () => Promise<unknown>;
  showLogs: () => unknown;
  record?: (step: NudgeStep) => void;
}

/**
 * Says once, the first time a terminal command is captured because capture is on by default, that
 * Logline is capturing it, that it stays on this computer, and how to turn it off.
 */
export class CaptureNotice {
  private told = false;

  constructor(private readonly options: CaptureNoticeOptions) {}

  /** A terminal command started being captured; returns whether the notice was shown. */
  async captured(): Promise<boolean> {
    const { global, record } = this.options;
    if (this.told || global.get<boolean>(CAPTURE_NOTICE_KEY, false) || !this.options.byDefault()) return false;
    this.told = true;
    // Saved before asking, so another window or an unanswered notice does not show it again.
    await Promise.resolve(global.update(CAPTURE_NOTICE_KEY, true)).catch(() => undefined);
    record?.('shown');
    const answer = await vscode.window.showInformationMessage(
      'Logline is capturing this terminal command, so you can search its output in the Logs panel. It stays on this computer.',
      SHOW_LOGS,
      TURN_OFF,
    );
    if (answer === SHOW_LOGS) {
      record?.('accepted');
      this.options.showLogs();
    } else if (answer === TURN_OFF) {
      record?.('never');
      try {
        await this.options.turnOff();
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Logline could not turn off terminal capture: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else record?.('dismissed');
    return true;
  }
}
