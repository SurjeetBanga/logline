import { promises as fs } from 'node:fs';

const CHUNK = 1024 * 1024;

/**
 * Follows one growing file of lines, such as an agent's session file: each
 * read returns only the whole lines appended since the last one. A file that
 * shrank was rewritten, so it is read again from its start.
 */
export class JsonlTail {
  offset = 0;
  /** The start of a line whose end has not been written yet. */
  private partial = Buffer.alloc(0);

  constructor(readonly file: string) {}

  /** Read up to `budget` bytes of what was appended, passing each whole line on; returns how many bytes were read. */
  async read(budget: number, onLine: (line: string) => void): Promise<number> {
    let handle: fs.FileHandle | undefined;
    let read = 0;
    try {
      handle = await fs.open(this.file, 'r');
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
      }
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(0, size - this.offset)));
      while (this.offset < size && read < budget) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        read += bytesRead;
        const data = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(0x0a);
        this.partial = Buffer.from(data.subarray(end + 1));
        if (end < 0) continue;
        for (const line of data.toString('utf8', 0, end).split('\n')) onLine(line);
      }
    } catch {
      /* removed or unreadable: the caller's next scan drops it */
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return read;
  }
}

/** The entries of a folder, or none when it cannot be read. */
export async function listFolder(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}
