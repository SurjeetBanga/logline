import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDBACK_TEXT_LIMIT, scrubFeedback } from './feedback';

test('a suggestion leaves out credentials and anything that could say who or where someone is', () => {
  const token = ['ghp', 'A'.repeat(36)].join('_');
  const cases: [string, string][] = [
    [`my token ${token}`, 'my token [REDACTED]'],
    ['email me at jane.doe@acme.com', 'email me at [EMAIL]'],
    ['call +1 415 555 0134 or (415) 555-0134', 'call [PHONE] or [PHONE]'],
    ['card 4242 4242 4242 4242', 'card [NUMBER]'],
    ['order 123456789 failed', 'order [NUMBER] failed'],
    ['from 10.2.3.4:8080 and fe80:0:0:0:1:2:3:4', 'from [IP] and [IP]'],
    ['host db-prod-3.acme.internal and api.acme.com', 'host [HOST] and [HOST]'],
    ['see https://user:pw@example.com/x and postgres://u:p@db/x', 'see [URL] and [URL]'],
    ['logs in /Users/jane/work/app.log, ~/app, and C:\\Users\\jane\\x', 'logs in [PATH], [PATH], and [PATH]'],
    ['a key abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'a key [REDACTED]'],
  ];
  for (const [text, scrubbed] of cases) assert.equal(scrubFeedback(text), scrubbed, text);
});

test('ordinary suggestion text is left as written', () => {
  const text =
    'Support Node.js 22 and package.json scripts, show logline.telemetry.enabled in the panel, v1.19.0 since 2026-11-01: 500 errors, status:5xx, last:15m, durationMs:>200';
  assert.equal(scrubFeedback(text), text);
  assert.equal(scrubFeedback('  trimmed  '), 'trimmed');
  assert.equal(scrubFeedback('more words '.repeat(60)).length, FEEDBACK_TEXT_LIMIT, 'at most the form’s limit');
});
