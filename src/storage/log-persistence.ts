import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Settings } from '../core/settings';

const PERSIST_FLUSH_MS = 250;
const PERSIST_MAX_BUFFER = 2000;
const PERSIST_BATCH_BYTES = 256 * 1024;
const PERSIST_QUEUE_BYTES = 8 * 1024 * 1024;

export class LogPersistence {
  pendingWrites: string[] = [];
  pendingWriteBytes = 0;
  queuedWriteBytes = 0;
  persistDropped = 0;
  persistTimer: ReturnType<typeof setTimeout> | undefined;
  persistedBytes: number | undefined;
  persistChain: Promise<void> | undefined;
  constructor(private readonly config: Settings, private readonly workspaceFolder: () => string | undefined,
    private readonly warn: (message: string) => void) { }
  invalidate(): void { this.persistedBytes = undefined; }
  async dispose(): Promise<void> { this.flushPersist(); await this.persistChain; }
  persist(line: string): void {
    if (!this.config?.get('persistLogs', false)) return;
    // Count estimated UTF-16 storage, including pending and in-flight batches.
    // Drop new disk-only writes on overload; capture and existing writes continue.
    const bytes = (line.length + 1) * 2;
    if (this.queuedWriteBytes + bytes > PERSIST_QUEUE_BYTES) {
      if (this.persistDropped++ === 0) {
        void this.warn('Logline disk writes are falling behind. New disk writes are being skipped while the 8 MiB queue is full; live capture continues. The Logs footer shows the skipped count.');
      }
      return;
    }
    this.queuedWriteBytes += bytes;
    this.pendingWriteBytes += bytes;
    this.pendingWrites.push(line);
    if (this.pendingWrites.length >= PERSIST_MAX_BUFFER || this.pendingWriteBytes >= PERSIST_BATCH_BYTES) { this.flushPersist(); return; }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushPersist(), PERSIST_FLUSH_MS);
    this.persistTimer.unref?.();
  }

  flushPersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.pendingWrites.length) return;
    const batch = this.pendingWrites.join('\n') + '\n';
    const bytes = this.pendingWriteBytes;
    this.pendingWrites.length = 0;
    this.pendingWriteBytes = 0;
    this.persistChain = (this.persistChain ?? Promise.resolve())
      .then(() => this.writeBatch(batch))
      .finally(() => { this.queuedWriteBytes -= bytes; });
  }

  async writeBatch(batch: string): Promise<void> {
    const folder = this.workspaceFolder();
    if (!folder) return;
    const file = path.join(folder, '.logline', 'latest.log');
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const max = this.config.get('maxDiskMb', 1000) * 1024 * 1024;
      // Roll to latest.log.1 rather than discarding history outright.
      if (this.persistedBytes === undefined) {
        this.persistedBytes = (await stat(file).catch(() => undefined))?.size ?? 0;
      }
      const size = Buffer.byteLength(batch);
      if (this.persistedBytes > 0 && this.persistedBytes + size > max) {
        await rename(file, file + '.1');
        this.persistedBytes = 0;
      }
      await appendFile(file, batch, 'utf8');
      this.persistedBytes += size;
    } catch { /* persistence must not interrupt ingestion */ }
  }
}
