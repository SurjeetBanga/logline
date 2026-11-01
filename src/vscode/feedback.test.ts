import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = {
  picks: [] as unknown[],
  inputs: [] as (string | undefined)[],
  answers: [] as (string | undefined)[],
  messages: [] as { message: string; detail?: string; items: string[] }[],
  opened: [] as string[],
};
const mock = {
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  env: { openExternal: async (uri: { toString(): string }) => void ui.opened.push(uri.toString()) },
  window: {
    showQuickPick: async () => ui.picks.shift(),
    showInputBox: async () => ui.inputs.shift(),
    showInformationMessage: async (message: string, ...rest: unknown[]) => {
      const options = typeof rest[0] === 'object' ? (rest.shift() as { detail?: string }) : {};
      ui.messages.push({ message, detail: options.detail, items: rest as string[] });
      return ui.answers.shift();
    },
  },
};
const feedback = withVscode(mock, () => require('./feedback') as typeof import('./feedback'));
const { suggestFeature, voteOnNext, FeedbackPrompt, SUGGEST_SURVEY, VOTE_SURVEY, VOTE_AFTER_MS, QUIET_MS } = feedback;

function reset() {
  Object.assign(ui, { picks: [], inputs: [], answers: [], messages: [], opened: [] });
}
function fakeUsage(enabled = true) {
  const surveys: { id: string; responses: Record<string, string | string[]> }[] = [];
  return {
    surveys,
    usage: {
      enabled,
      survey: async (id: string, responses: Record<string, string | string[]>) => {
        surveys.push({ id, responses });
        return enabled;
      },
    } as any,
  };
}

test('a suggestion is shown redacted before it is sent, and Cancel sends nothing', async () => {
  Object.assign(SUGGEST_SURVEY, { id: 'suggest', area: 'q-area', text: 'q-text' });
  reset();
  const { usage, surveys } = fakeUsage();
  const token = ['ghp', 'A'.repeat(36)].join('_');
  ui.picks.push('Search');
  ui.inputs.push(`Saved searches per project, token ${token}`);
  ui.answers.push('Send');
  await suggestFeature(usage);
  assert.doesNotMatch(ui.messages[0].detail!, new RegExp(token));
  assert.match(ui.messages[0].detail!, /^Search: Saved searches per project/);
  assert.deepEqual(surveys[0].id, 'suggest');
  assert.equal(surveys[0].responses['q-area'], 'Search');
  assert.doesNotMatch(String(surveys[0].responses['q-text']), new RegExp(token));

  reset();
  ui.picks.push('Search');
  ui.inputs.push('Something');
  ui.answers.push(undefined);
  await suggestFeature(usage);
  assert.equal(surveys.length, 1);
  assert.deepEqual(ui.opened, []);

  reset();
  ui.picks.push(undefined);
  await suggestFeature(usage);
  assert.equal(ui.messages.length, 0, 'no area, no question');
});

test('with usage counts off, a suggestion or a vote goes to a GitHub issue instead', async () => {
  Object.assign(SUGGEST_SURVEY, { id: 'suggest', area: 'q-area', text: 'q-text' });
  Object.assign(VOTE_SURVEY, { id: 'vote', choice: 'q-choice' });
  reset();
  const { usage, surveys } = fakeUsage(false);
  ui.picks.push('Agents');
  ui.inputs.push('Let Codex wait for new logs');
  ui.answers.push('Open GitHub Issue Instead');
  await suggestFeature(usage);
  assert.deepEqual(ui.messages[0].items, ['Open GitHub Issue Instead']);
  assert.match(ui.opened[0], /issues\/new\?labels=enhancement&title=Suggestion/);
  assert.match(decodeURIComponent(ui.opened[0]), /Area: Agents\n\nLet Codex wait for new logs/);

  reset();
  ui.picks.push(['Deeper agent investigations']);
  ui.answers.push('Open GitHub Issue');
  await voteOnNext(usage);
  assert.match(decodeURIComponent(ui.opened[0]), /- Deeper agent investigations/);
  assert.equal(surveys.length, 0);
});

test('a vote is sent as one answer with every pick', async () => {
  Object.assign(VOTE_SURVEY, { id: 'vote', choice: 'q-choice' });
  reset();
  const { usage, surveys } = fakeUsage();
  ui.picks.push(['Saved panel layouts and views', 'More log stores and services']);
  await voteOnNext(usage);
  assert.deepEqual(surveys, [
    { id: 'vote', responses: { 'q-choice': ['Saved panel layouts and views', 'More log stores and services'] } },
  ]);
  assert.match(ui.messages[0].message, /vote was counted/);
  reset();
  ui.picks.push([]);
  await voteOnNext(usage);
  assert.equal(surveys.length, 1, 'no picks, no vote');
});

test('the vote question waits for two weeks of use, asks once, and keeps a month from the rating question', async () => {
  reset();
  const stored = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
  let now = 10 * VOTE_AFTER_MS;
  const prompt = new FeedbackPrompt(
    memento,
    undefined,
    () => true,
    () => now,
  );
  assert.equal(await prompt.check(), false, 'not before Logline was used');
  stored.set('logline.rating', { firstUsed: now - VOTE_AFTER_MS + 1 });
  assert.equal(await prompt.check(), false, 'not in the first two weeks');
  stored.set('logline.rating', { firstUsed: now - VOTE_AFTER_MS, asked: now - QUIET_MS + 1 });
  assert.equal(await prompt.check(), false, 'not within a month of the rating question');
  now += 1;
  ui.answers.push('Not now');
  assert.equal(await prompt.check(), true);
  assert.match(ui.messages[0].message, /What should Logline do next/);
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
