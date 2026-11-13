import * as vscode from 'vscode';
import { looksLikeDevServer } from '../capture/dev-command';
import type { NudgeStep } from '../core/usage-events';

/** Set once this workspace was asked. */
export const CAPTURE_OFFER_WORKSPACE_KEY = 'logline.captureOffer.asked';
/** How many workspaces were asked, and whether to stop asking. */
export const CAPTURE_OFFER_KEY = 'logline.captureOffer';
/** Asked in this many workspaces without a yes, Logline stops asking. */
export const CAPTURE_OFFER_LIMIT = 3;

interface OfferState {
  asked?: number;
  done?: boolean;
}

export interface CaptureOfferOptions {
  workspace: Pick<vscode.Memento, 'get' | 'update'>;
  global: Pick<vscode.Memento, 'get' | 'update'>;
  /** Turn terminal capture on, for this workspace or for every one; false when the choice could not be saved. */
  enable: (everywhere: boolean) => Promise<boolean | void>;
  record?: (step: NudgeStep) => void;
}

const HERE = 'Capture in This Workspace';
const EVERYWHERE = 'Capture Everywhere';
const NOT_NOW = 'Not Now';

/**
 * Offers terminal capture when a dev server starts in a terminal with capture
 * off: once per workspace, and in a few workspaces at most.
 */
export class CaptureOffer {
  private asking = false;

  constructor(private readonly options: CaptureOfferOptions) {}

  /** A command started in a terminal that is not captured; returns whether it asked. */
  async commandStarted(commandLine: string): Promise<boolean> {
    const { workspace, global, record } = this.options;
    if (this.asking || !looksLikeDevServer(commandLine)) return false;
    const state = global.get<OfferState>(CAPTURE_OFFER_KEY) ?? {};
    if (state.done || (state.asked ?? 0) >= CAPTURE_OFFER_LIMIT || workspace.get<boolean>(CAPTURE_OFFER_WORKSPACE_KEY))
      return false;
    this.asking = true;
    try {
      const save = (next: OfferState) => Promise.resolve(global.update(CAPTURE_OFFER_KEY, next)).catch(() => undefined);
      await Promise.resolve(workspace.update(CAPTURE_OFFER_WORKSPACE_KEY, true)).catch(() => undefined);
      await save({ ...state, asked: (state.asked ?? 0) + 1 });
      record?.('shown');
      const answer = await vscode.window.showInformationMessage(
        'Capture terminal output in Logline, so you can search it and share it with your agent? It starts with the next command you run; this one is not captured.',
        HERE,
        EVERYWHERE,
        NOT_NOW,
      );
      if (answer === HERE || answer === EVERYWHERE) {
        record?.('accepted');
        let saved: boolean | void = false;
        try {
          saved = await this.options.enable(answer === EVERYWHERE);
        } catch (error) {
          // A yes that could not be turned on is said, and this workspace may be asked again.
          await Promise.resolve(workspace.update(CAPTURE_OFFER_WORKSPACE_KEY, undefined)).catch(() => undefined);
          void vscode.window.showErrorMessage(
            `Logline could not turn on terminal capture: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Other windows may have asked, or been answered, while this one waited.
        const latest = global.get<OfferState>(CAPTURE_OFFER_KEY) ?? {};
        if (saved !== false) await save({ ...latest, done: true });
        // A yes that was not saved is not the last word, and does not count towards the limit: another workspace may ask.
        else await save({ ...latest, asked: Math.max(0, (latest.asked ?? 1) - 1) });
      } else record?.('dismissed');
      return true;
    } finally {
      this.asking = false;
    }
  }
}
