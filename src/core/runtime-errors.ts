/**
 * Runtime errors by the line of code that raised them: each captured error
 * with a stack trace is keyed by its message and its top stack frames, so
 * the editor can mark the throwing line with how often and how recently it
 * failed. Counts are incremental and follow retention like log lenses.
 */
import { extractExceptions, type SourceLocation } from './exceptions';
import { normalizeMessage, templateQuery } from './log-analysis';
import type { LogEvent } from './types';

export interface RuntimeError {
  key: string;
  /** The error's first line: `TypeError: Cannot read properties of undefined (reading 'card')`. */
  message: string;
  /** Stack frames outside dependencies and the runtime, innermost first; the host opens the first in the workspace. */
  frames: SourceLocation[];
  count: number;
  lastSeen?: number;
  /** The newest event, for Show in Logs. */
  lastId: number;
  /** A search for this error's events, when its message has enough literal text. */
  query?: string;
}

// Frames in installed packages, the language runtime, or generated code are not where a fix goes.
const NOT_APP_CODE =
  /(?:^|[\\/])(?:node_modules|site-packages|dist-packages|vendor|\.cargo[\\/]registry|go[\\/]pkg[\\/]mod|rustc|jdk|\.m2|gems)[\\/]|^(?:node:|internal[\\/]|<|webpack-internal:)|^(?:\/usr\/lib|\/usr\/local\/lib|\/System\/)/;
const MAX_FRAMES = 5;
const MAX_ERRORS = 500;

/** The first line naming the error, from its exception block or its message. */
function headline(event: LogEvent, blockTitle: string | undefined): string {
  const fromBlock = blockTitle && blockTitle !== 'Exception' ? blockTitle : undefined;
  const text = fromBlock ?? event.message ?? event.raw ?? '';
  const line = text.split(/\r?\n/).find((part) => part.trim()) ?? '';
  return line.trim().slice(0, 300);
}

/** The app-code frames of an error event's stack, innermost first, or none for an event without one. */
export function appFrames(event: LogEvent): { message: string; frames: SourceLocation[] } | undefined {
  if (event.level !== 'error' && event.level !== 'fatal') return undefined;
  const blocks = extractExceptions(event);
  if (!blocks.length) return undefined;
  const frames: SourceLocation[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const line of block.lines) {
      const source = line.source;
      if (!source || NOT_APP_CODE.test(source.file)) continue;
      const id = `${source.file}:${source.line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      frames.push(source);
      if (frames.length >= MAX_FRAMES) break;
    }
    // The first block is the error itself; causes only help when it has no app frames.
    if (frames.length) break;
  }
  if (!frames.length) return undefined;
  return { message: headline(event, blocks[0].title), frames };
}

interface Counted {
  id: number;
  key: string;
}

export class RuntimeErrorTracker {
  readonly errors = new Map<string, RuntimeError>();
  watermark = 0;
  /** Changes whenever an error is added, counted, or dropped. */
  revision = 0;
  private counted: Counted[] = [];
  private head = 0;

  reset(watermark = 0): void {
    this.errors.clear();
    this.watermark = watermark;
    this.counted = [];
    this.head = 0;
    this.revision++;
  }

  /** Count events in id order; returns whether anything changed. */
  process(events: Iterable<LogEvent>): boolean {
    let changed = false;
    for (const event of events) {
      if (event.id <= this.watermark) continue;
      this.watermark = event.id;
      const found = appFrames(event);
      if (!found) continue;
      const top = found.frames[0];
      const key = `${normalizeMessage(found.message)}\0${top.file}:${top.line}`;
      let error = this.errors.get(key);
      if (!error) {
        if (this.errors.size >= MAX_ERRORS) continue;
        error = {
          key,
          message: found.message,
          frames: found.frames,
          count: 0,
          lastId: event.id,
          query: templateQuery(normalizeMessage(found.message)),
        };
        this.errors.set(key, error);
      }
      error.count++;
      error.lastId = event.id;
      if (event.timestampMs !== undefined) error.lastSeen = Math.max(error.lastSeen ?? 0, event.timestampMs);
      this.counted.push({ id: event.id, key });
      changed = true;
    }
    if (changed) this.revision++;
    return changed;
  }

  /** Stop counting events older than `oldestId`; returns whether anything changed. */
  evict(oldestId: number): boolean {
    let changed = false;
    while (this.head < this.counted.length && this.counted[this.head].id < oldestId) {
      const { key } = this.counted[this.head++];
      const error = this.errors.get(key);
      if (!error) continue;
      changed = true;
      if (!--error.count) this.errors.delete(key);
    }
    if (this.head > 1024 && this.head * 2 > this.counted.length) {
      this.counted = this.counted.slice(this.head);
      this.head = 0;
    }
    if (changed) this.revision++;
    return changed;
  }

  /** Errors newest first, at most `limit`. */
  list(limit = MAX_ERRORS): RuntimeError[] {
    return [...this.errors.values()].sort((a, b) => b.lastId - a.lastId).slice(0, limit);
  }
}

/** What a marked line says: `TypeError: … · 14× · 2s ago`. */
export function runtimeErrorText(error: RuntimeError, now: number, limit = 120): string {
  const message = error.message.length > limit ? `${error.message.slice(0, limit - 1)}…` : error.message;
  const parts = [message, `${error.count.toLocaleString()}×`];
  if (error.lastSeen !== undefined) parts.push(ago(now - error.lastSeen));
  return parts.join(' · ');
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
