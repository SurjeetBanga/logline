import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentAccessError, AgentLogAccess } from './vscode/agent-access';
import { LogStore } from './core/log-store';
import { SessionRegistry } from './capture/session-registry';

function fixture() {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', server: 'API', sessionId: 'a', level: 'error', message: 'token: secret', raw: '{"level":"error","token":"secret"}' });
  store.add({ id: 2, serverId: 'web', server: 'Web', sessionId: 'w', level: 'info', message: 'private', raw: '{"message":"private"}' });
  return { store, access: new AgentLogAccess(store, new SessionRegistry(), () => 2) };
}

test('agent access requires an explicit source grant and redacts results', () => {
  const { access } = fixture();
  assert.throws(() => access.list(), (error: unknown) => error instanceof AgentAccessError && error.code === 'NOT_SHARED');
  const share = access.share(['api']);
  const result = access.search({ shareId: share.shareId!, query: '' });
  assert.equal(result.events.length, 1);
  assert.doesNotMatch(result.events[0].raw!, /secret/);
  assert.throws(() => access.search({ shareId: share.shareId!, sourceIds: ['web'] }), (error: unknown) => error instanceof AgentAccessError && error.code === 'NOT_SHARED');
});

test('agent chats discover shared runs without a handoff and lose access after sharing stops', () => {
  const { access } = fixture();
  access.share(['api']);
  const discovered = access.list();
  assert.equal(discovered.active, true);
  assert.deepEqual(discovered.sources.map(source => source.id), ['api']);
  assert.equal(access.search({ shareId: discovered.shareId! }).events.length, 1);
  access.revoke();
  assert.throws(() => access.list(), (error: unknown) => error instanceof AgentAccessError && error.code === 'NOT_SHARED');
  assert.throws(() => access.search({ shareId: discovered.shareId! }), (error: unknown) => error instanceof AgentAccessError && error.code === 'NOT_SHARED');
});

test('agent cursors are bound to the active share revision', () => {
  const { access } = fixture();
  const first = access.share(['api']);
  const result = access.search({ shareId: first.shareId!, limit: 1 });
  access.share(['api']);
  assert.throws(() => access.search({ shareId: first.shareId!, cursor: result.nextCursor }), (error: unknown) => error instanceof AgentAccessError && error.code === 'SHARE_CHANGED');
});

test('agent cursors are bound to their search filters', () => {
  const { access } = fixture();
  const share = access.share(['api']);
  const result = access.search({ shareId: share.shareId!, limit: 1 });
  assert.equal(result.nextCursor, undefined);
  // A multi-event source produces a continuation cursor with the same grant.
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', level: 'info', message: 'one' });
  store.add({ id: 2, serverId: 'api', level: 'info', message: 'two' });
  const access2 = new AgentLogAccess(store, new SessionRegistry(), () => 2);
  const share2 = access2.share(['api']);
  const page = access2.search({ shareId: share2.shareId!, limit: 1 });
  assert.ok(page.nextCursor);
  assert.throws(() => access2.search({ shareId: share2.shareId!, query: 'two', cursor: page.nextCursor }), (error: unknown) => error instanceof AgentAccessError && error.code === 'SHARE_CHANGED');
});

test('agent grants are scoped to selected runs and exclude later runs', () => {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', sessionId: 'run-a', level: 'error', message: 'first' });
  store.add({ id: 2, serverId: 'api', sessionId: 'run-b', level: 'error', message: 'later' });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 2);
  const share = access.share(['api'], undefined, ['run-a']);
  assert.deepEqual(access.search({ shareId: share.shareId!, limit: 10 }).events.map(event => event.message), ['first']);
  assert.throws(() => access.inspect(share.shareId!, 2), (error: unknown) => error instanceof AgentAccessError && error.code === 'EVENT_UNAVAILABLE');
});

test('agent search stays bounded for large retained stores and returns a cursor', () => {
  const store = new LogStore(200_000, 200 * 1024 * 1024);
  for (let id = 1; id <= 150_000; id++) store.add({ id, serverId: 'api', sessionId: 'run', level: 'info', message: 'line' });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 150_000);
  const share = access.share(['api']);
  const result = access.search({ shareId: share.shareId!, limit: 1 });
  assert.equal(result.matched, 150_000);
  assert.equal(result.events.length, 1);
  assert.ok(result.nextCursor);
});

test('agent pagination merges sources newest-first with opaque per-source cursors', () => {
  const store = new LogStore();
  for (const [id, source] of [[1, 'api'], [2, 'web'], [3, 'api'], [4, 'web'], [5, 'api'], [6, 'web']] as const)
    store.add({ id, serverId: source, sessionId: source, level: 'info', message: String(id) });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 6);
  const share = access.shareAll();
  const first = access.search({ shareId: share.shareId!, limit: 2 });
  const second = access.search({ shareId: share.shareId!, limit: 2, cursor: first.nextCursor });
  const third = access.search({ shareId: share.shareId!, limit: 2, cursor: second.nextCursor });
  assert.deepEqual(first.events.map(event => event.id), [6, 5]);
  assert.deepEqual(second.events.map(event => event.id), [4, 3]);
  assert.deepEqual(third.events.map(event => event.id), [2, 1]);
  assert.equal(first.matched, 6);
  assert.equal(third.hasMore, false);
});

test('agent session filters use indexed counts and analyze only the newest 10,000 matches', () => {
  const store = new LogStore(20_000, 100 * 1024 * 1024);
  for (let id = 1; id <= 12_000; id++) {
    store.add({ id, serverId: id % 2 ? 'api' : 'web', sessionId: id % 3 ? 'run-a' : 'run-b', level: 'info', message: `event ${id}` });
  }
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 12_000);
  const share = access.shareAll();
  const filtered = access.search({ shareId: share.shareId!, sessionIds: ['run-b'], limit: 200 });
  assert.ok(filtered.events.every(event => event.sessionId === 'run-b'));
  assert.equal(filtered.matched, 4_000);
  const analysis = access.analyze({ shareId: share.shareId! }) as { coverage: { matched: number; analyzed: number; limited: boolean } };
  assert.deepEqual(analysis.coverage, { matched: 12_000, analyzed: 10_000, limited: true });
});

test('agent redaction applies configured fields to metadata and payloads', () => {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', sessionId: 'run', server: 'customer=acme-secret', level: 'info', message: 'customer=acme-secret', raw: '{"customer":"acme-secret"}' });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 1, { fields: ['customer'] });
  const share = access.share(['api']);
  const result = access.search({ shareId: share.shareId! });
  assert.doesNotMatch(result.events[0].server ?? '', /acme-secret/);
  assert.doesNotMatch(result.events[0].message ?? '', /acme-secret/);
  assert.doesNotMatch(result.events[0].raw ?? '', /acme-secret/);
});


test('all sharing discovers new runs and sources without changing the grant', () => {
  const store = new LogStore();
  let newest = 0;
  const access = new AgentLogAccess(store, new SessionRegistry(), () => newest);
  const share = access.shareAll();
  assert.equal(share.active, true);
  assert.deepEqual(access.search({ shareId: share.shareId! }).events, []);
  for (const [source, run] of [['api', 'a'], ['api', 'b'], ['web', 'w']]) {
    store.add({ id: ++newest, serverId: source, sessionId: run, level: 'error', message: 'token: secret' });
  }
  const status = access.list();
  assert.equal(status.shareId, share.shareId);
  assert.equal(status.revision, share.revision);
  assert.deepEqual(status.sources.flatMap(source => source.runs.map(run => run.id)).sort(), ['a', 'b', 'w']);
  const result = access.search({ shareId: share.shareId! });
  assert.deepEqual(result.events.map(event => event.id), [3, 2, 1]);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.doesNotMatch(JSON.stringify(access.inspect(share.shareId!, 3)), /secret/);
  const analysis = access.analyze({ shareId: share.shareId! }) as { coverage: { matched: number } };
  assert.equal(analysis.coverage.matched, 3);
  access.revoke();
  store.add({ id: ++newest, serverId: 'web', sessionId: 'next', level: 'info' });
  assert.equal(access.isSharedSource('web'), false);
  assert.throws(() => access.inspect(share.shareId!, 3), AgentAccessError);
});

test('all sharing waits for a newly captured source and preserves pagination as sources arrive', async () => {
  const store = new LogStore();
  let newest = 0;
  const access = new AgentLogAccess(store, new SessionRegistry(), () => newest);
  const shareId = access.shareAll().shareId!;
  const waiting = access.wait({ shareId }, 0, 1000);
  store.add({ id: ++newest, serverId: 'api', sessionId: 'a', level: 'info' });
  assert.deepEqual((await waiting).events.map(event => event.id), [1]);
  store.add({ id: ++newest, serverId: 'api', sessionId: 'a', level: 'info' });
  const page = access.search({ shareId, limit: 1 });
  assert.ok(page.nextCursor);
  store.add({ id: ++newest, serverId: 'web', sessionId: 'w', level: 'info' });
  assert.deepEqual(access.search({ shareId, cursor: page.nextCursor }).events.map(event => event.id), [1]);
});

test('agent waits preserve byte truncation metadata', async () => {
  const store = new LogStore(20, 20 * 1024 * 1024);
  for (let id = 1; id <= 10; id++) store.add({ id, serverId: 'api', sessionId: 'run', level: 'info', raw: 'x'.repeat(20_000) });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 10);
  const shareId = access.shareAll().shareId!;
  const result = await access.wait({ shareId }, 0, 100);
  assert.ok(result.events.length < 10);
  assert.equal(result.partial, true);
  assert.equal(result.hasMore, true);
});

test('narrowing all sharing to a run excludes later runs and cannot be bypassed with sessionId', () => {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', sessionId: 'a', level: 'info' });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 3);
  const all = access.shareAll();
  const selected = access.share(['api'], undefined, ['a']);
  store.add({ id: 2, serverId: 'api', sessionId: 'b', level: 'info' });
  store.add({ id: 3, serverId: 'web', sessionId: 'w', level: 'info' });
  assert.throws(() => access.search({ shareId: all.shareId! }), AgentAccessError);
  assert.deepEqual(access.search({ shareId: selected.shareId! }).events.map(event => event.id), [1]);
  assert.deepEqual(access.search({ shareId: selected.shareId!, sessionId: 'b' }).events, []);
  assert.throws(() => access.inspect(selected.shareId!, 2), AgentAccessError);
});

test('sharing legacy events without a session does not grant future named runs', () => {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', level: 'info' });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 2);
  const shareId = access.share(['api']).shareId!;
  store.add({ id: 2, serverId: 'api', sessionId: 'new', level: 'info' });
  assert.deepEqual(access.search({ shareId }).events.map(event => event.id), [1]);
  const analysis = access.analyze({ shareId }) as { coverage: { matched: number } };
  assert.equal(analysis.coverage.matched, 1);
});
