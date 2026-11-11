import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = { asked: [] as string[], answer: undefined as string | undefined | Promise<string | undefined> };
const mock = {
  window: {
    showInformationMessage: async (message: string) => {
      ui.asked.push(message);
      return ui.answer;
    },
  },
};
const { CaptureOffer, CAPTURE_OFFER_LIMIT } = withVscode(
  mock,
  () => require('./capture-offer') as typeof import('./capture-offer'),
);

function memento() {
  const stored = new Map<string, unknown>();
  return {
    stored,
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
}

function setup(global = memento()) {
  const enabled: boolean[] = [];
  const steps: string[] = [];
  const offer = new CaptureOffer({
    workspace: memento(),
    global,
    enable: async (everywhere) => void enabled.push(everywhere),
    record: (step) => steps.push(step),
  });
  return { offer, enabled, steps, global };
}

test('a dev server starting with capture off is offered capture, once per workspace', async () => {
  Object.assign(ui, { asked: [], answer: 'Capture in This Workspace' });
  const here = setup();
  assert.equal(await here.offer.commandStarted('git status'), false, 'not for any command');
  assert.equal(await here.offer.commandStarted('npm run dev'), true);
  assert.match(ui.asked[0], /starts with the next command/);
  assert.deepEqual(here.enabled, [false]);
  assert.deepEqual(here.steps, ['shown', 'accepted']);
  assert.equal(await here.offer.commandStarted('npm run dev'), false);
  assert.equal(await setup(here.global).offer.commandStarted('npm run dev'), false, 'a yes ends it everywhere');

  ui.answer = 'Capture Everywhere';
  const everywhere = setup();
  await everywhere.offer.commandStarted('docker compose up');
  assert.deepEqual(everywhere.enabled, [true]);
});

test('Not Now is asked again in another workspace, and a few times at most', async () => {
  Object.assign(ui, { asked: [], answer: 'Not Now' });
  const global = memento();
  for (let workspace = 0; workspace < CAPTURE_OFFER_LIMIT; workspace++) {
    const next = setup(global);
    assert.equal(await next.offer.commandStarted('npm start'), true);
    assert.deepEqual(next.enabled, []);
    assert.deepEqual(next.steps, ['shown', 'dismissed']);
  }
  assert.equal(await setup(global).offer.commandStarted('npm start'), false);
  assert.equal(ui.asked.length, CAPTURE_OFFER_LIMIT);
});

test('a second dev server starting while the question is open does not ask again', async () => {
  let answer!: (value: string | undefined) => void;
  Object.assign(ui, { asked: [], answer: new Promise<string | undefined>((resolve) => (answer = resolve)) });
  const { offer } = setup();
  const first = offer.commandStarted('npm run dev');
  assert.equal(await offer.commandStarted('npm run dev'), false);
  answer(undefined);
  assert.equal(await first, true);
  assert.equal(ui.asked.length, 1);
});
