import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalNormalizer, terminalLevel } from './capture/terminal-normalizer';

test('terminal normalizer handles split ANSI sequences and redraws', () => {
  const lines: string[] = [];
  const normalizer = new TerminalNormalizer(line => lines.push(line.text));
  normalizer.write('\x1b[3'); normalizer.write('1m[ERROR] failed\x1b[0m\nprogress 1'); normalizer.write('\rprogress 2\n'); normalizer.end();
  assert.deepEqual(lines, ['[ERROR] failed', 'progress 2']);
});

test('terminal normalizer skips alternate screen content and bounds lines', () => {
  const lines: { text: string; truncated: boolean }[] = [];
  const normalizer = new TerminalNormalizer(line => lines.push(line), 4);
  normalizer.write('\x1b[?1049hsecret\n\x1b[?1049lhello world\n');
  assert.deepEqual(lines, [{ text: 'hell', truncated: true }]);
});

test('terminal levels require an explicit leading marker', () => {
  assert.equal(terminalLevel('[WARN] slow'), 'warn');
  assert.equal(terminalLevel('request returned an error'), 'unclassified');
});

test('terminal normalizer preserves ordinary CRLF line endings across chunks', () => {
  const lines: string[] = [];
  const normalizer = new TerminalNormalizer(line => lines.push(line.text));
  normalizer.write('first\r'); normalizer.write('\nsecond\r\n');
  assert.deepEqual(lines, ['first', 'second']);
});

test('terminal normalizer removes OSC hyperlinks without leaking terminator bytes', () => {
  const lines: string[] = [];
  const normalizer = new TerminalNormalizer(line => lines.push(line.text));
  normalizer.write('\u001b]8;;https://example.test\u001b\\click me\u001b]8;;\u001b\\\n');
  assert.deepEqual(lines, ['click me']);
});

test('terminal normalizer bounds an unterminated escape sequence', () => {
  const lines: string[] = [];
  const normalizer = new TerminalNormalizer(line => lines.push(line.text), 32);
  normalizer.write('\u001b]' + 'x'.repeat(100_000));
  normalizer.write('recovered\n');
  assert.deepEqual(lines, []);
});
