import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewerState } from './state';

test('resume clears inspection and sorting while preserving filters and column preferences', () => {
  const state = new ViewerState({
    server: 'api',
    levels: ['error'],
    sort: 'message',
    columnOrder: ['base:message'],
    extraColumns: ['service'],
  });
  state.newest = 80;
  state.setFollowing(false);
  state.page = 3;
  state.inspect(42);
  state.resume();
  assert.equal(state.following, true);
  assert.equal(state.paused, false);
  assert.equal(state.before, undefined);
  assert.equal(state.page, 0);
  assert.equal(state.selected, undefined);
  assert.equal(state.selectedSort, '');
  assert.deepEqual(state.persist('timeout'), {
    query: 'timeout',
    server: 'api',
    levels: ['error'],
    sort: '',
    sortDirection: 'desc',
    columnWidths: {},
    columnOrder: ['base:message'],
    hiddenColumns: [],
    extraColumns: ['service'],
  });
});

test('sort switches to a fixed capture boundary and toggles the same field', () => {
  const state = new ViewerState();
  state.newest = 12;
  state.sort('message');
  assert.equal(state.following, false);
  assert.equal(state.before, 12);
  assert.equal(state.selectedSortDirection, 'desc');
  state.sort('message');
  assert.equal(state.selectedSortDirection, 'asc');
  state.sort('level');
  assert.equal(state.selectedSortDirection, 'desc');
  state.checkedLevels.clear();
  assert.deepEqual(state.currentLevels(), []);
});

test('a query typed in a store’s own syntax is kept per kind of connection, and one saved for Datadog carries over', () => {
  const state = new ViewerState({ datadogQuery: 'service:checkout', datadogSyntax: true });
  assert.deepEqual(state.nativeOf('datadog'), { query: 'service:checkout', on: true });
  assert.deepEqual(state.nativeOf('postgres'), { query: '', on: false });
  assert.deepEqual(state.persist('').native, { datadog: { query: 'service:checkout', on: true } });
  state.setNative('datadog', { on: false });
  assert.deepEqual(state.persist('').native, { datadog: { query: 'service:checkout' } });
  state.setNative('datadog', { query: '' });
  assert.equal(state.persist('').native, undefined);
  // What is saved under the new name wins over the old one.
  const both = new ViewerState({ datadogQuery: 'old', native: { datadog: { query: 'new' } } });
  assert.equal(both.nativeOf('datadog').query, 'new');
});
