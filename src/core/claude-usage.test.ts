import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeUsageTally, readClaudeUsageLine, type ClaudeUsageRecord } from './claude-usage';

// Local times, as the tally's day is the local day.
const NOON = new Date(2026, 10, 15, 12).getTime();
const YESTERDAY = new Date(2026, 10, 14, 23).getTime();
const TOMORROW = new Date(2026, 10, 16, 9).getTime();

const line = (
  at: number,
  extra: object = {},
  usage: object | null = {
    input_tokens: 10,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 100,
    output_tokens: 20,
  },
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { id: 'msg_1', ...(usage ? { usage } : {}) },
    ...extra,
  });
const record = (id: string, at: number, input = 15, output = 20, cached = 100): ClaudeUsageRecord => ({
  id,
  at,
  input,
  output,
  cached,
});

test('an assistant line gives its reply id, time, and tokens', () => {
  assert.deepEqual(readClaudeUsageLine(line(NOON)), { id: 'msg_1', at: NOON, input: 15, output: 20, cached: 100 });
  // Without a message id the request id stands in.
  const request = JSON.stringify({
    type: 'assistant',
    requestId: 'req_9',
    timestamp: new Date(NOON).toISOString(),
    message: { usage: { output_tokens: 3 } },
  });
  assert.deepEqual(readClaudeUsageLine(request), { id: 'req_9', at: NOON, input: 0, output: 3, cached: 0 });
});

test('lines that are not an assistant reply with usage and a time are skipped', () => {
  assert.equal(readClaudeUsageLine('not json "usage" "assistant"'), undefined);
  assert.equal(
    readClaudeUsageLine(JSON.stringify({ type: 'user', message: { usage: {}, note: 'assistant' } })),
    undefined,
  );
  assert.equal(readClaudeUsageLine(line(NOON, {}, null)), undefined);
  assert.equal(readClaudeUsageLine(JSON.stringify({ type: 'assistant', message: { usage: 'usage' } })), undefined);
  assert.equal(readClaudeUsageLine(line(NOON, { timestamp: 'later' })), undefined);
  assert.equal(
    readClaudeUsageLine(
      JSON.stringify({ type: 'assistant', timestamp: new Date(NOON).toISOString(), message: { usage: {} } }),
    ),
    undefined,
    'no id',
  );
});

test('the tally counts each reply once, per file, for today only', () => {
  const tally = new ClaudeUsageTally();
  assert.deepEqual(tally.totals(NOON), { tokens: 0, cachedShare: 0 });
  tally.add(record('a', NOON), 'one.jsonl', NOON);
  tally.add(record('a', NOON), 'one.jsonl', NOON);
  tally.add(record('b', NOON, 5, 5, 0), 'two.jsonl', NOON);
  tally.add(record('old', YESTERDAY), 'one.jsonl', NOON);
  const totals = tally.totals(NOON);
  assert.equal(totals.tokens, 15 + 100 + 20 + 10);
  assert.equal(totals.cachedShare, 100 / 120);
  tally.forget('two.jsonl');
  assert.equal(tally.totals(NOON).tokens, 135);
  // A new day starts again.
  assert.deepEqual(tally.totals(TOMORROW), { tokens: 0, cachedShare: 0 });
  tally.add(record('c', TOMORROW, 1, 1, 0), 'one.jsonl', TOMORROW);
  assert.equal(tally.totals(TOMORROW).tokens, 2);
});
