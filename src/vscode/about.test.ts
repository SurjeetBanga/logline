import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

const { aboutInfo, aboutText } = withVscode({}, () => require('./about') as typeof import('./about'));

test('About Logline shows the version, the editor, and the system, and copies them on separate lines', () => {
  const info = aboutInfo('1.20.0', { name: 'Visual Studio Code', version: '1.99.0' }, 'Darwin arm64 25.0.0');
  assert.deepEqual(info, { version: '1.20.0', editor: 'Visual Studio Code 1.99.0', system: 'Darwin arm64 25.0.0' });
  assert.equal(aboutText(info), 'Logline 1.20.0\nVisual Studio Code 1.99.0\nDarwin arm64 25.0.0');
  assert.equal(aboutInfo('', { name: 'Cursor', version: '1.0' }, 'Linux x64').version, 'unknown');
});
