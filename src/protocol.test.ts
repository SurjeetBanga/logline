import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseViewRequest } from './protocol/messages';

test('message boundary rejects invalid actions and source coordinates', () => {
  for (const value of [null, [], 'run', { type: 'unknown' }, { type: 'openSource', id: 1, block: -1, line: 0 },
    { type: 'context', id: '1' }, { type: 'copy', id: NaN }, { type: 'exportContext', ids: '1,2' }]) {
    assert.equal(parseViewRequest(value), undefined);
  }
  assert.deepEqual(parseViewRequest({ type: 'openSource', id: 1, block: 0, line: 2, file: '/tmp/other', command: 'run' }),
    { type: 'openSource', id: 1, block: 0, line: 2 });
  assert.deepEqual(parseViewRequest({ type: 'copyFiltered', query: 'status:500', levels: ['error'], serverId: 'api' }),
    { type: 'copyFiltered', query: 'status:500', levels: ['error'], serverId: 'api' });
  assert.deepEqual(parseViewRequest({ type: 'showGuide', section: 'whatsNew', ignored: true }),
    { type: 'showGuide', section: 'whatsNew' });
  assert.deepEqual(parseViewRequest({ type: 'showGuide', section: 'unknown' }),
    { type: 'showGuide', section: 'guide' });
});

test('message boundary preserves an empty level selection and normalizes pagination', () => {
  const request = parseViewRequest({
    type: 'snapshot', levels: [], page: -3, before: Infinity, statsOnly: 'yes',
    columns: ['service', null], sortDirection: 'other', query: 42
  });
  assert.ok(request?.type === 'snapshot');
  assert.deepEqual(request.levels, []);
  assert.deepEqual(request.columns, ['service']);
  assert.equal(request.page, undefined);
  assert.equal(request.before, undefined);
  assert.equal(request.statsOnly, false);
  assert.equal(request.query, undefined);
  assert.equal(request.sortDirection, 'asc');
  assert.deepEqual(parseViewRequest({ type: 'exportContext', ids: [1, '2', -3, 4.5, 5] }), { type: 'exportContext', ids: [1, 5] });
});
