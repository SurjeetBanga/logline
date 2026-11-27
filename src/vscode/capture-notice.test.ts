import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = { said: [] as string[], errors: [] as string[], answer: undefined as string | undefined };
const mock = {
  window: {
    showInformationMessage: async (message: string) => {
      ui.said.push(message);
      return ui.answer;
    },
    showErrorMessage: async (message: string) => void ui.errors.push(message),
  },
};
const { CaptureNotice, CAPTURE_NOTICE_KEY } = withVscode(
  mock,
  () => require('./capture-notice') as typeof import('./capture-notice'),
);

function memento() {
  const stored = new Map<string, unknown>();
  return {
    stored,
    get: <T>(key: string, fallback?: T) => (stored.has(key) ? (stored.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
}

function notice(answer: string | undefined, options: { byDefault?: boolean; turnOff?: () => Promise<unknown> } = {}) {
  Object.assign(ui, { said: [], errors: [], answer });
  const global = memento();
  const calls = { turnedOff: 0, shown: 0, steps: [] as string[] };
  const instance = new CaptureNotice({
    global,
    byDefault: () => options.byDefault ?? true,
    turnOff: options.turnOff ?? (async () => void calls.turnedOff++),
    showLogs: () => void calls.shown++,
    record: (step) => calls.steps.push(step),
  });
  return { instance, global, calls };
}

test('the first capture by default says so once, and Turn Off turns capture off', async () => {
  const { instance, global, calls } = notice('Turn Off');
  assert.equal(await instance.captured(), true);
  assert.match(ui.said[0], /capturing this terminal command.*stays on this computer/);
  assert.equal(calls.turnedOff, 1);
  assert.equal(global.stored.get(CAPTURE_NOTICE_KEY), true);
  assert.equal(instance.finished, true);
  assert.equal(await instance.captured(), false, 'once');
  assert.deepEqual(calls.steps, ['shown', 'never']);
});

test('Show Logs opens the panel, and a later window does not say it again', async () => {
  const { instance, global, calls } = notice('Show Logs');
  await instance.captured();
  assert.equal(calls.shown, 1);
  const later = new CaptureNotice({
    global,
    byDefault: () => true,
    turnOff: async () => undefined,
    showLogs: () => undefined,
  });
  assert.equal(await later.captured(), false);
  assert.deepEqual(calls.steps, ['shown', 'accepted']);
});

test('capture someone turned on themselves is not announced', async () => {
  const { instance, calls } = notice('Turn Off', { byDefault: false });
  assert.equal(await instance.captured(), false);
  assert.equal(instance.finished, false, 'still said once capture is on by default');
  assert.deepEqual(ui.said, []);
  assert.equal(calls.turnedOff, 0);
});

test('a dismissed notice is counted, and a failure to turn capture off is said', async () => {
  const dismissed = notice(undefined);
  await dismissed.instance.captured();
  assert.deepEqual(dismissed.calls.steps, ['shown', 'dismissed']);

  const failing = notice('Turn Off', {
    turnOff: async () => {
      throw new Error('settings are read-only');
    },
  });
  await failing.instance.captured();
  assert.match(ui.errors[0], /could not turn off terminal capture: settings are read-only/);
});
