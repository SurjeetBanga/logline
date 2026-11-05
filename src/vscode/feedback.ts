import * as vscode from 'vscode';
import { FEEDBACK_AREAS, ROADMAP, type FeedbackRequest, type FeedbackResult, scrubFeedback } from '../core/feedback';
import type { Usage } from './usage';

// PostHog surveys of type API: PostHog shows nothing, the Logs panel's form asks and
// Logline sends the answers. The ids come from each survey's Overview tab; with none,
// answers go to a GitHub issue instead.
export const SUGGEST_SURVEY = {
  id: '01a19806-2611-0000-b93c-6ea0d136281a',
  area: '1f1556d3-4391-4214-9ecb-2bd205d437d9',
  text: '8856546f-fbff-4cc7-9527-3f6fd55b4337',
};
export const VOTE_SURVEY = {
  id: '01a19806-2752-0000-c584-cf423c8e6a9b',
  choice: 'e24a742a-6a67-4141-bd04-7ffef3d60a7c',
};
const ISSUES_URL = 'https://github.com/SurjeetBanga/logline/issues/new';

export const FEEDBACK_PROMPT_KEY = 'logline.feedbackPrompt';
const PROMPT_KEY = FEEDBACK_PROMPT_KEY;
const RATING_KEY = 'logline.rating';
const DAY = 24 * 60 * 60 * 1000;
/** Ask once, after two weeks of use, and never within a month of the rating question. */
export const VOTE_AFTER_MS = 14 * DAY;
export const QUIET_MS = 30 * DAY;
export const VOTE_DELAY_MS = 15 * 60 * 1000;

function issueUrl(title: string, body: string): string {
  return `${ISSUES_URL}?labels=enhancement&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** Whether answers can go to the developers: usage counts are on and the surveys exist. */
export function feedbackSendable(usage: Usage | undefined): boolean {
  return !!usage?.enabled && !!SUGGEST_SURVEY.id && !!VOTE_SURVEY.id;
}

/**
 * Send what the Logs panel's form submitted: to the developers as survey answers, or
 * as a GitHub issue when asked, when usage counts are off, or never in a form Logline
 * did not offer. A suggestion is scrubbed here too, whatever the form showed.
 */
export async function sendFeedback(usage: Usage | undefined, request: FeedbackRequest): Promise<FeedbackResult> {
  const github = request.github === true || !feedbackSendable(usage);
  if (request.mode === 'suggest') {
    const area = (FEEDBACK_AREAS as readonly string[]).includes(request.area) ? request.area : 'Something else';
    const text = scrubFeedback(request.text);
    if (!text) return { ok: false, via: github ? 'github' : 'posthog' };
    if (!github)
      return {
        ok: await usage!.survey(SUGGEST_SURVEY.id, { [SUGGEST_SURVEY.area]: area, [SUGGEST_SURVEY.text]: text }),
        via: 'posthog',
      };
    await vscode.env.openExternal(
      vscode.Uri.parse(issueUrl(`Suggestion: ${text.slice(0, 60)}`, `Area: ${area}\n\n${text}`)),
    );
    return { ok: true, via: 'github' };
  }
  const picks = request.picks.filter((pick) => (ROADMAP as readonly string[]).includes(pick));
  if (!picks.length) return { ok: false, via: github ? 'github' : 'posthog' };
  if (!github) return { ok: await usage!.survey(VOTE_SURVEY.id, { [VOTE_SURVEY.choice]: picks }), via: 'posthog' };
  await vscode.env.openExternal(
    vscode.Uri.parse(issueUrl('What should Logline do next?', picks.map((item) => `- ${item}`).join('\n'))),
  );
  return { ok: true, via: 'github' };
}

interface PromptState {
  /** When it asked. */
  asked?: number;
}

/**
 * Asks once, after two weeks of use, what Logline should do next. Never in a
 * session that has not used Logline, and never within a month of the rating question.
 */
export class FeedbackPrompt implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly memento: Pick<vscode.Memento, 'get' | 'update'>,
    /** Open the vote in the Logs panel. */
    private readonly openVote: () => unknown,
    /** Whether this session has captured any logs yet. */
    private readonly used: () => boolean,
    private readonly now: () => number = Date.now,
    /** Told what the answer was, for usage counts. */
    private readonly answered?: (answer: 'accepted' | 'later' | 'dismissed') => void,
  ) {}

  start(): void {
    if (this.memento.get<PromptState>(PROMPT_KEY)?.asked !== undefined) return;
    this.timer = setTimeout(() => void this.check(), VOTE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Ask now if it is time; returns whether it asked. */
  async check(): Promise<boolean> {
    if (this.memento.get<PromptState>(PROMPT_KEY)?.asked !== undefined || !this.used()) return false;
    // The rating prompt remembers when Logline was first used, and when it last asked.
    const rating = this.memento.get<{ firstUsed?: number; asked?: number }>(RATING_KEY) ?? {};
    const now = this.now();
    if (rating.firstUsed === undefined || now - rating.firstUsed < VOTE_AFTER_MS) return false;
    if (rating.asked !== undefined && now - rating.asked < QUIET_MS) return false;
    await Promise.resolve(this.memento.update(PROMPT_KEY, { asked: now })).catch(() => undefined);
    const VOTE = 'Vote';
    const answer = await vscode.window.showInformationMessage(
      'What should Logline do next? Pick what would help you most.',
      VOTE,
      'Not now',
    );
    this.answered?.(answer === VOTE ? 'accepted' : answer ? 'later' : 'dismissed');
    if (answer === VOTE) await this.openVote();
    return true;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
