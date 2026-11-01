import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPages } from './paging';

// A store of `total` logs, read in pages, that records the size each page asked for.
function store(total: number) {
  const sizes: number[] = [];
  return {
    sizes,
    fetchPage: async (size: number, cursor: number | undefined) => {
      sizes.push(size);
      const start = cursor ?? 0;
      const end = Math.min(total, start + size);
      const records = Array.from({ length: end - start }, (_, index) => ({ line: String(start + index) }));
      return { records, ...(end < total ? { next: end } : {}) };
    },
  };
}

test('pages are read until the limit, with a small first page shown early', async () => {
  const pages = store(25);
  const shown: number[] = [];
  let more = 0;
  const records = await readPages({
    limit: 22,
    pageSize: 10,
    firstPageSize: 2,
    firstPage: (early) => shown.push(early.length),
    onMore: () => more++,
    fetchPage: pages.fetchPage,
  });
  assert.equal(records.length, 22);
  assert.deepEqual(pages.sizes, [2, 10, 10]);
  assert.deepEqual(shown, [2]);
  assert.equal(more, 1);
});

test('a first page with nothing after it is not shown early, and reading stops at the last page', async () => {
  const pages = store(2);
  const shown: number[] = [];
  const records = await readPages({
    limit: 100,
    pageSize: 10,
    firstPageSize: 5,
    firstPage: (early) => shown.push(early.length),
    fetchPage: pages.fetchPage,
  });
  assert.equal(records.length, 2);
  assert.deepEqual(shown, []);
  // Without firstPage, or with a limit the first page covers, every page is full size.
  const full = store(30);
  await readPages({ limit: 30, pageSize: 10, firstPageSize: 5, fetchPage: full.fetchPage });
  assert.deepEqual(full.sizes, [10, 10, 10]);
});

test('an empty page ends reading even when the store offers another cursor', async () => {
  let calls = 0;
  const records = await readPages({
    limit: 10,
    pageSize: 5,
    firstPageSize: 1,
    fetchPage: async () => {
      calls++;
      return { records: [], next: 'again' };
    },
  });
  assert.deepEqual(records, []);
  assert.equal(calls, 1);
});
