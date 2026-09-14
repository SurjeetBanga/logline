import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeQuery } from './core/query-completion';
import { matchesQuery } from './core/query';
import { LogStore } from './core/log-store';

test('completion preserves preceding terms, negation, and quoted values including escaped quotes', () => {
  assert.deepEqual(completeQuery('level:error -ser', ['service'], []), ['level:error -service:']);
  for (const value of ['API west', 'say "hello"', 'c:\\work\\app', '/^literal$/']) {
    const [query] = completeQuery('level:error service:', [], [{ value }]);
    assert.equal(matchesQuery({ id: 1, level: 'error', fields: { service: value } }, query), true);
    assert.equal(matchesQuery({ id: 2, level: 'info', fields: { service: value } }, query), false);
  }
  assert.deepEqual(completeQuery('service:"API west" ', ['status'], []), ['service:"API west" status:']);
});

test('value suggestions read only the selected server index and handle an incomplete quoted value', () => {
  const store = new LogStore();
  store.add({ id: 1, level: 'info', serverId: 'api', fields: { service: 'API west' } });
  store.add({ id: 2, level: 'info', serverId: 'worker', fields: { service: 'worker' } });
  Object.defineProperty(store.find(2)!.fields!, 'service', { get() { throw new Error('Unrelated server read'); } });
  assert.deepEqual(store.fieldSuggestions('level:info service:"API w', 'API').values, [{ value: 'API west', count: 1 }]);
});
