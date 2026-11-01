import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushDown, termGroups, typedValue } from './pushdown';

// A store that understands only field terms, and takes `last:` as its time range.
const fieldsOnly = (input: string) =>
  pushDown(termGroups(input), (token, text) =>
    token.canonical === 'last' ? 'taken' : token.field !== undefined ? text.toUpperCase() : undefined,
  );

test('terms are grouped by OR as typed, with regular expressions kept without a token', () => {
  const groups = termGroups('level:error /time.?out/ OR service:api');
  assert.deepEqual(
    groups.map((group) => group.map((term) => [term.text, term.token !== undefined])),
    [
      [
        ['level:error', true],
        ['/time.?out/', false],
      ],
      [['service:api', true]],
    ],
  );
  assert.deepEqual(termGroups('  OR  '), []);
});

test('each term is pushed to the store or left for Logline', () => {
  assert.deepEqual(fieldsOnly('level:error timeout'), {
    branches: [['LEVEL:ERROR']],
    pushed: ['level:error'],
    local: ['timeout'],
    unrestricted: false,
  });
  assert.deepEqual(fieldsOnly('level:error OR service:api').branches, [['LEVEL:ERROR'], ['SERVICE:API']]);
});

test('a branch the store cannot narrow leaves the whole search to Logline', () => {
  const result = fieldsOnly('level:error OR timeout');
  assert.equal(result.unrestricted, true);
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.local, ['level:error', 'timeout']);
});

test('a time term narrows a search only without OR', () => {
  assert.deepEqual(fieldsOnly('last:15m').pushed, ['last:15m']);
  const or = fieldsOnly('last:15m level:error OR service:api');
  assert.deepEqual(or.local, ['last:15m']);
  assert.deepEqual(or.branches, [['LEVEL:ERROR'], ['SERVICE:API']]);
});

test('a value keeps the case it was typed in', () => {
  const [[{ text, token }]] = termGroups('-service:"Check Out"');
  assert.equal(typedValue(text, token!), 'Check Out');
});
