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
  /** A yes this window could not save: it is not asked again until its next session. */
  private unsaved = false;

  constructor(private readonly options: CaptureOfferOptions) {}

  /** A command started in a terminal that is not captured; returns whether it asked. */
  async commandStarted(commandLine: string): Promise<boolean> {
    const { workspace, global, record } = this.options;
    if (this.asking || this.unsaved || !looksLikeDevServer(commandLine)) return false;
    const state = global.get<OfferState>(CAPTURE_OFFER_KEY) ?? {};
    if (state.done || (state.asked ?? 0) >= CAPTURE_OFFER_LIMIT || workspace.get<boolean>(CAPTURE_OFFER_WORKSPACE_KEY))
      return false;
    this.asking = true;
    try {
      // What cannot be remembered is asked again; that is no reason to fail.
      const put = (memento: CaptureOfferOptions['global'], key: string, value: unknown) =>
        Promise.resolve(memento.update(key, value)).catch(() => undefined);
      const save = (next: OfferState) => put(global, CAPTURE_OFFER_KEY, next);
      await put(workspace, CAPTURE_OFFER_WORKSPACE_KEY, true);
      await save({ ...state, asked: (state.asked ?? 0) + 1 });
      record?.('shown');
      const answer = await vscode.window.showInformationMessage(
        'Capture terminal output in Logline, so you can search it and share it with your agent? It starts with the next command you run; this one is not captured.',
        HERE,
        EVERYWHERE,
        NOT_NOW,
      );
      if (answer !== HERE && answer !== EVERYWHERE) {
        record?.('dismissed');
        return true;
      }
      let saved: boolean | void;
      try {
        saved = await this.options.enable(answer === EVERYWHERE);
      } catch (error) {
        // A yes that could not be turned on is said, and asked again in a later session. It still counts
        // towards the limit, so settings that never can be written do not make this ask for ever.
        this.unsaved = true;
        await put(workspace, CAPTURE_OFFER_WORKSPACE_KEY, undefined);
        void vscode.window.showErrorMessage(
          `Logline could not turn on terminal capture: ${error instanceof Error ? error.message : String(error)}`,
        );
        return true;
      }
      record?.('accepted');
      // Other windows may have asked, or been answered, while this one waited.
      const latest = global.get<OfferState>(CAPTURE_OFFER_KEY) ?? {};
      if (saved !== false) await save({ ...latest, done: true });
      else {
        // A yes that lasts only as long as this window is not the last word, and does not count towards
        // the limit: this window may ask again once that capture is gone, and so may another workspace.
        this.unsaved = true;
        await put(workspace, CAPTURE_OFFER_WORKSPACE_KEY, undefined);
        await save({ ...latest, asked: Math.max(0, (latest.asked ?? 1) - 1) });
      }
      return true;
    } finally {
      this.asking = false;
    }
  }
}
