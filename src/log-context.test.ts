import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStore } from './log-store';

test('context includes hidden levels and both streams, excluding other sessions and servers', () => {
  const store = new LogStore(100);
  for (let id = 1; id <= 9; id++) store.add({ id, serverId: id === 4 ? 'worker' : 'api',
    sessionId: id === 6 ? 'previous' : 'current', level: id === 5 ? 'error' : 'debug',
    stream: id % 2 ? 'stderr' : 'stdout', message: id === 5 ? 'Failed' : 'Preparing', raw: 'private raw data' });
  assert.deepEqual(store.page({ query: 'Failed', levels: ['error'] }).events.map(event => event.id), [5]);
  assert.deepEqual(store.context(5).events.map(event => event.id), [1, 2, 3, 5, 7, 8, 9]);
  assert.ok(store.context(5).events.every(event => event.raw === undefined));
});

test('context returns at most 25 neighbours on each side across a wrapped retention ring', () => {
  const store = new LogStore(80);
  for (let id = 1; id <= 200; id++) store.add({ id, level: 'info', serverId: 'api', sessionId: 'run' });
  assert.deepEqual(store.context(160).events.map(event => event.id), Array.from({ length: 51 }, (_, i) => i + 135));
  assert.deepEqual(store.context(121).events.map(event => event.id), Array.from({ length: 26 }, (_, i) => i + 121));
  assert.deepEqual(store.context(200).events.map(event => event.id), Array.from({ length: 26 }, (_, i) => i + 175));
  assert.deepEqual(store.context(120), { events: [], missing: true });
  store.clear();
  assert.equal(store.context(160).missing, true);
});

test('missing session IDs do not mix with identified sessions', () => {
  const store = new LogStore(10);
  store.add({ id: 1, level: 'info', serverId: 'imported' });
  store.add({ id: 2, level: 'info', serverId: 'imported', sessionId: 'run' });
  store.add({ id: 3, level: 'info', serverId: 'imported' });
  assert.deepEqual(store.context(1).events.map(event => event.id), [1]);
});
