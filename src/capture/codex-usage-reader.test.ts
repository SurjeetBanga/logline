import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEX_SCAN_MS, CodexUsageReader } from './codex-usage-reader';

const iso = (ms: number) => new Date(ms).toISOString();
const codex = (at: number, tokens: number, percent: number, resetsAt: number) =>
  `${JSON.stringify({
    timestamp: iso(at),
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: tokens } },
      rate_limits: { primary: { used_percent: percent, window_minutes: 300, resets_at: Math.floor(resetsAt / 1000) } },
    },
  })}\n`;

function setup() {
  const codexDir = join(mkdtempSync(join(tmpdir(), 'logline-usage-')), '.codex');
  const clock = { now: Date.now() };
  const day = (date: string) => {
    const folder = join(codexDir, 'sessions', ...date.split('/'));
    mkdirSync(folder, { recursive: true });
    return folder;
  };
  const reader = new CodexUsageReader({ codexDir, now: () => clock.now });
  return { codexDir, clock, day, reader };
}

test('session files are read where they grew, and a line is counted once it is whole', async () => {
  const { clock, day, reader } = setup();
  const resets = clock.now + 3600_000;
  const session = join(day('2026/11/15'), 'rollout-a.jsonl');
  writeFileSync(session, codex(clock.now, 100, 10, resets) + codex(clock.now, 20, 11, resets).slice(0, 30));
  assert.equal((await reader.poll()).tokens, 100);
  appendFileSync(session, codex(clock.now, 20, 11, resets).slice(30) + codex(clock.now, 3, 12, resets));
  const grown = await reader.poll();
  assert.equal(grown.tokens, 123);
  assert.equal(grown.limits[0].usedPercent, 12);
  // Nothing new: nothing is counted twice.
  assert.equal((await reader.poll()).tokens, 123);
  // A file that was rewritten is read from its start.
  writeFileSync(session, codex(clock.now, 5, 12, resets));
  assert.equal((await reader.poll()).tokens, 128);
});

test("Codex's newest session gives its limits even when it was not used today", async () => {
  const { clock, day, reader } = setup();
  const old = day('2026/09/30');
  const resets = clock.now + 3600_000;
  const earlier = clock.now - 40 * 24 * 3600_000;
  writeFileSync(join(old, 'rollout-a.jsonl'), codex(earlier, 50, 10, resets));
  writeFileSync(join(old, 'rollout-b.jsonl'), codex(earlier, 60, 38, resets));
  writeFileSync(join(old, 'rollout-b.txt'), 'ignored');
  for (const name of ['rollout-a.jsonl', 'rollout-b.jsonl'])
    utimesSync(join(old, name), new Date(earlier), new Date(earlier));
  const usage = await reader.poll();
  assert.equal(usage.tokens, 0);
  assert.deepEqual(
    usage.limits.map(({ window, usedPercent }) => ({ window, usedPercent })),
    [{ window: '5h', usedPercent: 38 }],
  );
  // A session of today is found on the next listing and followed as it grows.
  const today = join(day('2026/11/15'), 'rollout-c.jsonl');
  writeFileSync(today, codex(clock.now, 70, 41, resets));
  assert.equal((await reader.poll()).tokens, 0);
  clock.now += CODEX_SCAN_MS;
  const later = await reader.poll();
  assert.equal(later.tokens, 70);
  assert.equal(later.limits[0].usedPercent, 41);
  // A session that is gone is forgotten.
  rmSync(today);
  clock.now += CODEX_SCAN_MS;
  assert.equal((await reader.poll()).tokens, 0);
});

test('a missing folder is no trouble', async () => {
  const { codexDir } = setup();
  assert.deepEqual(await new CodexUsageReader({ codexDir }).poll(), { tokens: 0, limits: [] });
});
