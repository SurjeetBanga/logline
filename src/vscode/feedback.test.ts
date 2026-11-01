import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = {
  answers: [] as (string | undefined)[],
  messages: [] as string[],
  opened: [] as string[],
};
const mock = {
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  env: { openExternal: async (uri: { toString(): string }) => void ui.opened.push(uri.toString()) },
  window: {
    showInformationMessage: async (message: string) => {
      ui.messages.push(message);
      return ui.answers.shift();
    },
  },
};
const feedback = withVscode(mock, () => require('./feedback') as typeof import('./feedback'));
const { sendFeedback, feedbackSendable, FeedbackPrompt, SUGGEST_SURVEY, VOTE_SURVEY, VOTE_AFTER_MS, QUIET_MS } =
  feedback;

function reset() {
  Object.assign(ui, { answers: [], messages: [], opened: [] });
}
/** Usage counts that are on or off, and whose answers PostHog accepts or not. */
function fakeUsage(enabled = true, accepted = true) {
  const surveys: { id: string; responses: Record<string, string | string[]> }[] = [];
  return {
    surveys,
    usage: {
      enabled,
      survey: async (id: string, responses: Record<string, string | string[]>) => {
        surveys.push({ id, responses });
        return accepted;
      },
    } as any,
  };
}

test('a suggestion from the panel is redacted again before it is sent, with its area', async () => {
  reset();
  const { usage, surveys } = fakeUsage();
  const token = ['ghp', 'A'.repeat(36)].join('_');
  assert.deepEqual(
    await sendFeedback(usage, {
      mode: 'suggest',
      area: 'Search',
      text: `  Saved searches per project, token ${token} `,
    }),
    { ok: true, via: 'posthog' },
  );
  assert.equal(surveys[0].id, SUGGEST_SURVEY.id);
  assert.equal(surveys[0].responses[SUGGEST_SURVEY.area], 'Search');
  assert.match(String(surveys[0].responses[SUGGEST_SURVEY.text]), /^Saved searches per project, token \[REDACTED\]$/);
  assert.deepEqual(ui.opened, []);

  // An area the form did not offer is filed as Something else; an empty suggestion is not sent.
  await sendFeedback(usage, { mode: 'suggest', area: 'Billing', text: 'More colors' });
  assert.equal(surveys[1].responses[SUGGEST_SURVEY.area], 'Something else');
  assert.deepEqual(await sendFeedback(usage, { mode: 'suggest', area: 'Search', text: '   ' }), {
    ok: false,
    via: 'posthog',
  });
  assert.equal(surveys.length, 2);
});

test('a vote is sent as one answer with only the choices the vote offers', async () => {
  reset();
  const { usage, surveys } = fakeUsage();
  assert.deepEqual(
    await sendFeedback(usage, {
      mode: 'vote',
      picks: ['Saved panel layouts and views', 'Free pizza', 'More log stores and services'],
    }),
    { ok: true, via: 'posthog' },
  );
  assert.deepEqual(surveys, [
    {
      id: VOTE_SURVEY.id,
      responses: { [VOTE_SURVEY.choice]: ['Saved panel layouts and views', 'More log stores and services'] },
    },
  ]);
  assert.deepEqual(await sendFeedback(usage, { mode: 'vote', picks: ['Free pizza'] }), { ok: false, via: 'posthog' });
});

test('with usage counts off, or when asked, feedback opens a GitHub issue and sends nothing', async () => {
  reset();
  const off = fakeUsage(false);
  assert.equal(feedbackSendable(off.usage), false);
  assert.deepEqual(
    await sendFeedback(off.usage, { mode: 'suggest', area: 'Agents', text: 'Let Codex wait for logs' }),
    {
      ok: true,
      via: 'github',
    },
  );
  assert.match(ui.opened[0], /issues\/new\?labels=enhancement&title=Suggestion/);
  assert.match(decodeURIComponent(ui.opened[0]), /Area: Agents\n\nLet Codex wait for logs/);
  await sendFeedback(off.usage, { mode: 'vote', picks: ['Deeper agent investigations'] });
  assert.match(decodeURIComponent(ui.opened[1]), /- Deeper agent investigations/);
  assert.deepEqual(off.surveys, []);

  const on = fakeUsage();
  assert.equal(feedbackSendable(on.usage), true);
  await sendFeedback(on.usage, { mode: 'vote', picks: ['Deeper agent investigations'], github: true });
  assert.equal(ui.opened.length, 3);
  assert.deepEqual(on.surveys, [], 'a GitHub issue was asked for, so nothing goes to PostHog');
});

test('answers PostHog does not accept are reported as not sent', async () => {
  reset();
  const { usage } = fakeUsage(true, false);
  assert.deepEqual(await sendFeedback(usage, { mode: 'vote', picks: ['Deeper agent investigations'] }), {
    ok: false,
    via: 'posthog',
  });
  assert.deepEqual(ui.opened, [], 'the form offers a GitHub issue; nothing opens on its own');
});

test('the vote question waits for two weeks of use, asks once, keeps a month from the rating question, and opens the vote', async () => {
  reset();
  const stored = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
  let now = 10 * VOTE_AFTER_MS;
  let opened = 0;
  const prompt = new FeedbackPrompt(
    memento,
    () => opened++,
    () => true,
    () => now,
  );
  assert.equal(await prompt.check(), false, 'not before Logline was used');
  stored.set('logline.rating', { firstUsed: now - VOTE_AFTER_MS + 1 });
  assert.equal(await prompt.check(), false, 'not in the first two weeks');
  stored.set('logline.rating', { firstUsed: now - VOTE_AFTER_MS, asked: now - QUIET_MS + 1 });
  assert.equal(await prompt.check(), false, 'not within a month of the rating question');
  now += 1;
  ui.answers.push('Vote');
  assert.equal(await prompt.check(), true);
  assert.match(ui.messages[0], /What should Logline do next/);
  assert.equal(opened, 1, 'Vote opens the vote in the Logs panel');
  assert.equal(await prompt.check(), false, 'once');
  prompt.start();
  prompt.dispose();
});

test('the rating question keeps a month from the vote question', async () => {
  const rating = withVscode(
    { window: { showInformationMessage: async () => undefined }, env: {}, Uri: { parse: (value: string) => value } },
    () => require('./rating-prompt') as typeof import('./rating-prompt'),
  );
  const now = 100 * QUIET_MS;
  const stored = new Map<string, unknown>([
    ['logline.rating', { firstUsed: 0, sessions: 5 }],
    ['logline.feedbackPrompt', { asked: now - 1 }],
  ]);
  const memento = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
  const prompt = new rating.RatingPrompt(
    memento,
    () => true,
    () => now,
  );
  assert.equal(await prompt.check(), false);
  stored.set('logline.feedbackPrompt', { asked: now - QUIET_MS });
  assert.equal(await prompt.check(), true);
});
