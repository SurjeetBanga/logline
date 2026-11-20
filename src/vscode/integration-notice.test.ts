import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const ui = {
  said: [] as string[],
  answer: undefined as string | undefined,
  commands: [] as string[],
  opened: [] as string[],
};
const mock = {
  window: {
    showWarningMessage: async (message: string) => {
      ui.said.push(message);
      return ui.answer;
    },
  },
  commands: { executeCommand: async (id: string) => void ui.commands.push(id) },
  env: { openExternal: async (uri: { toString(): string }) => void ui.opened.push(uri.toString()) },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
};
const { IntegrationNotice, INTEGRATION_NOTICE_KEY, integrationHint } = withVscode(
  mock,
  () => require('./integration-notice') as typeof import('./integration-notice'),
);

function memento() {
  const stored = new Map<string, unknown>();
  return {
    stored,
    get: <T>(key: string) => stored.get(key) as T | undefined,
    update: async (key: string, value: unknown) => void stored.set(key, value),
  };
}

test('a terminal without shell integration is said once a window, with a way to capture anyway', async () => {
  Object.assign(ui, { said: [], answer: 'Run Command', commands: [], opened: [] });
  const steps: string[] = [];
  const notice = new IntegrationNotice({ global: memento(), record: (step) => steps.push(step) });
  assert.equal(await notice.noIntegration('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), true);
  assert.match(ui.said[0], /cannot capture this terminal.*execution policy.*Run Command/);
  assert.deepEqual(ui.commands, ['logline.runCommand']);
  assert.equal(await notice.noIntegration('pwsh'), false, 'once a window');
  assert.deepEqual(steps, ['shown', 'accepted']);
});

test("Learn More opens the shell integration guide, and Don't Show Again lasts", async () => {
  Object.assign(ui, { said: [], answer: 'Learn More', commands: [], opened: [] });
  await new IntegrationNotice({ global: memento() }).noIntegration(undefined);
  assert.deepEqual(ui.opened, ['https://code.visualstudio.com/docs/terminal/shell-integration']);

  ui.answer = "Don't Show Again";
  const global = memento();
  const steps: string[] = [];
  await new IntegrationNotice({ global, record: (step) => steps.push(step) }).noIntegration('bash');
  assert.equal(global.stored.get(INTEGRATION_NOTICE_KEY), true);
  assert.equal(await new IntegrationNotice({ global }).noIntegration('bash'), false, 'not in a later window either');
  assert.deepEqual(steps, ['shown', 'never']);

  ui.answer = undefined;
  const dismissed: string[] = [];
  await new IntegrationNotice({ global: memento(), record: (step) => dismissed.push(step) }).noIntegration('zsh');
  assert.deepEqual(dismissed, ['shown', 'dismissed']);
});

test('the hint fits the shell', () => {
  assert.match(integrationHint('C:\\Windows\\System32\\cmd.exe'), /Command Prompt has no shell integration/);
  assert.match(integrationHint('cmd'), /Command Prompt/);
  assert.match(integrationHint('C:/Program Files/PowerShell/7/pwsh.exe'), /execution policy/);
  assert.match(integrationHint('/bin/zsh'), /custom prompt/);
  assert.match(integrationHint(undefined), /custom prompt/);
});
