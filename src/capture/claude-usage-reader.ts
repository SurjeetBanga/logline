import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ClaudeUsageTally, readClaudeUsageLine, type ClaudeUsage } from '../core/claude-usage';
import { startOfDay } from '../core/codex-usage';
import { CODEX_POLL_BYTES, CODEX_SCAN_MS } from './codex-usage-reader';
import { JsonlTail, listFolder } from './jsonl-tail';

export interface ClaudeUsageReaderOptions {
  /** Claude Code's folder, usually `~/.claude`. */
  claudeDir: string;
  now?: () => number;
}

/**
 * Reads the tokens Claude Code records in its session files, for every project,
 * from the files written to today. Nothing it reads leaves the machine.
 */
export class ClaudeUsageReader {
  private readonly tally = new ClaudeUsageTally();
  private readonly files = new Map<string, JsonlTail>();
  private scanned = -Infinity;

  constructor(private readonly options: ClaudeUsageReaderOptions) {}

  async poll(): Promise<ClaudeUsage> {
    const now = (this.options.now ?? Date.now)();
    if (now - this.scanned >= CODEX_SCAN_MS) {
      this.scanned = now;
      await this.scan(startOfDay(now));
    }
    let budget = CODEX_POLL_BYTES;
    for (const [file, tail] of this.files) {
      if (budget <= 0) break;
      budget -= await tail.read(budget, (line) => {
        const record = readClaudeUsageLine(line);
        if (record) this.tally.add(record, file, now);
      });
    }
    return this.tally.totals(now);
  }

  private async scan(day: number): Promise<void> {
    const current = new Set<string>();
    const projects = join(this.options.claudeDir, 'projects');
    for (const project of await listFolder(projects)) {
      const folder = join(projects, project);
      for (const name of await listFolder(folder)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = join(folder, name);
        try {
          if ((await fs.stat(file)).mtimeMs < day) continue;
        } catch {
          continue;
        }
        current.add(file);
        if (!this.files.has(file)) this.files.set(file, new JsonlTail(file));
      }
    }
    for (const file of this.files.keys()) {
      if (current.has(file)) continue;
      this.files.delete(file);
      this.tally.forget(file);
    }
  }
}
