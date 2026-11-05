import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutFraction, withoutSeconds } from './time';

test('a clock time loses its fraction, whichever mark the locale uses', () => {
  assert.equal(withoutFraction('12:30:15.123'), '12:30:15');
  assert.equal(withoutFraction('12:30:15,123'), '12:30:15');
  assert.equal(withoutSeconds('12:30:15.123'), '12:30');
  assert.equal(withoutSeconds('12:30:15,123'), '12:30');
});
