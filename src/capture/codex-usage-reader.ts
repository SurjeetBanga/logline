import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { JsonlTail, listFolder as list } from './jsonl-tail';
import { CodexUsageTally, readCodexLine, startOfDay, type CodexUsage } from '../core/codex-usage';

export interface CodexUsageReaderOptions {
  /** Codex's folder, usually `~/.codex`. */
  codexDir: string;
  now?: () => number;
}

/** How often the folders are listed for new session files; known files are checked on every poll. */
export const CODEX_SCAN_MS = 60_000;
/**
 * The most that one poll reads. A day of heavy use is under 100 MB and reads in a fraction of a
 * second, so the first poll shows the whole day instead of a total that climbs over several polls.
 */
export const CODEX_POLL_BYTES = 256 * 1024 * 1024;
/**
 * Reads what Codex records about its own usage: the session files it keeps
 * under the user's home folder. It reads only what was appended since the
 * last poll, and nothing it reads leaves the machine.
 */
export class CodexUsageReader {
  private readonly tally = new CodexUsageTally();
  private readonly files = new Map<string, JsonlTail>();
  private scanned = -Infinity;
  private seeded = false;

  constructor(private readonly options: CodexUsageReaderOptions) {}

  async poll(): Promise<CodexUsage> {
    const now = (this.options.now ?? Date.now)();
    if (now - this.scanned >= CODEX_SCAN_MS) {
      this.scanned = now;
      await this.scan(startOfDay(now));
    }
    let budget = CODEX_POLL_BYTES;
    for (const [file, tail] of this.files) {
      if (budget <= 0) break;
      budget -= await tail.read(budget, (line) => {
        for (const record of readCodexLine(line)) this.tally.add(record, file, now);
      });
    }
    return this.tally.totals(now);
  }

  /** Find the session files written to today, and stop following the ones that were not. */
  private async scan(day: number): Promise<void> {
    const current = new Set<string>();
    // Sessions are filed by the day they began: sessions/2026/11/15/rollout-….jsonl.
    const days: string[] = [];
    const sessions = join(this.options.codexDir, 'sessions');
    for (const year of (await list(sessions)).sort().reverse().slice(0, 2))
      for (const month of (await list(join(sessions, year))).sort().reverse().slice(0, 2))
        for (const date of (await list(join(sessions, year, month))).sort().reverse().slice(0, 3))
          days.push(join(sessions, year, month, date));
    days.sort().reverse();
    for (const [index, folder] of days.slice(0, 3).entries()) {
      const names = (await list(folder)).filter((name) => name.endsWith('.jsonl')).sort();
      for (const name of names) {
        const file = join(folder, name);
        // Codex was last used some days ago: its newest session still holds the plan's limits.
        const seed = !this.seeded && index === 0 && name === names[names.length - 1];
        try {
          if (!seed && (await fs.stat(file)).mtimeMs < day) continue;
        } catch {
          continue;
        }
        current.add(file);
        if (!this.files.has(file)) this.files.set(file, new JsonlTail(file));
      }
    }
    this.seeded = true;
    for (const file of this.files.keys()) {
      if (current.has(file)) continue;
      this.files.delete(file);
      this.tally.forget(file);
    }
  }
}
