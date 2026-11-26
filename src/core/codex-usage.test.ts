import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CodexUsageTally,
  aiUsageSeverity,
  aiUsageText,
  aiUsageTooltip,
  appUsage,
  pieIcon,
  progressBar,
  readCodexLine,
  shortCount,
  windowLabel,
  type AppUsage,
  type CodexUsage,
} from './codex-usage';
import type { GenAiCall } from './gen-ai';

// Local times, as the tally's day is the local day.
const NOON = new Date(2026, 10, 15, 12).getTime();
const YESTERDAY = new Date(2026, 10, 14, 23).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => Math.floor(ms / 1000);

function codexLine(at: number, total: number, limits?: unknown): string {
  return JSON.stringify({
    timestamp: iso(at),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
      rate_limits: limits,
    },
  });
}
const NO_APP: AppUsage = { calls: 0, tokens: 0 };

test('a Codex token count gives the last turn and the plan limits', () => {
  const resets = NOON + 2 * 3600_000;
  const limits = {
    primary: { used_percent: 38, window_minutes: 300, resets_at: seconds(resets) },
    secondary: { used_percent: 12, window_minutes: 10080, resets_at: seconds(resets) + 60 },
  };
  assert.deepEqual(readCodexLine(codexLine(NOON, 15672, limits)), [
    { kind: 'tokens', at: NOON, tokens: 15672 },
    { kind: 'limit', at: NOON, window: '5h', minutes: 300, usedPercent: 38, resetsAt: seconds(resets) * 1000 },
    {
      kind: 'limit',
      at: NOON,
      window: '7d',
      minutes: 10080,
      usedPercent: 12,
      resetsAt: (seconds(resets) + 60) * 1000,
    },
  ]);
  // A window with no figures is left out, and a turn with no total is added up.
  const partial = JSON.stringify({
    timestamp: 'not a time',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 5, output_tokens: 2 } },
      rate_limits: { primary: { used_percent: 1 }, secondary: null },
    },
  });
  assert.deepEqual(readCodexLine(partial), [{ kind: 'tokens', at: 0, tokens: 7 }]);
  assert.deepEqual(readCodexLine('{"payload":{"type":"agent_message"}}'), []);
  assert.deepEqual(readCodexLine('{"payload":{"type":"other","note":"token_count"}}'), []);
  assert.deepEqual(readCodexLine('{"payload":{"type":"token_count"}}'), []);
  assert.deepEqual(readCodexLine('{"payload":"token_count"'), []);
  assert.equal(windowLabel(43200), '30d');
  assert.equal(windowLabel(90), '90m');
});

test("the tally counts only today's tokens and starts again the next day", () => {
  const tally = new CodexUsageTally();
  const add = (line: string, source = 'a', now = NOON) => {
    for (const record of readCodexLine(line)) tally.add(record, source, now);
  };
  add(codexLine(YESTERDAY, 300));
  add(codexLine(NOON, 100));
  add(codexLine(NOON, 50), 'b');
  assert.equal(tally.totals(NOON).tokens, 150);
  tally.forget('b');
  assert.equal(tally.totals(NOON).tokens, 100);
  const tomorrow = NOON + 24 * 3600_000;
  assert.equal(tally.totals(tomorrow).tokens, 0);
  add(codexLine(tomorrow, 7), 'a', tomorrow);
  assert.equal(tally.totals(tomorrow).tokens, 7);
});

test('the tally keeps the newest reading of each limit window until it resets', () => {
  const tally = new CodexUsageTally();
  const limit = (window: string, minutes: number, usedPercent: number, at: number, resetsAt: number) =>
    tally.add({ kind: 'limit', at, window, minutes, usedPercent, resetsAt }, 'x', NOON);
  limit('7d', 10080, 12, NOON, NOON + 9000);
  limit('5h', 300, 38, NOON, NOON + 5000);
  // An older reading does not replace a newer one.
  limit('5h', 300, 90, NOON - 5, NOON + 5000);
  assert.deepEqual(
    tally.totals(NOON).limits.map((entry) => `${entry.window} ${entry.usedPercent}`),
    ['5h 38', '7d 12'],
  );
  assert.equal(tally.totals(NOON).limits[0].asOf, NOON);
  assert.deepEqual(
    tally.totals(NOON + 6000).limits.map((entry) => entry.window),
    ['7d'],
  );
});

test("the app's calls are counted with their tokens", () => {
  const call = (input: number, output: number): GenAiCall => ({
    traceId: 't',
    spanId: 's',
    operation: 'chat',
    kind: 'model',
    name: 'chat',
    service: 'api',
    startMs: 0,
    durationMs: 1,
    inputTokens: input,
    outputTokens: output,
    error: false,
    hasContent: false,
  });
  assert.deepEqual(appUsage([call(40, 8), call(1, 1)]), { calls: 2, tokens: 50 });
  assert.deepEqual(appUsage([]), NO_APP);
});

test('counts are shortened, bars fill by tenths, and a pie is full or empty only when the limit is', () => {
  assert.deepEqual([12, 999.6, 1200, 48_000, 3_900_000].map(shortCount), ['12', '1000', '1.2k', '48k', '3.9M']);
  assert.deepEqual(
    [0, 1, 23, 38, 86, 98, 99.9, 100, 140, -5].map(pieIcon),
    [0, 5, 25, 40, 85, 95, 95, 100, 100, 0].map((step) => `$(logline-pie-${step})`),
  );
  assert.deepEqual(
    [0, 41, 86, 100, 140].map((percent) => progressBar(percent)),
    ['░░░░░░░░░░', '████░░░░░░', '█████████░', '██████████', '██████████'],
  );
});

test('every pie the code can show is an icon the extension declares', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: { icons: Record<string, unknown> };
  };
  const icons = manifest.contributes.icons;
  assert.ok('logline-mark' in icons);
  for (let percent = 0; percent <= 100; percent++) assert.ok(pieIcon(percent).slice(2, -1) in icons, pieIcon(percent));
});

const limit = (window: string, usedPercent: number, resetsAt = NOON + 3600_000) => ({
  window,
  usedPercent,
  resetsAt,
  asOf: NOON - 60_000,
});
const USAGE: CodexUsage = { tokens: 65_000, limits: [limit('5h', 38), limit('7d', 12)] };

test('the status text says as much as the level of detail asks for', () => {
  assert.equal(aiUsageText(USAGE, NO_APP, 'min'), '$(logline-mark) $(logline-pie-40) 38%');
  assert.equal(aiUsageText(USAGE, NO_APP, 'medium'), '$(logline-mark) $(logline-pie-40) Codex 38%');
  assert.equal(aiUsageText(USAGE, NO_APP, 'max'), '$(logline-mark) $(logline-pie-40) Codex 38%  65k tok');
  // With no limit known, the tokens stand in; with no Codex use at all, the app's calls do.
  assert.equal(aiUsageText({ tokens: 65_000, limits: [] }, NO_APP, 'min'), '$(logline-mark) 65k tok');
  const app = { calls: 12, tokens: 48_000 };
  assert.equal(aiUsageText({ tokens: 0, limits: [] }, app, 'medium'), '$(logline-mark) 12 calls');
  assert.equal(aiUsageText({ tokens: 0, limits: [] }, { ...app, calls: 1 }, 'max'), '$(logline-mark) 1 call');
  assert.equal(aiUsageText({ tokens: 0, limits: [] }, NO_APP, 'max'), '$(logline-mark)');
  // A reached limit is never shown as more than all of it.
  assert.equal(
    aiUsageText({ tokens: 0, limits: [limit('5h', 104)] }, NO_APP, 'medium'),
    '$(logline-mark) $(logline-pie-100) Codex 100%',
  );
});

test('the item takes a warning colour from 80% and an error colour at the limit', () => {
  assert.equal(aiUsageSeverity(USAGE), undefined);
  assert.equal(aiUsageSeverity({ tokens: 0, limits: [limit('5h', 80)] }), 'warning');
  assert.equal(aiUsageSeverity({ tokens: 0, limits: [limit('5h', 86), limit('7d', 100)] }), 'error');
  assert.equal(aiUsageSeverity({ tokens: 0, limits: [] }), undefined);
});

test('the hover has a row for Codex and the app, the levels, and Codex usage while it is off', () => {
  const options = { detail: 'medium' as const, codex: true, now: NOON, locale: 'en-US' };
  const usage: CodexUsage = {
    tokens: 65_000,
    limits: [
      limit('5h', 86, new Date(2026, 10, 15, 15, 40).getTime()),
      limit('7d', 41, new Date(2026, 10, 19, 9).getTime()),
    ],
  };
  const text = aiUsageTooltip(usage, { calls: 12, tokens: 48_000 }, options);
  assert.match(text, /^\$\(logline-mark\) \*\*Logline AI usage\*\*/);
  assert.match(text, /\[Min\]\(command:logline\.setAiUsageDetail\?%22min%22\) · \*\*Medium\*\* · \[Max\]/);
  assert.match(
    text,
    /\| \$\(logline-pie-85\) \| Codex \| <span style="color:var\(--vscode-editorWarning-foreground\);">█████████░ 5h 86% until 3:40 PM<\/span> · ████░░░░░░ 7d 41% \| 65k tok \|/,
  );
  assert.match(text, /\| \| This app \| 12 calls \| 48k tok \|/);
  assert.match(text, /Today · limits as of 1 min ago · \[Open Logs\]/);
  assert.doesNotMatch(text, /Turn on/);
  // A reset later this week is named by its day, and a reached limit takes the error colour.
  assert.match(aiUsageTooltip({ tokens: 0, limits: [usage.limits[1]] }, NO_APP, options), /7d 41% until Thu/);
  assert.match(
    aiUsageTooltip({ tokens: 0, limits: [limit('30d', 100, new Date(2026, 10, 30, 9).getTime())] }, NO_APP, options),
    /editorError-foreground\);">██████████ 30d 100% until Nov 30</,
  );

  const fresh = aiUsageTooltip({ tokens: 0, limits: [] }, { calls: 1, tokens: 900 }, { ...options, codex: false });
  assert.match(fresh, /\| \| This app \| 1 call \| 900 tok \|/);
  assert.match(fresh, /Turn on \[Codex usage\]\(command:logline\.enableCodexUsage\)/);
  assert.match(fresh, /Nothing is sent\./);
  assert.doesNotMatch(fresh, /Codex \||Today|limits as of/);
  // How long ago the limits were read, at every scale.
  const aged = (ago: number) =>
    aiUsageTooltip({ tokens: 0, limits: [{ ...limit('5h', 5), asOf: NOON - ago }] }, NO_APP, options);
  assert.match(aged(10_000), /limits as of just now/);
  assert.match(aged(3 * 3600_000), /limits as of 3 h ago/);
  assert.match(aged(50 * 3600_000), /limits as of 2 d ago/);
  // Nothing at all still offers the levels and the settings.
  assert.match(
    aiUsageTooltip({ tokens: 0, limits: [] }, NO_APP, options),
    /\[Settings\]\(command:workbench\.action\.openSettings/,
  );
});

test('Claude Code tokens join the status text and the hover', () => {
  const claude = { tokens: 125_000, cachedShare: 0.8 };
  const limits = [limit('5h', 38)];
  // With no limit the tokens stand in at every level, named when both agents have some.
  assert.equal(aiUsageText({ tokens: 0, limits: [] }, NO_APP, 'min', claude), '$(logline-mark) 125k tok');
  assert.equal(aiUsageText({ tokens: 0, limits: [] }, NO_APP, 'medium', claude), '$(logline-mark) Claude 125k tok');
  assert.equal(
    aiUsageText({ tokens: 65_000, limits: [] }, NO_APP, 'medium', claude),
    '$(logline-mark) Codex 65k tok  Claude 125k tok',
  );
  assert.equal(aiUsageText({ tokens: 65_000, limits: [] }, NO_APP, 'min', claude), '$(logline-mark) 65k tok  125k tok');
  // With a limit, only the highest level adds tokens.
  assert.doesNotMatch(aiUsageText({ tokens: 0, limits }, NO_APP, 'medium', claude), /tok/);
  assert.match(aiUsageText({ tokens: 0, limits }, NO_APP, 'max', claude), /Codex 38%  Claude 125k tok$/);
  assert.equal(aiUsageText({ tokens: 0, limits: [] }, NO_APP, 'max', { tokens: 0, cachedShare: 0 }), '$(logline-mark)');

  const options = { detail: 'medium' as const, codex: true, now: NOON, locale: 'en-US' };
  const tip = aiUsageTooltip({ tokens: 0, limits: [] }, NO_APP, { ...options, claude: true, claudeUsage: claude });
  assert.match(tip, /\| \| Claude Code \| 80% from cache \| 125k tok \|/);
  assert.doesNotMatch(tip, /Turn on/);
  assert.match(
    tip,
    /\[Open Logs\]\(command:logline\.logs\.focus\) · \[Agent sessions\]\(command:logline\.showAgentSessions\) · \[Settings\]/,
  );
  const offer = aiUsageTooltip({ tokens: 0, limits: [] }, NO_APP, { ...options, codex: false, claude: false });
  assert.match(
    offer,
    /Turn on \[Codex usage\]\(command:logline\.enableCodexUsage\) · \[Claude Code usage\]\(command:logline\.enableClaudeUsage\)/,
  );
  const claudeOnly = aiUsageTooltip({ tokens: 0, limits: [] }, NO_APP, { ...options, claude: false });
  assert.match(claudeOnly, /Turn on \[Claude Code usage\]\(command:logline\.enableClaudeUsage\)  \n/);
  assert.doesNotMatch(claudeOnly, /Codex usage\]/);
  // Without the claude option the hover is as it was.
  assert.doesNotMatch(aiUsageTooltip({ tokens: 0, limits: [] }, NO_APP, options), /Agent sessions|Claude Code/);
});
