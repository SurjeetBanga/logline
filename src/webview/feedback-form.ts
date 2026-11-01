import {
  FEEDBACK_AREAS,
  FEEDBACK_TEXT_LIMIT,
  ROADMAP,
  type FeedbackOpen,
  type FeedbackRequest,
  type FeedbackResult,
} from '../core/feedback';
import { redactText } from '../core/redaction';
import type { EventScope } from './event-scope';
import type { WebviewApi } from './types';

export interface FeedbackElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  cancel: HTMLButtonElement;
  suggestTab: HTMLButtonElement;
  voteTab: HTMLButtonElement;
  suggest: HTMLElement;
  vote: HTMLElement;
  area: HTMLSelectElement;
  text: HTMLTextAreaElement;
  count: HTMLElement;
  preview: HTMLElement;
  choices: HTMLElement;
  note: HTMLElement;
  status: HTMLElement;
  send: HTMLButtonElement;
  github: HTMLButtonElement;
}

/**
 * Suggest a feature and Vote on what's next, as a dialog in the Logs panel. A
 * suggestion is shown as it will be sent, redacted like an export; the editor
 * redacts it again before it leaves. With usage counts off it opens a GitHub issue.
 */
export function createFeedbackForm(elements: FeedbackElements, api: WebviewApi, scope: EventScope) {
  let mode: FeedbackOpen['mode'] = 'suggest';
  let sendable = true;
  let state: 'editing' | 'sending' | 'done' = 'editing';
  const checks: HTMLInputElement[] = [];

  for (const area of FEEDBACK_AREAS) {
    const option = document.createElement('option');
    option.value = area;
    option.textContent = area;
    elements.area.append(option);
  }
  for (const [index, choice] of ROADMAP.entries()) {
    const label = document.createElement('label');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.value = choice;
    check.id = `feedbackChoice${index}`;
    const text = document.createElement('span');
    text.textContent = choice;
    label.append(check, text);
    elements.choices.append(label);
    checks.push(check);
    scope.listen(check, 'change', () => update());
  }

  function show(next: FeedbackOpen['mode']): void {
    mode = next;
    elements.suggest.hidden = mode !== 'suggest';
    elements.vote.hidden = mode !== 'vote';
    elements.suggestTab.setAttribute('aria-selected', String(mode === 'suggest'));
    elements.voteTab.setAttribute('aria-selected', String(mode === 'vote'));
    update();
  }

  function request(github: boolean): FeedbackRequest | undefined {
    if (mode === 'suggest') {
      const text = elements.text.value.trim();
      return text ? { mode, area: elements.area.value, text, github } : undefined;
    }
    const picks = checks.filter((check) => check.checked).map((check) => check.value);
    return picks.length ? { mode, picks, github } : undefined;
  }

  function update(): void {
    const text = elements.text.value.trim();
    elements.count.textContent = `${elements.text.value.length} / ${FEEDBACK_TEXT_LIMIT}`;
    // Show what will be sent when redaction changed it.
    const redacted = text ? redactText(text) : '';
    elements.preview.hidden = redacted === text;
    elements.preview.textContent = redacted === text ? '' : `Sent as: ${redacted}`;
    const ready = request(false) !== undefined && state !== 'sending';
    elements.send.disabled = !ready || state === 'done';
    elements.github.disabled = !ready || state === 'done';
    elements.send.hidden = state === 'done';
    elements.github.hidden = state === 'done' || !sendable;
    elements.send.textContent = sendable ? 'Send' : 'Open GitHub issue';
    elements.cancel.textContent = state === 'done' ? 'Close' : 'Cancel';
    elements.note.textContent = sendable
      ? 'Sent anonymously to the Logline developers, with your other usage counts.'
      : 'Usage counts are off, so this opens a GitHub issue with it instead.';
  }

  function submit(github: boolean): void {
    const body = request(github || !sendable);
    if (!body || state !== 'editing') return;
    state = 'sending';
    elements.status.textContent = body.github ? 'Opening a GitHub issue…' : 'Sending…';
    update();
    api.postMessage({ type: 'feedbackSend', ...body });
  }

  function open(request: FeedbackOpen): void {
    sendable = request.sendable;
    state = 'editing';
    elements.text.value = '';
    for (const check of checks) check.checked = false;
    elements.status.textContent = '';
    show(request.mode);
    if (!elements.dialog.open) elements.dialog.showModal();
    (mode === 'suggest' ? elements.text : checks[0])?.focus?.();
  }

  /** How sending went, from the editor. */
  function receive(result: FeedbackResult): void {
    if (state !== 'sending') return;
    if (result.ok) {
      state = 'done';
      elements.status.textContent =
        result.via === 'github'
          ? 'Opened a GitHub issue in your browser. Thanks!'
          : mode === 'suggest'
            ? 'Thanks, your suggestion was sent.'
            : 'Thanks, your vote was counted.';
    } else {
      // Not delivered: keep what was written, and offer a GitHub issue.
      state = 'editing';
      sendable = false;
      elements.status.textContent = "Logline couldn't send it. You can open a GitHub issue with it instead.";
    }
    update();
  }

  scope.listen(elements.suggestTab, 'click', () => show('suggest'));
  scope.listen(elements.voteTab, 'click', () => show('vote'));
  scope.listen(elements.text, 'input', () => update());
  scope.listen(elements.cancel, 'click', () => elements.dialog.close());
  scope.listen(elements.github, 'click', () => submit(true));
  scope.listen(elements.form, 'submit', (event) => {
    event.preventDefault();
    submit(false);
  });

  return { open, receive };
}
