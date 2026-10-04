import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Settings } from '../core/settings';
import type { SessionSummary } from '../core/types';
import type { Ingestion } from './ingestion';
import { LineReader } from './line-reader';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';
import type { ContainerTag } from '../core/container-prefix';
import { LinePipeline, linePipelineOptions } from './line-pipeline';

const CHUNK = 64 * 1024;
const FINGERPRINT = 64;

interface Follow {
  record: SessionSummary;
  file: string;
  position: number;
  /** The last bytes read before `position`, to notice a file rewritten in place. */
  fingerprint: Buffer;
  inode?: number;
  reader: LineReader;
  joiner?: LinePipeline;
  watcher?: FSWatcher;
  poll: ReturnType<typeof setInterval>;
  pumping?: Promise<void>;
  again: boolean;
  stopped: boolean;
}

export interface FollowOptions {
  /** Bytes of existing content to show first; the rest of the file is skipped. */
  tailBytes?: number;
  /** Fallback polling interval for filesystems where fs.watch is unreliable. */
  pollMs?: number;
}

/**
 * Follows a growing log file like `tail -F`: shows the end of the existing
 * content, then every appended line. Truncation (`> app.log`) and rotation
 * (the path now names a different file) restart from the new file's start.
 * A missing file is waited for rather than treated as an error.
 */
export class FileFollower {
  readonly follows = new Map<string, Follow>();
  constructor(private readonly config: Settings, private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion, private readonly state: RuntimeState) { }

  get active(): number { return this.follows.size; }

  async follow(file: string, { tailBytes = 64 * 1024, pollMs = 500 }: FollowOptions = {}): Promise<string> {
    file = path.resolve(file);
    for (const existing of this.follows.values()) {
      if (existing.file === file) {
        this.state.status = `Already following ${path.basename(file)}`;
        this.state.notify();
        return existing.record.id;
      }
    }
    const serverId = `file:${file}`;
    const label = `File · ${path.basename(file)}`;
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'), serverId, server: label, status: 'running', startedAt: Date.now(), events: 0,
      sourceKind: 'file', owned: true, canStop: true, captureComplete: false, command: `tail -F ${file}`, cwd: path.dirname(file)
    };
    const limit = this.config.get('maxLineLength', 65536);
    const ingest = (line: string, truncated: boolean, container?: ContainerTag) => {
      if (follow.stopped) return;
      const event = this.ingestion.accept(line, 'file', { serverId, server: label, sessionId: record.id, truncated, container });
      if (!event) return;
      record.events++;
      this.state.notify();
    };
    const joiner = new LinePipeline(ingest, linePipelineOptions(this.config, limit));
    const reader = new LineReader((line, truncated) => joiner.write(line, truncated), limit);
    const follow: Follow = {
      record, file, position: 0, fingerprint: Buffer.alloc(0), reader, joiner, again: false, stopped: false,
      poll: setInterval(() => this.pump(follow), pollMs)
    };
    follow.poll.unref?.();
    this.registry.records.set(record.id, record);
    this.follows.set(record.id, follow);

    // Start near the end so a large existing log does not flood the store,
    // aligned to the next line boundary so the first event is a whole line.
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) {
      follow.inode = info.ino;
      follow.position = await this.lineStartNear(file, Math.max(0, info.size - Math.max(0, tailBytes)));
      follow.fingerprint = await this.readAt(file, Math.max(0, follow.position - FINGERPRINT), Math.min(FINGERPRINT, follow.position));
    }
    this.watch(follow);
    this.state.status = `Following ${path.basename(file)}`;
    this.state.notify();
    await this.pump(follow);
    return record.id;
  }

  stopSessionById(id: string): void {
    const follow = this.follows.get(id);
    if (follow) this.finish(follow);
  }

  stopServer(serverId: string): void {
    for (const follow of [...this.follows.values()]) if (follow.record.serverId === serverId) this.finish(follow);
  }

  stop(): void { for (const follow of [...this.follows.values()]) this.finish(follow); }

  async dispose(): Promise<void> {
    const pending = [...this.follows.values()].map(follow => follow.pumping);
    this.stop();
    await Promise.all(pending);
  }

  private watch(follow: Follow): void {
    if (follow.stopped) return;
    follow.watcher?.close();
    // Watching the directory survives the file being replaced or created
    // later; the poll timer covers network and container filesystems.
    try {
      follow.watcher = watch(path.dirname(follow.file), { persistent: false }, (_event, name) => {
        if (!name || name.toString() === path.basename(follow.file)) void this.pump(follow);
      });
      follow.watcher.on('error', () => { follow.watcher?.close(); follow.watcher = undefined; });
    } catch { follow.watcher = undefined; }
  }

  // Reads are serialized per file; a change notice during a read schedules
  // exactly one more pass instead of overlapping reads at different offsets.
  private pump(follow: Follow): Promise<void> {
    if (follow.stopped) return Promise.resolve();
    if (follow.pumping) { follow.again = true; return follow.pumping; }
    follow.pumping = (async () => {
      try {
        do {
          follow.again = false;
          await this.readAppended(follow);
        } while (follow.again && !follow.stopped);
      } finally { follow.pumping = undefined; }
    })();
    return follow.pumping;
  }

  private async readAppended(follow: Follow): Promise<void> {
    const info = await stat(follow.file).catch(() => undefined);
    if (!info?.isFile() || follow.stopped) return;
    const rotated = follow.inode !== undefined && info.ino !== follow.inode;
    // `> app.log && echo more >> app.log` can leave the file larger than
    // before on the same inode, so size alone cannot reveal the rewrite.
    const rewritten = !rotated && info.size >= follow.position && follow.fingerprint.length > 0
      && !(await this.readAt(follow.file, follow.position - follow.fingerprint.length, follow.fingerprint.length)).equals(follow.fingerprint);
    if (follow.stopped) return;
    if (rotated || rewritten || info.size < follow.position) {
      // The old file's unterminated last line is complete as far as it goes.
      follow.reader.end();
      follow.joiner?.flush();
      follow.reader = new LineReader(follow.reader.onLine, follow.reader.limit);
      follow.position = 0;
      follow.fingerprint = Buffer.alloc(0);
    }
    follow.inode = info.ino;
    if (info.size <= follow.position) return;
    let handle;
    try { handle = await open(follow.file, 'r'); } catch { return; }
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      while (!follow.stopped && follow.position < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, info.size - follow.position), follow.position);
        if (!bytesRead) break;
        follow.position += bytesRead;
        const read = buffer.subarray(0, bytesRead);
        follow.fingerprint = Buffer.concat([follow.fingerprint, read.subarray(Math.max(0, bytesRead - FINGERPRINT))]).subarray(-FINGERPRINT);
        follow.reader.write(read);
      }
    } finally { await handle.close(); }
  }

  private async readAt(file: string, position: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    let handle;
    try { handle = await open(file, 'r'); } catch { return Buffer.alloc(0); }
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }

  private async lineStartNear(file: string, offset: number): Promise<number> {
    if (offset === 0) return 0;
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      for (let position = offset - 1; ; position += CHUNK) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
        if (!bytesRead) return position;
        const newline = buffer.subarray(0, bytesRead).indexOf(10);
        if (newline !== -1) return position + newline + 1;
      }
    } finally { await handle.close(); }
  }

  private finish(follow: Follow): void {
    if (follow.stopped) return;
    // Deliver everything already read before refusing further lines.
    follow.reader.end();
    follow.joiner?.end();
    follow.stopped = true;
    clearInterval(follow.poll);
    follow.watcher?.close();
    this.follows.delete(follow.record.id);
    follow.record.status = 'exited';
    follow.record.endedAt = Date.now();
    follow.record.captureComplete = true;
    follow.record.exitReason = 'stopped following';
    this.state.status = this.follows.size ? 'Running' : `Stopped following ${path.basename(follow.file)}`;
    this.registry.pruneSessionRegistry();
    this.state.notify();
  }
}
