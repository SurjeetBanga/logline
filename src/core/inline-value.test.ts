import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortValue, siteValue } from './inline-value';

const site = (template: string) => ({ template });

test('a structured event shows the fields it added, not the ones its logger adds to every event', () => {
  const raw = JSON.stringify({
    level: 30,
    time: 1,
    pid: 4,
    hostname: 'h',
    msg: 'checkout started',
    cartId: 'c_81',
    items: 3,
  });
  assert.equal(
    siteValue({ isJson: true, raw, message: 'checkout started' }, site('checkout started')),
    '{"cartId":"c_81","items":3}',
  );
});

test('one structured field shows its value alone', () => {
  const raw = JSON.stringify({ msg: 'checkout: order', order: { id: 42 } });
  assert.equal(siteValue({ isJson: true, raw, message: 'checkout: order' }, site('checkout: order')), '{"id":42}');
});

test('key=value output shows its own fields, one value alone', () => {
  assert.equal(siteValue({ message: 'charged', fields: { chargeId: 'ch_9' } }, site('charged')), '"ch_9"');
  assert.equal(
    siteValue({ message: 'charged', fields: { chargeId: 'ch_9', durationMs: 182, level: 'info' } }, site('charged')),
    'chargeId="ch_9" durationMs=182',
  );
});

test("plain text shows the values that filled the message's placeholders", () => {
  assert.equal(siteValue({ message: 'no card on file for user u_42' }, site('no card on file for user …')), 'u_42');
  assert.equal(siteValue({ message: 'worker 7 done in 12ms' }, site('worker … done in …ms')), '7 · 12');
  assert.equal(siteValue({ message: 'receipt failed: SMTP timeout' }, site('receipt failed: …')), 'SMTP timeout');
  // Extra arguments printed after the text, as console.log("total", total) and print("total", total) do.
  assert.equal(siteValue({ message: 'total 19.9' }, site('total')), '19.9');
  // Text a logger put in front of the message does not count.
  assert.equal(siteValue({ message: '[api] order 42 rejected' }, site('order … rejected')), '42');
});

test('a message that is only its text, or does not fit its template, shows nothing', () => {
  assert.equal(siteValue({ message: 'cache warmed' }, site('cache warmed')), undefined);
  assert.equal(siteValue({ message: 'something else entirely' }, site('order … rejected')), undefined);
  assert.equal(siteValue({}, site('cache warmed')), undefined);
});

test('values are always redacted, whatever the export setting says', () => {
  const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
  const raw = JSON.stringify({ msg: 'signed in', user: 'u_42', token: 'abc' });
  assert.equal(
    siteValue({ isJson: true, raw, message: 'signed in' }, site('signed in'), { enabled: false }),
    '{"user":"u_42","token":"[REDACTED]"}',
  );
  assert.doesNotMatch(siteValue({ message: `using ${token}` }, site('using …')) ?? '', /ghp_/);
  assert.equal(
    siteValue({ message: 'card for alice', fields: { owner: 'alice' } }, site('card for …'), { fields: ['owner'] }),
    '"[REDACTED]"',
  );
});

test('a long value is cut to fit the end of a line', () => {
  assert.equal(shortValue('a'.repeat(80)), `${'a'.repeat(59)}…`);
  assert.equal(shortValue('  spread\n over   lines '), 'spread over lines');
});
