import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

const done: [string, string][] = [];
const mockVscode = {
  env: {
    openExternal: async (uri: { toString(): string }) => {
      done.push(['open', uri.toString()]);
      return true;
    },
    clipboard: { writeText: async (text: string) => void done.push(['clipboard', text]) },
  },
  window: { showInformationMessage: (message: string) => void done.push(['info', message]) },
  commands: { executeCommand: async (name: string) => void done.push(['command', name]) },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
};
const { aboutInfo, aboutText, runAboutAction } = withVscode(
  mockVscode,
  () => require('./about') as typeof import('./about'),
);

test('About Logline shows the version, the editor, and the system, and copies them on separate lines', () => {
  const info = aboutInfo('1.20.0', { name: 'Visual Studio Code', version: '1.99.0' }, 'Darwin arm64 25.0.0');
  assert.deepEqual(info, { version: '1.20.0', editor: 'Visual Studio Code 1.99.0', system: 'Darwin arm64 25.0.0' });
  assert.equal(aboutText(info), 'Logline 1.20.0\nVisual Studio Code 1.99.0\nDarwin arm64 25.0.0');
  assert.equal(aboutInfo('', { name: 'Cursor', version: '1.0' }, 'Linux x64').version, 'unknown');
});

test('each link in the About dialog opens its own page', async () => {
  done.length = 0;
  for (const action of ['sponsor', 'author', 'github', 'issue'] as const) await runAboutAction(action);
  assert.deepEqual(done, [
    ['open', 'https://github.com/sponsors/SurjeetBanga'],
    ['open', 'https://github.com/SurjeetBanga'],
    ['open', 'https://github.com/SurjeetBanga/logline'],
    ['open', 'https://github.com/SurjeetBanga/logline/issues/new'],
  ]);
});

test('What’s new opens the release notes, and Copy copies the details only when it has them', async () => {
  done.length = 0;
  await runAboutAction('whatsNew');
  await runAboutAction('copy');
  assert.deepEqual(done, [['command', 'logline.showWhatsNew']], 'Copy without details writes nothing');
  done.length = 0;
  await runAboutAction('copy', { version: '1.20.0', editor: 'Cursor 1.0', system: 'Linux x64' });
  assert.deepEqual(done, [
    ['clipboard', 'Logline 1.20.0\nCursor 1.0\nLinux x64'],
    ['info', 'Copied Logline version details.'],
  ]);
});
