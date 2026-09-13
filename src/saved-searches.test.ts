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
