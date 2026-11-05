import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = {
  settings: { autoUpdate: false, autoCheckUpdates: true } as Record<string, unknown>,
  answers: [] as (string | undefined)[],
  messages: [] as string[],
  warnings: [] as string[],
  commands: [] as string[],
  installFails: false,
};
const { UpdateCheck, UPDATE_EVERY_MS, isNewer, storeVersion, wantsUpdateNotice } = withVscode(
  {
    env: { appName: 'Visual Studio Code' },
    workspace: { getConfiguration: () => ({ get: (key: string) => ui.settings[key] }) },
    window: {
      showInformationMessage: async (message: string) => {
        ui.messages.push(message);
        return ui.answers.shift();
      },
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

function setup(latest: string | undefined = '1.20.0') {
  Object.assign(ui, {
    settings: { autoUpdate: 'off', autoCheckUpdates: true },
    answers: [],
    messages: [],
    warnings: [],
    commands: [],
    installFails: false,
  });
  const stored = new Map<string, unknown>();
  let now = 1_000_000;
  let asked = 0;
  const answers: string[] = [];
  const check = new UpdateCheck(
    {
      get: <T>(key: string) => stored.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void stored.set(key, value),
    },
    '1.19.1',
    (answer) => answers.push(answer),
    async () => {
      asked++;
      return latest;
    },
    () => now,
  );
  return { check, answers, asked: () => asked, advance: (ms: number) => (now += ms) };
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

test('with automatic updates on, the store is never asked', async () => {
  const { check, asked } = setup();
  ui.settings.autoUpdate = 'on';
  assert.equal(await check.check(), false);
  assert.equal(asked(), 0);
  assert.deepEqual(ui.messages, []);
});

test('Update installs the new version and offers a reload; each version is mentioned once', async () => {
  const { check, answers, advance } = setup();
  ui.answers.push('Update', 'Reload Window');
  assert.equal(await check.check(), true);
  assert.match(ui.messages[0], /Logline 1\.20\.0 is available\. You have 1\.19\.1\./);
  assert.deepEqual(ui.commands, ['workbench.extensions.installExtension', 'workbench.action.reloadWindow']);
  assert.deepEqual(answers, ['accepted']);
  advance(UPDATE_EVERY_MS);
  assert.equal(await check.check(), false, 'already mentioned');
  assert.equal(ui.messages.length, 2);
});

test('the store is asked at most once a day, and nothing is shown when Logline is current', async () => {
  const { check, asked, advance } = setup('1.19.1');
  assert.equal(await check.check(), false);
  assert.equal(await check.check(), false);
  assert.equal(asked(), 1);
  advance(UPDATE_EVERY_MS);
  await check.check();
  assert.equal(asked(), 2);
  assert.deepEqual(ui.messages, []);
});

test('declining, dismissing, and a failed update are reported, and only a failure warns', async () => {
  const later = setup();
  ui.answers.push('Not now');
  await later.check.check();
  assert.deepEqual(later.answers, ['later']);
  assert.deepEqual(ui.commands, []);
  const dismissed = setup();
  await dismissed.check.check();
  assert.deepEqual(dismissed.answers, ['dismissed']);
  const failed = setup();
  ui.installFails = true;
  ui.answers.push('Update');
  await failed.check.check();
  assert.deepEqual(failed.answers, ['failed']);
  assert.match(ui.warnings[0], /Extensions view/);
});

test('a store that cannot be reached shows nothing', async () => {
  const { check } = setup(undefined);
  // `undefined` selects the default above, so this store answers with nothing another way.
  (check as unknown as { latest: () => Promise<undefined> }).latest = async () => undefined;
  assert.equal(await check.check(), false);
  assert.deepEqual(ui.messages, []);
});
