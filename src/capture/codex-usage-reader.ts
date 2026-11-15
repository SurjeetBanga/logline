import { promises as fs } from 'node:fs';
import { join } from 'node:path';
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
const CHUNK = 1024 * 1024;

interface Followed {
  offset: number;
  /** The start of a line whose end has not been written yet. */
  partial: Buffer;
}

async function list(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}

/**
 * Reads what Codex records about its own usage: the session files it keeps
 * under the user's home folder. It reads only what was appended since the
 * last poll, and nothing it reads leaves the machine.
 */
export class CodexUsageReader {
  private readonly tally = new CodexUsageTally();
  private readonly files = new Map<string, Followed>();
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
    for (const [file, followed] of this.files) {
      if (budget <= 0) break;
      budget -= await this.follow(file, followed, budget, now);
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
        if (!this.files.has(file)) this.files.set(file, { offset: 0, partial: Buffer.alloc(0) });
      }
    }
    this.seeded = true;
    for (const file of this.files.keys()) {
      if (current.has(file)) continue;
      this.files.delete(file);
      this.tally.forget(file);
    }
  }

  /** Read what was appended to a file, up to `budget` bytes; returns how many were read. */
  private async follow(file: string, followed: Followed, budget: number, now: number): Promise<number> {
    let handle: fs.FileHandle | undefined;
    let read = 0;
    try {
      handle = await fs.open(file, 'r');
      const { size } = await handle.stat();
      // A file that shrank was rewritten: what follows is new.
      if (size < followed.offset) Object.assign(followed, { offset: 0, partial: Buffer.alloc(0) });
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(0, size - followed.offset)));
      while (followed.offset < size && read < budget) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - followed.offset),
          followed.offset,
        );
        if (!bytesRead) break;
        followed.offset += bytesRead;
        read += bytesRead;
        const data = Buffer.concat([followed.partial, buffer.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(0x0a);
        followed.partial = Buffer.from(data.subarray(end + 1));
        if (end < 0) continue;
        for (const line of data.toString('utf8', 0, end).split('\n'))
          for (const record of readCodexLine(line)) this.tally.add(record, file, now);
      }
    } catch {
      /* removed or unreadable: the next scan drops it */
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return read;
  }
}
