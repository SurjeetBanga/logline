import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc } from './jsonc';

test('parses plain JSON unchanged', () => {
  assert.deepEqual(parseJsonc('{"a": 1, "b": [1, 2]}'), { a: 1, b: [1, 2] });
});

test('strips line and block comments outside strings', () => {
  const text = `{
    // a line comment
    "a": 1, /* inline */ "b": 2
    /* a
       multi-line comment */
  }`;
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 });
});

test('leaves // and /* inside string values alone', () => {
  assert.deepEqual(parseJsonc('{"url": "http://example.com", "note": "/* not a comment */"}'),
    { url: 'http://example.com', note: '/* not a comment */' });
});

test('tolerates trailing commas the way tasks.json does', () => {
  assert.deepEqual(parseJsonc('{"tasks": [1, 2, 3,],}'), { tasks: [1, 2, 3] });
});

test('preserves comma and bracket sequences in task arguments and keys', () => {
  const args = ['a,}', 'b,]', 'comma,   }', 'escaped quote ",]', 'backslash \\', 'http://example.com,]'];
  const task = { command: 'node', args, 'key,}': 'value' };
  const text = `{"tasks": [${JSON.stringify(task)}, /* trailing comma */],}`;
  assert.deepEqual(parseJsonc(text), { tasks: [task] });
});

test('a comment containing a quote does not desync string tracking', () => {
  assert.deepEqual(parseJsonc('{ // don\'t break on this "quote"\n"a": 1 }'), { a: 1 });
});
