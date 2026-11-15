import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewerState } from './state';

test('resume clears paging and sorting but keeps the selected event, filters and column preferences', () => {
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
  assert.equal(state.before, undefined);
  assert.equal(state.page, 0);
  assert.equal(state.selected, 42, 'the inspected event stays open while live logs resume');
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

test('inspect selects an event without freezing the result set, and choosing it again clears it', () => {
  const state = new ViewerState();
  state.newest = 50;
  assert.equal(state.following, true);
  assert.equal(state.inspect(7), true);
  assert.equal(state.selected, 7);
  assert.equal(state.following, true, 'live logs keep arriving');
  assert.equal(state.before, undefined, 'no history boundary is fixed');
  assert.equal('paused' in state, false);
  assert.equal(state.inspect(8), true);
  assert.equal(state.selected, 8);
  assert.equal(state.inspect(8), false);
  assert.equal(state.selected, undefined);
});

test('the inspector width is restored when valid and persisted only once set', () => {
  assert.equal(new ViewerState().inspectorWidth, undefined);
  assert.equal(new ViewerState().persist('').inspectorWidth, undefined);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '500'])
    assert.equal(new ViewerState({ inspectorWidth: bad as number }).inspectorWidth, undefined, String(bad));
  const state = new ViewerState({ inspectorWidth: 520, railWidth: 300 });
  assert.equal(state.inspectorWidth, 520);
  assert.equal(state.railWidth, 300);
  assert.equal(state.persist('').inspectorWidth, 520);
  state.inspectorWidth = undefined;
  assert.equal(state.persist('').inspectorWidth, undefined);
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
  const inspecting = new ViewerState();
  inspecting.inspect(3);
  inspecting.sort('message');
  assert.equal(inspecting.following, false, 'sorting stops following even with an event open');
  assert.equal(inspecting.selected, 3);
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

test('hiding only Unclassified survives a reload, while a pre-1.8 "all levels" preference still gains it', () => {
  const six = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const state = new ViewerState();
  state.checkedLevels.delete('unclassified');
  assert.deepEqual([...new ViewerState(state.persist('')).checkedLevels], six);
  assert.equal(new ViewerState({ levels: six }).checkedLevels.has('unclassified'), true);
  state.checkedLevels.delete('trace');
  assert.equal(state.persist('').unclassifiedHidden, undefined);
});
