import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseViewRequest } from './messages';

test('message boundary rejects invalid actions and source coordinates', () => {
  for (const value of [
    null,
    [],
    'run',
    { type: 'unknown' },
    { type: 'openSource', id: 1, block: -1, line: 0 },
    { type: 'context', id: '1' },
    { type: 'copy', id: NaN },
    { type: 'exportContext', ids: '1,2' },
    { type: 'aiCall', traceId: 'abc' },
    { type: 'aiCall', traceId: 'abc', spanId: '../x' },
    { type: 'copyAiCall', traceId: 1, spanId: 'b' },
  ]) {
    assert.equal(parseViewRequest(value), undefined);
  }
  assert.deepEqual(parseViewRequest({ type: 'aiCall', traceId: 'abc', spanId: 'def', extra: 1 }), {
    type: 'aiCall',
    traceId: 'abc',
    spanId: 'def',
  });
  assert.deepEqual(parseViewRequest({ type: 'aiCalls', limit: 5 }), { type: 'aiCalls' });
  assert.deepEqual(parseViewRequest({ type: 'doctorAction', action: 'fix', siteId: 'a.ts\u00001', extra: 1 }), {
    type: 'doctorAction',
    action: 'fix',
    siteId: 'a.ts\u00001',
  });
  assert.deepEqual(parseViewRequest({ type: 'doctorAction', action: 'report' }), {
    type: 'doctorAction',
    action: 'report',
  });
  assert.equal(
    (parseViewRequest({ type: 'snapshot', doctorRevision: 4 }) as { doctorRevision?: number }).doctorRevision,
    4,
  );
  assert.equal(
    (parseViewRequest({ type: 'snapshot', doctorRevision: -1 }) as { doctorRevision?: number }).doctorRevision,
    undefined,
  );
  assert.equal(
    parseViewRequest({ type: 'doctorAction', action: 'fix' }),
    undefined,
    'a statement action needs a statement',
  );
  assert.equal(parseViewRequest({ type: 'doctorAction', action: 'delete', siteId: 'a' }), undefined);
  assert.deepEqual(
    parseViewRequest({ type: 'openSource', id: 1, block: 0, line: 2, file: '/tmp/other', command: 'run' }),
    { type: 'openSource', id: 1, block: 0, line: 2 },
  );
  assert.deepEqual(
    parseViewRequest({ type: 'copyFiltered', query: 'status:500', levels: ['error'], serverId: 'api' }),
    { type: 'copyFiltered', query: 'status:500', levels: ['error'], serverId: 'api' },
  );
  assert.deepEqual(parseViewRequest({ type: 'stop', serverId: 'api', sessionId: 'run-1', ignored: true }), {
    type: 'stop',
    serverId: 'api',
    sessionId: 'run-1',
  });
  assert.equal(parseViewRequest({ type: 'stop', sessionId: 42 })?.type, 'stop');
  assert.equal((parseViewRequest({ type: 'stop', sessionId: 42 }) as { sessionId?: string }).sessionId, undefined);
  assert.deepEqual(parseViewRequest({ type: 'showGuide', section: 'whatsNew', ignored: true }), {
    type: 'showGuide',
    section: 'whatsNew',
  });
  assert.deepEqual(parseViewRequest({ type: 'showGuide', section: 'unknown' }), {
    type: 'showGuide',
    section: 'guide',
  });
  assert.deepEqual(parseViewRequest({ type: 'traces', limit: 5 }), { type: 'traces' });
  assert.deepEqual(parseViewRequest({ type: 'breakOnEvent', id: 7 }), { type: 'breakOnEvent', id: 7 });
  assert.equal(parseViewRequest({ type: 'breakOnEvent', id: -1 }), undefined);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        parseViewRequest({ type: 'breakOnQuery', query: 'level:error', levels: ['error', 3], serverId: 'api' }),
      ),
    ),
    { type: 'breakOnQuery', query: 'level:error', levels: ['error'] },
  );
});

test('message boundary preserves an empty level selection and normalizes pagination', () => {
  const request = parseViewRequest({
    type: 'snapshot',
    levels: [],
    page: -3,
    before: Infinity,
    statsOnly: 'yes',
    columns: ['service', null],
    sortDirection: 'other',
    query: 42,
  });
  assert.ok(request?.type === 'snapshot');
  assert.deepEqual(request.levels, []);
  assert.deepEqual(request.columns, ['service']);
  assert.equal(request.page, undefined);
  assert.equal(request.before, undefined);
  assert.equal(request.statsOnly, false);
  assert.equal(request.query, undefined);
  assert.equal(request.sortDirection, 'asc');
  const requestWithId = parseViewRequest({ type: 'snapshot', requestId: 9 });
  assert.equal(requestWithId?.type === 'snapshot' ? requestWithId.requestId : undefined, 9);
  assert.deepEqual(parseViewRequest({ type: 'exportContext', ids: [1, '2', -3, 4.5, 5] }), {
    type: 'exportContext',
    ids: [1, 5],
  });
});

test('connection requests need a connection id, and bound their query and range', () => {
  for (const value of [
    { type: 'connectionFetch', query: 'level:error', range: '1h' },
    { type: 'connectionPreview', connectionId: '', query: '' },
    { type: 'connectionTail', connectionId: 7 },
    { type: 'connectionSql' },
  ])
    assert.equal(parseViewRequest(value), undefined, JSON.stringify(value));
  assert.deepEqual(
    parseViewRequest({ type: 'connectionFetch', connectionId: 'app', query: 'level:error', range: '24h' }),
    {
      type: 'connectionFetch',
      connectionId: 'app',
      query: 'level:error',
      range: '24h',
    },
  );
  // An unknown range falls back to the last hour; a long query is cut to the search limit.
  assert.deepEqual(
    parseViewRequest({ type: 'connectionPreview', connectionId: 'app', query: 'x'.repeat(2000), range: 'constructor' }),
    { type: 'connectionPreview', connectionId: 'app', query: 'x'.repeat(1024), range: '1h' },
  );
  assert.deepEqual(parseViewRequest({ type: 'connectionTail', connectionId: 'app', enabled: 'yes' }), {
    type: 'connectionTail',
    connectionId: 'app',
    query: '',
    enabled: false,
  });
  assert.deepEqual(parseViewRequest({ type: 'connectionSql', connectionId: 'app', query: 'ignored' }), {
    type: 'connectionSql',
    connectionId: 'app',
  });
  assert.deepEqual(parseViewRequest({ type: 'addConnection', extra: true }), { type: 'addConnection' });
});
