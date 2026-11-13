import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = { asked: [] as string[], answer: undefined as string | undefined | Promise<string | undefined> };
const errors: string[] = [];
const mock = {
  window: {
    showInformationMessage: async (message: string) => {
      ui.asked.push(message);
      return ui.answer;
    },
    showErrorMessage: async (message: string) => void errors.push(message),
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

test('a yes that could not be turned on, or saved, does not end the offer elsewhere', async () => {
  Object.assign(ui, { asked: [], answer: 'Capture in This Workspace' });
  for (const enable of [async () => false, async () => Promise.reject(new Error('no workspace'))]) {
    const global = memento();
    const offer = new CaptureOffer({ workspace: memento(), global, enable });
    assert.equal(await offer.commandStarted('npm run dev'), true);
    assert.equal(await setup(global).offer.commandStarted('npm run dev'), true, 'another workspace still asks');
  }
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

test('a yes that fails is said and asked again, and one that is not saved does not use up the offer', async () => {
  Object.assign(ui, { asked: [], answer: 'Capture in This Workspace' });
  errors.length = 0;
  const global = memento();
  const workspace = memento();
  let fail = true;
  const offer = new CaptureOffer({
    workspace,
    global,
    enable: async () => {
      if (fail) throw new Error('settings.json has unsaved changes');
      return true;
    },
  });
  assert.equal(await offer.commandStarted('npm run dev'), true);
  assert.match(errors[0], /could not turn on terminal capture: settings\.json has unsaved changes/);
  fail = false;
  assert.equal(await offer.commandStarted('npm run dev'), true, 'the same workspace is asked again');
  assert.equal(await offer.commandStarted('npm run dev'), false);

  // Windows with no folder open turn capture on for themselves, however many of them say yes.
  const folderless = memento();
  for (let window = 0; window <= CAPTURE_OFFER_LIMIT; window++) {
    const next = new CaptureOffer({ workspace: memento(), global: folderless, enable: async () => false });
    assert.equal(await next.commandStarted('npm run dev'), true);
  }

  // An answer does not undo what another window saved while the question was open.
  const shared = memento();
  let answer!: (value: string) => void;
  ui.answer = new Promise<string | undefined>((resolve) => (answer = resolve));
  const waiting = setup(shared).offer.commandStarted('npm run dev');
  await new Promise((resolve) => setImmediate(resolve));
  shared.stored.set('logline.captureOffer', { asked: 2 });
  answer('Capture Everywhere');
  await waiting;
  assert.deepEqual(shared.stored.get('logline.captureOffer'), { asked: 2, done: true });
});
