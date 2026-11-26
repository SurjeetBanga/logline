import { startOfDay } from './codex-usage';

/** Claude Code's tokens of today, from the session files it keeps under ~/.claude/projects. */
export interface ClaudeUsage {
  /** Input, cache, and output tokens used today. */
  tokens: number;
  /** The share of today's input read from the prompt cache, 0 to 1. */
  cachedShare: number;
}
export const NO_CLAUDE_USAGE: ClaudeUsage = { tokens: 0, cachedShare: 0 };

/** One reply's usage. Claude Code writes a reply's usage again on each of its parts; `id` tells them apart. */
export interface ClaudeUsageRecord {
  id: string;
  at: number;
  input: number;
  output: number;
  cached: number;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The usage on an `assistant` line of a Claude Code session file. */
export function readClaudeUsageLine(line: string): ClaudeUsageRecord | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const message = entry?.message;
  const usage = message?.usage;
  if (entry?.type !== 'assistant' || !usage || typeof usage !== 'object') return undefined;
  const id = typeof message.id === 'string' ? message.id : typeof entry.requestId === 'string' ? entry.requestId : '';
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) || 0 : 0;
  if (!id || !at) return undefined;
  return {
    id,
    at,
    input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
    cached: count(usage.cache_read_input_tokens),
  };
}

/** Adds up today's replies across session files, each reply once. */
export class ClaudeUsageTally {
  private day = 0;
  private readonly replies = new Map<string, Map<string, ClaudeUsageRecord>>();

  add(record: ClaudeUsageRecord, source: string, now: number): void {
    this.roll(now);
    if (record.at < this.day) return;
    let replies = this.replies.get(source);
    if (!replies) this.replies.set(source, (replies = new Map()));
    replies.set(record.id, record);
  }

  forget(source: string): void {
    this.replies.delete(source);
  }

  totals(now: number): ClaudeUsage {
    this.roll(now);
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const replies of this.replies.values())
      for (const reply of replies.values()) {
        input += reply.input;
        output += reply.output;
        cached += reply.cached;
      }
    const read = input + cached;
    return { tokens: read + output, cachedShare: read ? cached / read : 0 };
  }

  private roll(now: number): void {
    const day = startOfDay(now);
    if (day === this.day) return;
    this.day = day;
    this.replies.clear();
  }
}
