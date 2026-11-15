import { summarizeGenAiCalls, type GenAiCall } from './gen-ai';

/** How much the status bar says: Codex's fullest limit, with its name, or with today's tokens too. */
export type AiUsageDetail = 'min' | 'medium' | 'max';
export const AI_USAGE_DETAILS: AiUsageDetail[] = ['min', 'medium', 'max'];

/** One fact read from a Codex session file. Times are epoch milliseconds. */
export type CodexRecord =
  | { kind: 'tokens'; at: number; tokens: number }
  | { kind: 'limit'; at: number; window: string; minutes: number; usedPercent: number; resetsAt: number };

export interface CodexLimit {
  /** `5h`, `7d`, `30d`, and so on. */
  window: string;
  usedPercent: number;
  resetsAt: number;
  /** When Codex reported it. */
  asOf: number;
}
export interface CodexUsage {
  /** Tokens used today. */
  tokens: number;
  /** Limit windows that have not reset, shortest first. */
  limits: CodexLimit[];
}
export const NO_CODEX_USAGE: CodexUsage = { tokens: 0, limits: [] };

const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** `300` minutes is `5h`, `10080` is `7d`. */
export function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** What a `token_count` line of a Codex session file says: the tokens of the last turn and the plan's limits. */
export function readCodexLine(line: string): CodexRecord[] {
  if (!line.includes('"token_count"')) return [];
  let entry: Record<string, unknown> | undefined;
  try {
    entry = object(JSON.parse(line));
  } catch {
    return [];
  }
  const payload = object(entry?.payload);
  if (payload?.type !== 'token_count') return [];
  const at = typeof entry!.timestamp === 'string' ? Date.parse(entry!.timestamp) || 0 : 0;
  const records: CodexRecord[] = [];
  const last = object(object(payload.info)?.last_token_usage);
  const tokens = last ? number(last.total_tokens) || number(last.input_tokens) + number(last.output_tokens) : 0;
  if (tokens) records.push({ kind: 'tokens', at, tokens });
  const limits = object(payload.rate_limits);
  for (const name of ['primary', 'secondary']) {
    const window = object(limits?.[name]);
    const minutes = number(window?.window_minutes);
    if (!window || !minutes || typeof window.used_percent !== 'number' || !number(window.resets_at)) continue;
    records.push({
      kind: 'limit',
      at,
      window: windowLabel(minutes),
      minutes,
      usedPercent: window.used_percent,
      resetsAt: number(window.resets_at) * 1000,
    });
  }
  return records;
}

/** The start of the local day that holds `now`. */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Adds up what Codex's session files say: today's tokens, and the newest reading of each limit window. */
export class CodexUsageTally {
  private day = 0;
  /** Today's tokens by session file. */
  private readonly today = new Map<string, number>();
  private readonly limits = new Map<string, CodexRecord & { kind: 'limit' }>();

  /** Count a record read from `source`, a session file. */
  add(record: CodexRecord, source: string, now: number): void {
    this.roll(now);
    if (record.kind === 'limit') {
      if ((this.limits.get(record.window)?.at ?? -1) <= record.at) this.limits.set(record.window, record);
    } else if (record.at >= this.day) this.today.set(source, (this.today.get(source) ?? 0) + record.tokens);
  }

  /** Forget a session file that is no longer read. */
  forget(source: string): void {
    this.today.delete(source);
  }

  totals(now: number): CodexUsage {
    this.roll(now);
    for (const [key, limit] of this.limits) if (limit.resetsAt <= now) this.limits.delete(key);
    const limits = [...this.limits.values()]
      .sort((a, b) => a.minutes - b.minutes)
      .map(({ window, usedPercent, resetsAt, at }) => ({ window, usedPercent, resetsAt, asOf: at }));
    let tokens = 0;
    for (const count of this.today.values()) tokens += count;
    return { tokens, limits };
  }

  /** A new day starts the count again; limits carry over until they reset. */
  private roll(now: number): void {
    const day = startOfDay(now);
    if (day === this.day) return;
    this.day = day;
    this.today.clear();
  }
}

/** What the app being debugged did with LLMs, from the GenAI calls Logline retains. */
export interface AppUsage {
  calls: number;
  tokens: number;
}
export function appUsage(calls: readonly GenAiCall[]): AppUsage {
  const summary = summarizeGenAiCalls(calls, 0);
  return { calls: summary.modelCalls, tokens: summary.inputTokens + summary.outputTokens };
}

/** `128`, `1.2k`, `48k`, `3.9M`: a count short enough for the status bar. */
export function shortCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
}

/** The pie glyph for a percentage: `scripts/build-icons.mjs` draws one for every 5%. */
export function pieIcon(percent: number): string {
  const step = Math.round(Math.max(0, Math.min(100, percent)) / 5) * 5;
  // A pie is full only when the limit is reached, and empty only when nothing is used.
  const shown = step === 100 && percent < 100 ? 95 : step === 0 && percent > 0 ? 5 : step;
  return `$(logline-pie-${shown})`;
}
const percentText = (percent: number) => `${Math.min(100, Math.floor(percent))}%`;

/** `████████░░` for 80%. */
export function progressBar(percent: number, width = 10): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const fullest = (limits: readonly CodexLimit[]) =>
  limits.reduce<CodexLimit | undefined>(
    (most, limit) => (most && most.usedPercent >= limit.usedPercent ? most : limit),
    undefined,
  );
const callsText = (calls: number) => `${shortCount(calls)} call${calls === 1 ? '' : 's'}`;

/**
 * The status bar text: the Logline mark, then a pie and percentage for Codex's
 * fullest limit. With nothing to say it is the mark alone, which still opens the Logs panel.
 */
export function aiUsageText(usage: CodexUsage, app: AppUsage, detail: AiUsageDetail): string {
  const limit = fullest(usage.limits);
  const parts: string[] = [];
  if (limit)
    parts.push(`${pieIcon(limit.usedPercent)} ${detail === 'min' ? '' : 'Codex '}${percentText(limit.usedPercent)}`);
  // With no limit to show, the tokens stand in for it at every level.
  if (usage.tokens && (detail === 'max' || !limit)) parts.push(`${shortCount(usage.tokens)} tok`);
  if (!parts.length && app.calls) parts.push(callsText(app.calls));
  return parts.length ? `$(logline-mark) ${parts.join('  ')}` : '$(logline-mark)';
}

/** Which of the editor's status colours the item takes: a limit is nearly used, or used up. */
export function aiUsageSeverity(usage: CodexUsage): 'warning' | 'error' | undefined {
  const worst = Math.max(0, ...usage.limits.map((limit) => limit.usedPercent));
  return worst >= 100 ? 'error' : worst >= 80 ? 'warning' : undefined;
}

export interface AiUsageTooltipOptions {
  detail: AiUsageDetail;
  /** Whether Codex's session files are read; when not, reading them is offered. */
  codex: boolean;
  now: number;
  locale?: string;
  timeZone?: string;
}

/** `3:40 PM` today, `Thu` this week, `Nov 30` after that. */
export function resetText(resetsAt: number, options: AiUsageTooltipOptions): string {
  const { now, locale, timeZone } = options;
  const format = (parts: Intl.DateTimeFormatOptions) =>
    new Date(resetsAt).toLocaleString(locale, { ...parts, timeZone });
  if (
    resetsAt - now < 24 * 3600_000 &&
    format({ day: 'numeric' }) === new Date(now).toLocaleString(locale, { day: 'numeric', timeZone })
  )
    return format({ hour: 'numeric', minute: '2-digit' });
  return resetsAt - now < 6 * 24 * 3600_000 ? format({ weekday: 'short' }) : format({ month: 'short', day: 'numeric' });
}

function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

const COLORS = { warning: 'editorWarning-foreground', error: 'editorError-foreground' };
/** Text in the editor's warning or error colour, which follows the theme. */
function colored(text: string, percent: number): string {
  const severity = percent >= 100 ? 'error' : percent >= 80 ? 'warning' : undefined;
  return severity ? `<span style="color:var(--vscode-${COLORS[severity]});">${text}</span>` : text;
}

/**
 * The hover, as Markdown for a trusted tooltip that renders theme icons and
 * HTML: a row for Codex and for the app, the three levels of detail as links,
 * and Codex usage to turn on while it is off.
 */
export function aiUsageTooltip(usage: CodexUsage, app: AppUsage, options: AiUsageTooltipOptions): string {
  const { detail, now } = options;
  const levels = AI_USAGE_DETAILS.map((level) => {
    const name = level[0].toUpperCase() + level.slice(1);
    return level === detail
      ? `**${name}**`
      : `[${name}](command:logline.setAiUsageDetail?${encodeURIComponent(JSON.stringify(level))})`;
  }).join(' · ');
  const rows: string[] = [];
  const top = fullest(usage.limits);
  if (top || usage.tokens) {
    const windows = usage.limits.map((limit) => {
      const reset = limit === top ? ` until ${resetText(limit.resetsAt, options)}` : '';
      return colored(
        `${progressBar(limit.usedPercent)} ${limit.window} ${percentText(limit.usedPercent)}${reset}`,
        limit.usedPercent,
      );
    });
    rows.push(
      `| ${top ? pieIcon(top.usedPercent) : ''} | Codex | ${windows.join(' · ')} | ${usage.tokens ? `${shortCount(usage.tokens)} tok` : ''} |`,
    );
  }
  if (app.calls) rows.push(`| | This app | ${callsText(app.calls)} | ${shortCount(app.tokens)} tok |`);
  const lines = [`$(logline-mark) **Logline AI usage** &nbsp;&nbsp; Show ${levels}`];
  if (rows.length) lines.push(['| | | | |', '|:--|:--|:--|--:|', ...rows].join('\n'));
  if (!options.codex)
    lines.push(
      'Turn on [Codex usage](command:logline.enableCodexUsage)  \nRead on this machine only. Nothing is sent.',
    );
  const newest = Math.max(0, ...usage.limits.map((limit) => limit.asOf));
  lines.push(
    [
      ...(usage.tokens ? ['Today'] : []),
      ...(newest ? [`limits as of ${agoText(now - newest)}`] : []),
      '[Open Logs](command:logline.logs.focus)',
      `[Settings](command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify('logline.aiUsage'))})`,
    ].join(' · '),
  );
  return lines.join('\n\n');
}
