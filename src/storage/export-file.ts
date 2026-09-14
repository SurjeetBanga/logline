import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';

export const PROVIDER_EXPORT_LIMIT = 16 * 1024 * 1024;

/** Stage local writes beside the destination; cancellation/errors preserve the existing file. */
export async function writeExportFile(file: string | undefined, chunks: AsyncIterable<Uint8Array>,
  cancelled: () => boolean, writeProvider: (bytes: Uint8Array) => PromiseLike<void>): Promise<void> {
  const check = () => { if (cancelled()) throw new Error('Export cancelled.'); };
  check();
  if (file === undefined) {
    const buffers: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of chunks) {
      check(); bytes += chunk.byteLength;
      if (bytes > PROVIDER_EXPORT_LIMIT) throw new Error('This filesystem provider requires a whole-file write. Export exceeds 16 MiB; choose a local file or narrow the filter.');
      buffers.push(chunk);
    }
    check();
    await writeProvider(Buffer.concat(buffers, bytes));
    return;
  }
  const directory = await mkdtemp(path.join(path.dirname(file), '.logline-export-'));
  try {
    const staged = path.join(directory, 'logs');
    const handle = await open(staged, 'wx', 0o600);
    try {
      for await (const chunk of chunks) { check(); await handle.writeFile(chunk); }
    } finally { await handle.close(); }
    check();
    await rename(staged, file);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
