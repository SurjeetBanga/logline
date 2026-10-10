import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ingestion } from '../capture/ingestion';
import { RuntimeState } from '../capture/runtime-state';
import { SessionRegistry } from '../capture/session-registry';
import { LogStore } from '../core/log-store';
import { parseViewRequest, type ViewRequest } from '../protocol/messages';
import { buildSnapshot, type SnapshotSources } from './snapshot';

type SnapshotRequest = Extract<ViewRequest, { type: 'snapshot' }>;

function harness(maxRows = 5000) {
  const store = new LogStore(maxRows);
  const ingestion = new Ingestion(store, () => undefined);
  const add = (count: number, level = 'info') => {
    for (let i = 0; i < count; i++)
      ingestion.accept(
        JSON.stringify({
          level,
          message: `line ${ingestion.sequence + 1}`,
          f1: 1,
          f2: 2,
          f3: 3,
          f4: 4,
          f5: 5,
          f6: 6,
          f7: 7,
        }),
        'stdout',
        { serverId: 'api', server: 'API', sessionId: 'run' },
      );
  };
  let linksVersion = 'links-1';
  const sources = (): SnapshotSources => ({
    store,
    ingestion,
    config: { get: (_key, fallback) => fallback },
    registry: new SessionRegistry(),
    state: new RuntimeState(() => undefined),
    persistence: { persistDropped: 0 } as SnapshotSources['persistence'],
    searches: { savedSearches: () => [] } as unknown as SnapshotSources['searches'],
    running: true,
    guideStatus: { version: '', unread: false },
    agentAccess: { status: () => ({ active: false, sources: [] }) } as unknown as SnapshotSources['agentAccess'],
    rowLinksVersion: linksVersion,
  });
  const snapshot = (request: Omit<SnapshotRequest, 'type'> = {}) =>
    buildSnapshot({ type: 'snapshot', ...request }, sources());
  return {
    store,
    add,
    snapshot,
    setLinksVersion: (value: string) => {
      linksVersion = value;
    },
  };
}

test('a refresh sends only the rows after the ones the view holds', () => {
  const h = harness();
  h.add(1500);
  const full = h.snapshot();
  assert.equal(full.events!.length, 1000);
  assert.equal(full.keep, undefined);
  const have = { last: full.events!.at(-1)!.id, count: 1000, version: full.rowsVersion! };
  h.add(3);
  const partial = h.snapshot({ have });
  assert.deepEqual(
    partial.events!.map((event) => event.id),
    [1501, 1502, 1503],
  );
  assert.equal(partial.keep, 997, 'the three oldest held rows left the newest page');
  assert.equal(partial.keepFirst, 504);
  assert.equal(partial.matched, 1503);
  const idle = h.snapshot({ have: { ...have, last: 1503 } });
  assert.deepEqual(idle.events, []);
  assert.equal(idle.keep, 1000);
});

test('a refresh sends the whole page when held rows cannot be continued', () => {
  const h = harness();
  h.add(50);
  const full = h.snapshot();
  const have = { last: 50, count: 50, version: full.rowsVersion! };
  h.add(5);
  // Each case changes something the held rows depended on.
  assert.equal(h.snapshot({ have, sort: 'message' }).keep, undefined, 'a sorted page');
  assert.equal(h.snapshot({ have, query: 'last:5m' }).keep, undefined, 'a window that moves with the clock');
  assert.equal(h.snapshot({ have, page: 1 }).keep, undefined, 'a deeper page that slides with new events');
  assert.equal(h.snapshot({ have, columns: ['f7'] }).keep, undefined, 'different projected columns');
  assert.equal(h.snapshot({ have: { ...have, last: 9999 } }).keep, undefined, 'a row the page does not have');
  assert.equal(h.snapshot({ have: { ...have, count: 10 } }).keep, undefined, 'more rows kept than the view holds');
  h.setLinksVersion('links-2');
  assert.equal(h.snapshot({ have }).keep, undefined, 'statement links or findings changed');
  h.setLinksVersion('links-1');
  assert.equal(h.snapshot({ have }).keep, 50);
  // A fixed history boundary can be continued on any page.
  assert.equal(h.snapshot({ have: { ...have, last: 40, count: 40 }, before: 40 }).keep, 40);
});

test('snapshot requests accept only well-formed held rows', () => {
  const parse = (have: unknown) => (parseViewRequest({ type: 'snapshot', have }) as SnapshotRequest).have;
  assert.deepEqual(parse({ last: 5, count: 2, version: 'v', extra: true }), { last: 5, count: 2, version: 'v' });
  for (const have of [
    undefined,
    null,
    'x',
    { last: 1.5, count: 1, version: 'v' },
    { last: 1, count: 0, version: 'v' },
    { last: 1, count: 1 },
  ]) {
    assert.equal(parse(have), undefined);
  }
});
