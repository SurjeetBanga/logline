import * as vscode from 'vscode';
import { looksLikeDevServer } from '../capture/dev-command';
import type { NudgeStep } from '../core/usage-events';
import { OfferMemory } from './offer-memory';

/** Set once this workspace was asked. */
export const CAPTURE_OFFER_WORKSPACE_KEY = 'logline.captureOffer.asked';
/** How many workspaces were asked, and whether to stop asking. */
export const CAPTURE_OFFER_KEY = 'logline.captureOffer';
/** Asked in this many workspaces without a yes, Logline stops asking. */
export const CAPTURE_OFFER_LIMIT = 3;

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
  private readonly memory: OfferMemory;

  constructor(private readonly options: CaptureOfferOptions) {
    this.memory = new OfferMemory(
      options.workspace,
      options.global,
      CAPTURE_OFFER_KEY,
      CAPTURE_OFFER_WORKSPACE_KEY,
      CAPTURE_OFFER_LIMIT,
    );
  }

  /** A command started in a terminal that is not captured; returns whether it asked. */
  async commandStarted(commandLine: string): Promise<boolean> {
    const { record } = this.options;
    const { memory } = this;
    if (this.asking || this.unsaved || !looksLikeDevServer(commandLine) || !memory.allowed()) return false;
    this.asking = true;
    try {
      await memory.askedHere();
      await memory.counted();
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
        await memory.askedHere(false);
        void vscode.window.showErrorMessage(
          `Logline could not turn on terminal capture: ${error instanceof Error ? error.message : String(error)}`,
        );
        return true;
      }
      record?.('accepted');
      if (saved !== false) await memory.done();
      else {
        // A yes that lasts only as long as this window is not the last word, and does not count towards
        // the limit: this window may ask again once that capture is gone, and so may another workspace.
        this.unsaved = true;
        await memory.askedHere(false);
        await memory.uncounted();
      }
      return true;
    } finally {
      this.asking = false;
    }
  }
}
