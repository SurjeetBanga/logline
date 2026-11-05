import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutFraction, withoutSeconds } from './time';

test('a clock time loses its fraction, whichever mark the locale uses', () => {
  assert.equal(withoutFraction('12:30:15.123'), '12:30:15');
  assert.equal(withoutFraction('12:30:15,123'), '12:30:15');
  assert.equal(withoutSeconds('12:30:15.123'), '12:30');
  assert.equal(withoutSeconds('12:30:15,123'), '12:30');
});

test('times that separate their parts with a dot lose their seconds too', () => {
  assert.equal(withoutSeconds('12.34.56,789'), '12.34');
});
