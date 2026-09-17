import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SavedSearches } from './storage/saved-searches';

test('saveSearch dedupes by query and server, caps history at 50, and falls back to the query as a name', () => {
  const searches = new SavedSearches({ get: (_key, fallback) => fallback, update() { } });
  const first = searches.saveSearch(undefined, 'status:500', ['error'], 'api')!;
  assert.equal(first.name, 'status:500');
  const renamed = searches.saveSearch('Server errors', 'status:500', ['error'], 'api')!;
  assert.equal(searches.savedSearches().length, 1, 'saving the same query/server again replaces the old entry');
  assert.equal(renamed.name, 'Server errors');
  searches.saveSearch('Other server', 'status:500', ['error'], 'worker');
  assert.equal(searches.savedSearches().length, 2, 'the same query against a different server is a distinct entry');
  for (let i = 0; i < 60; i++) searches.saveSearch(undefined, `q${i}`);
  assert.equal(searches.savedSearches().length, 50);
  assert.equal(searches.saveSearch(undefined, '   '), undefined, 'a blank query with no server is not worth saving');
});

test('deleteSavedSearch removes only the matching entry', () => {
  const searches = new SavedSearches({ get: (_key, fallback) => fallback, update() { } });
  const a = searches.saveSearch(undefined, 'a')!;
  searches.saveSearch(undefined, 'b');
  searches.deleteSavedSearch(a.id);
  assert.deepEqual(searches.savedSearches().map(search => search.query), ['b']);
});

test('saved searches retain distinct level filters, including level-only and empty selections', () => {
  const searches = new SavedSearches({ get: (_key, fallback) => fallback, update() { } });
  searches.saveSearch('Errors', '', ['error']);
  searches.saveSearch('No levels', '', []);
  searches.saveSearch('Warnings', 'service:api', ['warn']);
  searches.saveSearch('Errors and warnings', 'service:api', ['error', 'warn']);
  searches.saveSearch('Renamed', 'service:api', ['warn', 'error', 'error']);
  assert.equal(searches.savedSearches().length, 4);
  assert.equal(searches.savedSearches()[0].name, 'Renamed');
});

test('malformed persisted searches are ignored and loaded entries stay bounded', () => {
  const values = [null, { id: 'broken', levels: 'error' }, { id: 'bad-name', name: {}, query: 'x' },
    ...Array.from({ length: 60 }, (_, id) => ({ id: String(id), name: 'n'.repeat(100), query: 'q'.repeat(300), levels: ['error'] }))];
  const searches = new SavedSearches({ get: <T>() => values as T, update() {} });
  const saved = searches.savedSearches();
  assert.equal(saved.length, 50);
  assert.equal(saved[0].name.length, 80);
  assert.equal(saved[0].query.length, 256);
  assert.equal(saved[0].createdAt, 0);
  assert.doesNotThrow(() => searches.saveSearch('next', 'query'));
});

test('persisted searches retain the unclassified level', () => {
  const values = [{ id: '1', name: 'Plain text', query: '', levels: ['unclassified'], createdAt: 1, lastUsedAt: 1 }];
  const searches = new SavedSearches({ get: <T>() => values as T, update() { } });
  assert.deepEqual(searches.savedSearches()[0].levels, ['unclassified']);
});
