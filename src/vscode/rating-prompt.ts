import * as vscode from 'vscode';

const RATING_KEY = 'logline.rating';
const DAY = 24 * 60 * 60 * 1000;
/** Ask only after someone has used Logline for a few days, over a few sessions. */
export const RATING_AFTER_MS = 3 * DAY;
export const RATING_MIN_SESSIONS = 3;
/** "Not now" asks once more, this much later; then never again. */
export const RATING_SNOOZE_MS = 14 * DAY;
/** How long into a session that captured logs the question comes, so it never interrupts a start. */
export const RATING_DELAY_MS = 10 * 60 * 1000;

interface RatingState {
  /** When Logline first had captured logs in a session. */
  firstUsed?: number;
  sessions?: number;
  /** When it last asked, and how many times. */
  asked?: number;
  times?: number;
  /** Rated, or asked not to be asked. */
  done?: boolean;
}

const RATE = 'Rate Logline';
const LATER = 'Not now';
const NEVER = "Don't ask again";

/**
 * Asks, at most twice, for a rating from someone who has used Logline for a
 * while: the reviews page of the store the editor installs from.
 */
export class RatingPrompt implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly memento: Pick<vscode.Memento, 'get' | 'update'>,
    /** Whether this session has captured any logs yet. */
    private readonly used: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  private get state(): RatingState {
    return this.memento.get<RatingState>(RATING_KEY) ?? {};
  }

  private save(state: RatingState): Promise<void> {
    return Promise.resolve(this.memento.update(RATING_KEY, state)).catch(() => undefined);
  }

  /** Count this session, and look again a while into it. */
  start(): void {
    const state = this.state;
    if (state.done) return;
    void this.save({ ...state, sessions: (state.sessions ?? 0) + 1 });
    this.timer = setTimeout(() => void this.check(), RATING_DELAY_MS);
    this.timer.unref?.();
  }

  /** Ask now if it is time; returns whether it asked. */
  async check(): Promise<boolean> {
    let state = this.state;
    if (state.done) return false;
    if (this.used() && state.firstUsed === undefined) {
      state = { ...state, firstUsed: this.now() };
      await this.save(state);
    }
    const now = this.now();
    const due =
      state.firstUsed !== undefined &&
      now - state.firstUsed >= RATING_AFTER_MS &&
      (state.sessions ?? 0) >= RATING_MIN_SESSIONS &&
      (state.times ?? 0) < 2 &&
      (state.asked === undefined || now - state.asked >= RATING_SNOOZE_MS);
    if (!due || !this.used()) return false;
    await this.save({ ...state, asked: now, times: (state.times ?? 0) + 1 });
    const answer = await vscode.window.showInformationMessage(
      'Is Logline helping you debug? A rating helps other developers find it.',
      RATE,
      LATER,
      NEVER,
    );
    if (answer === RATE) await vscode.env.openExternal(vscode.Uri.parse(reviewsUrl(vscode.env.appName)));
    if (answer === RATE || answer === NEVER) await this.save({ ...this.state, done: true });
    return true;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** The reviews page of the store this editor installs extensions from. */
export function reviewsUrl(appName: string | undefined): string {
  return /visual studio code/i.test(appName ?? '')
    ? 'https://marketplace.visualstudio.com/items?itemName=surjeetbanga.logline&ssr=false#review-details'
    : 'https://open-vsx.org/extension/surjeetbanga/logline/reviews';
}
