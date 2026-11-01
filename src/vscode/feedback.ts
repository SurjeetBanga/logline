import * as vscode from 'vscode';
import { redactText } from '../core/redaction';
import { SURVEY_TEXT_LIMIT, type Usage } from './usage';

// PostHog surveys of type API: PostHog shows nothing, Logline asks and sends the
// answers. The ids come from each survey's Overview tab; with none, answers go
// to a GitHub issue instead.
export const SUGGEST_SURVEY = {
  id: '01a19806-2611-0000-b93c-6ea0d136281a',
  area: '1f1556d3-4391-4214-9ecb-2bd205d437d9',
  text: '8856546f-fbff-4cc7-9527-3f6fd55b4337',
};
export const VOTE_SURVEY = {
  id: '01a19806-2752-0000-c584-cf423c8e6a9b',
  choice: 'e24a742a-6a67-4141-bd04-7ffef3d60a7c',
};
/** What could come next, as the vote offers it. Keep in step with the survey's choices. */
export const ROADMAP = [
  'More log stores and services',
  'Alerts when a log pattern appears',
  'Share a captured session with a teammate',
  'Saved panel layouts and views',
  'Deeper agent investigations',
];
export const AREAS = ['Capture', 'Search', 'Views', 'Connections', 'Agents', 'Something else'];
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

/** Ask what Logline should do, send it to PostHog, or open a GitHub issue with it when usage counts are off. */
export async function suggestFeature(usage: Usage | undefined): Promise<void> {
  const area = await vscode.window.showQuickPick(AREAS, {
    title: 'Suggest a feature (1/2)',
    placeHolder: 'What is it about?',
  });
  if (!area) return;
  const text = await vscode.window.showInputBox({
    title: 'Suggest a feature (2/2)',
    prompt: "What should Logline do? Don't paste logs or secrets.",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.length > SURVEY_TEXT_LIMIT ? `Keep it under ${SURVEY_TEXT_LIMIT} characters.` : undefined,
  });
  if (!text?.trim()) return;
  const redacted = redactText(text.trim());
  const sendable = !!usage?.enabled && !!SUGGEST_SURVEY.id;
  const SEND = 'Send';
  const GITHUB = 'Open GitHub Issue Instead';
  const answer = await vscode.window.showInformationMessage(
    sendable ? 'Send this suggestion to the Logline developers?' : 'Open a GitHub issue with this suggestion?',
    { modal: true, detail: `${area}: ${redacted}` },
    ...(sendable ? [SEND, GITHUB] : [GITHUB]),
  );
  if (answer === SEND && usage) {
    if (await usage.survey(SUGGEST_SURVEY.id, { [SUGGEST_SURVEY.area]: area, [SUGGEST_SURVEY.text]: redacted })) {
      void vscode.window.showInformationMessage('Logline: Thanks, your suggestion was sent.');
      return;
    }
  }
  if (answer === SEND || answer === GITHUB)
    await vscode.env.openExternal(
      vscode.Uri.parse(issueUrl(`Suggestion: ${redacted.slice(0, 60)}`, `Area: ${area}\n\n${redacted}`)),
    );
}

/** Pick what should come next, from the roadmap. */
export async function voteOnNext(usage: Usage | undefined): Promise<void> {
  const picked = await vscode.window.showQuickPick(ROADMAP, {
    title: 'What should Logline do next?',
    placeHolder: 'Pick any that would help you',
    canPickMany: true,
  });
  if (!picked?.length) return;
  if (usage?.enabled && VOTE_SURVEY.id && (await usage.survey(VOTE_SURVEY.id, { [VOTE_SURVEY.choice]: picked }))) {
    void vscode.window.showInformationMessage('Logline: Thanks, your vote was counted.');
    return;
  }
  const answer = await vscode.window.showInformationMessage(
    'Usage counts are off, so votes cannot be sent. Open a GitHub issue with your picks?',
    'Open GitHub Issue',
  );
  if (answer)
    await vscode.env.openExternal(
      vscode.Uri.parse(issueUrl('What should Logline do next?', picked.map((item) => `- ${item}`).join('\n'))),
    );
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
    private readonly usage: Usage | undefined,
    /** Whether this session has captured any logs yet. */
    private readonly used: () => boolean,
    private readonly now: () => number = Date.now,
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
    if (answer === VOTE) await voteOnNext(this.usage);
    return true;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
