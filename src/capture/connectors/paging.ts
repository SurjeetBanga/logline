import type { RemoteRecord } from './types';

/**
 * Read pages of logs until `limit` or the last page. When `firstPage` is
 * given and the limit asks for more than `firstPageSize`, the first page is
 * that small and is shown as soon as it arrives, if more follow.
 */
export async function readPages<Cursor>(options: {
  limit: number;
  pageSize: number;
  firstPageSize: number;
  firstPage?(records: RemoteRecord[]): void;
  /** Called once, after the first page that has more after it. */
  onMore?(): void;
  fetchPage(size: number, cursor: Cursor | undefined): Promise<{ records: RemoteRecord[]; next?: Cursor }>;
}): Promise<RemoteRecord[]> {
  const records: RemoteRecord[] = [];
  let cursor: Cursor | undefined;
  let early = options.firstPage !== undefined && options.limit > options.firstPageSize;
  let more = false;
  do {
    const size = Math.min(early ? options.firstPageSize : options.pageSize, options.limit - records.length);
    const page = await options.fetchPage(size, cursor);
    records.push(...page.records);
    cursor = page.records.length ? page.next : undefined;
    if (cursor !== undefined && !more) {
      more = true;
      options.onMore?.();
    }
    // Only a first page with more to follow is worth showing early.
    if (early && cursor !== undefined) options.firstPage!([...records]);
    early = false;
  } while (cursor !== undefined && records.length < options.limit);
  return records;
}
