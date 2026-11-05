import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = {
  settings: { autoUpdate: false, autoCheckUpdates: true } as Record<string, unknown>,
  warnings: [] as string[],
  commands: [] as string[],
  installFails: false,
};
const { UpdateCheck, UPDATE_EVERY_MS, isNewer, storeVersion, wantsUpdateNotice } = withVscode(
  {
    env: { appName: 'Visual Studio Code' },
    workspace: { getConfiguration: () => ({ get: (key: string) => ui.settings[key] }) },
    window: {
      showWarningMessage: (message: string) => ui.warnings.push(message),
    },
    commands: {
      executeCommand: async (command: string) => {
        ui.commands.push(command);
        if (ui.installFails && command.includes('installExtension')) throw new Error('offline');
      },
    },
  },
  () => require('./update-check') as typeof import('./update-check'),
);

function setup(latest: string | undefined = '1.20.0', initial: Record<string, unknown> = {}) {
  Object.assign(ui, {
    settings: { autoUpdate: 'off', autoCheckUpdates: true },
    warnings: [],
    commands: [],
    installFails: false,
  });
  const stored = new Map<string, unknown>([['logline.update', initial]]);
  let now = 1_000_000;
  let asked = 0;
  let changes = 0;
  const answers: string[] = [];
  const memento = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
  const make = () =>
    new UpdateCheck(
      memento,
      '1.19.1',
      () => void changes++,
      (answer: string) => void answers.push(answer),
      async () => {
        asked++;
        return latest;
      },
      () => now,
    );
  return {
    check: make(),
    make,
    answers,
    asked: () => asked,
    changes: () => changes,
    advance: (ms: number) => (now += ms),
  };
}

test('versions compare by number, and anything that is not one is never newer', () => {
  assert.equal(isNewer('1.20.0', '1.19.1'), true);
  assert.equal(isNewer('1.19.10', '1.19.9'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.19.1', '1.19.1'), false);
  assert.equal(isNewer('1.19.0', '1.19.1'), false);
  for (const version of ['', 'latest', '1.20', '1.20.0-beta']) assert.equal(isNewer(version, '1.19.1'), false);
});

test('only someone without automatic updates, who still checks for them, gets the notice', () => {
  const wants = (autoUpdate: unknown, autoCheckUpdates: unknown = true) =>
    wantsUpdateNotice((key) => (key === 'autoUpdate' ? autoUpdate : autoCheckUpdates));
  for (const on of ['on', true, 'onlyEnabledExtensions', undefined, 'a value from a later editor'])
    assert.equal(wants(on), false, `${String(on)} updates by itself, or is not known to be off`);
  for (const off of ['off', false, 'onlySelectedExtensions']) assert.equal(wants(off), true, String(off));
  assert.equal(wants('off', false), false, 'checks turned off stay off');
});

test('a store answer gives its version, and a surprising one gives nothing', () => {
  const marketplace = JSON.stringify({ results: [{ extensions: [{ versions: [{ version: '1.20.0' }] }] }] });
  assert.equal(storeVersion(marketplace, true), '1.20.0');
  assert.equal(storeVersion(JSON.stringify({ version: '1.20.0' }), false), '1.20.0');
  for (const text of [undefined, '', 'not json', '{}', '{"version":5}'])
    assert.equal(storeVersion(text, false), undefined);
  assert.equal(storeVersion('{"results":[]}', true), undefined);
});

test('with automatic updates on, the store is never asked and no button shows', async () => {
  const { check, asked } = setup('1.20.0', { available: '1.20.0' });
  ui.settings.autoUpdate = 'on';
  check.start();
  check.dispose();
  assert.equal(await check.check(), false);
  assert.equal(asked(), 0);
  assert.equal(check.status(), undefined);
});

test('the button goes from Update through installing to Reload, and reloads', async () => {
  const { check, answers, changes } = setup();
  assert.equal(await check.check(), true);
  assert.deepEqual(check.status(), { version: '1.20.0', state: 'available' });
  const pressing = check.press();
  assert.equal(check.status()?.state, 'installing');
  await check.press();
  await pressing;
  assert.deepEqual(ui.commands, ['workbench.extensions.installExtension'], 'a second press does not install twice');
  assert.deepEqual(check.status(), { version: '1.20.0', state: 'ready' });
  assert.deepEqual(answers, ['accepted']);
  await check.press();
  assert.equal(ui.commands.at(-1), 'workbench.action.reloadWindow');
  assert.equal(changes(), 3, 'the panel hears of each change');
});

test('the store is asked at most once a day, and no button shows when Logline is current', async () => {
  const { check, asked, advance } = setup('1.19.1');
  assert.equal(await check.check(), false);
  assert.equal(await check.check(), false);
  assert.equal(asked(), 1);
  advance(UPDATE_EVERY_MS);
  await check.check();
  assert.equal(asked(), 2);
  assert.equal(check.status(), undefined);
});

test('the button is back after a restart without asking the store, until Logline has updated', async () => {
  const later = setup('1.20.0');
  await later.check.check();
  const restarted = later.make();
  restarted.start();
  restarted.dispose();
  assert.deepEqual(restarted.status(), { version: '1.20.0', state: 'available' });
  assert.equal(later.asked(), 1);
  const current = setup('1.19.1', { available: '1.19.1' });
  current.check.start();
  current.check.dispose();
  assert.equal(current.check.status(), undefined, 'the update took');
});

test('a version the editor could not move to is not offered again, but a later one is', async () => {
  const { check, make, advance } = setup('1.20.0');
  await check.check();
  await check.press();
  const restarted = make();
  restarted.start();
  restarted.dispose();
  assert.equal(restarted.status(), undefined, 'still 1.19.1 after installing 1.20.0');
  advance(UPDATE_EVERY_MS);
  assert.equal(await restarted.check(), false);
  const newer = setup('1.21.0', { tried: '1.20.0', available: '1.20.0' });
  assert.equal(await newer.check.check(), true);
  assert.equal(newer.check.status()?.version, '1.21.0');
});

test('a failed update warns, reports it, and leaves the button to try again', async () => {
  const { check, answers } = setup();
  await check.check();
  ui.installFails = true;
  await check.press();
  assert.deepEqual(answers, ['failed']);
  assert.match(ui.warnings[0], /Extensions view/);
  assert.equal(check.status()?.state, 'available');
  ui.installFails = false;
  await check.press();
  assert.equal(check.status()?.state, 'ready');
});

test('a store that cannot be reached shows nothing', async () => {
  const { check } = setup();
  (check as unknown as { latest: () => Promise<undefined> }).latest = async () => undefined;
  assert.equal(await check.check(), false);
  assert.equal(check.status(), undefined);
});
