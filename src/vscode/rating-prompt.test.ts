import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = { asked: 0, answer: undefined as string | undefined, opened: [] as string[], appName: 'Visual Studio Code' };
const mock = {
  window: {
    showInformationMessage: async () => {
      ui.asked++;
      return ui.answer;
    },
  },
  env: {
    get appName() {
      return ui.appName;
    },
    openExternal: async (uri: { toString(): string }) => void ui.opened.push(uri.toString()),
  },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
};
const { RatingPrompt, RATING_AFTER_MS, RATING_SNOOZE_MS, reviewsUrl } = withVscode(
  mock,
  () => require('./rating-prompt') as typeof import('./rating-prompt'),
);

function setup(used = true) {
  const stored = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
  let now = 1_000_000;
  const prompt = new RatingPrompt(
    memento,
    () => used,
    () => now,
  );
  return { prompt, advance: (ms: number) => (now += ms), stored };
}

test('the rating question waits for days of use over a few sessions, then asks once more at most', async () => {
  Object.assign(ui, { asked: 0, answer: undefined, opened: [] });
  const { prompt, advance } = setup();
  prompt.start();
  prompt.dispose();
  assert.equal(await prompt.check(), false, 'not on the first day');
  advance(RATING_AFTER_MS);
  assert.equal(await prompt.check(), false, 'not before the third session');
  prompt.start();
  prompt.start();
  prompt.dispose();
  assert.equal(await prompt.check(), true);
  assert.equal(await prompt.check(), false, 'Not now waits two weeks');
  advance(RATING_SNOOZE_MS);
  assert.equal(await prompt.check(), true);
  advance(RATING_SNOOZE_MS);
  assert.equal(await prompt.check(), false, 'and never asks a third time');
  assert.equal(ui.asked, 2);
});

test('rating opens the store the editor installs from; either answer but Not now ends the questions', async () => {
  Object.assign(ui, { asked: 0, answer: 'Rate Logline', opened: [] });
  const { prompt, advance } = setup();
  for (let i = 0; i < 3; i++) prompt.start();
  prompt.dispose();
  await prompt.check();
  advance(RATING_AFTER_MS);
  assert.equal(await prompt.check(), true);
  assert.match(ui.opened[0], /marketplace\.visualstudio\.com.*surjeetbanga\.logline/);
  advance(RATING_SNOOZE_MS);
  assert.equal(await prompt.check(), false, 'someone who rated is not asked again');
  assert.match(reviewsUrl('Cursor'), /open-vsx\.org\/extension\/surjeetbanga\/logline/);
  // A session that captured nothing is never asked, however long it has been installed.
  const idle = setup(false);
  for (let i = 0; i < 3; i++) idle.prompt.start();
  idle.prompt.dispose();
  idle.advance(RATING_AFTER_MS * 10);
  assert.equal(await idle.prompt.check(), false);
});
