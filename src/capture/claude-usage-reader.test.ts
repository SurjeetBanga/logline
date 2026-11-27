import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEX_SCAN_MS } from './codex-usage-reader';
import { ClaudeUsageReader } from './claude-usage-reader';

const reply = (id: string, at: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 30, output_tokens: 20 } },
  }) + '\n';

test("today's session files in every project are counted once, and older or removed ones are not", async () => {
  const root = mkdtempSync(join(tmpdir(), 'logline-claude-usage-'));
  try {
    const now = Date.now();
    let clock = now;
    const shop = join(root, 'projects', '-work-shop');
    const api = join(root, 'projects', '-work-api');
    mkdirSync(shop, { recursive: true });
    mkdirSync(api, { recursive: true });
    writeFileSync(join(shop, 'a.jsonl'), reply('msg_1', now));
    writeFileSync(join(api, 'b.jsonl'), reply('msg_2', now));
    // Last written before today: not read at all.
    const old = join(api, 'old.jsonl');
    writeFileSync(old, reply('msg_3', now));
    const yesterday = new Date(now - 86_400_000 * 2);
    utimesSync(old, yesterday, yesterday);
    writeFileSync(join(shop, 'notes.txt'), reply('msg_4', now));

    const reader = new ClaudeUsageReader({ claudeDir: root, now: () => clock });
    // Two replies of 10 input, 30 cached, and 20 output tokens each.
    assert.deepEqual(await reader.poll(), { tokens: 120, cachedShare: 0.75 });

    // A reply written again under the same id counts once; a new one adds to the day.
    appendFileSync(join(shop, 'a.jsonl'), reply('msg_1', now) + reply('msg_5', now));
    assert.equal((await reader.poll()).tokens, 180);

    // A file gone at the next scan no longer counts.
    rmSync(join(api, 'b.jsonl'));
    clock += CODEX_SCAN_MS;
    assert.equal((await reader.poll()).tokens, 120);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a projects folder there is no usage', async () => {
  const reader = new ClaudeUsageReader({ claudeDir: join(tmpdir(), 'logline-no-claude-here') });
  assert.deepEqual(await reader.poll(), { tokens: 0, cachedShare: 0 });
});
