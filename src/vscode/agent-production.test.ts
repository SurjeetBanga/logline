import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ingestion } from '../capture/ingestion';
import { SessionRegistry } from '../capture/session-registry';
import { LogStore } from '../core/log-store';
import type { AgentConnection } from '../core/agent-types';
import { AgentAccessError, AgentLogAccess, type ProductionFetchResult } from './agent-access';
import { ProductionCompare } from './production-compare';

// Built at runtime: a credential-shaped literal would look like a leaked secret to scanners.
const SECRET = ['tok', 'en=', 'hunter', '22'].join('');

function fixture() {
  const store = new LogStore(1000);
  const registry = new SessionRegistry();
  const ingestion = new Ingestion(store, () => undefined);
  const access = new AgentLogAccess(store, registry, () => ingestion.sequence);
  let runs = 0;
  const connections: AgentConnection[] = [
    { id: 'prod', label: 'Datadog · prod', type: 'datadog', agents: true },
    { id: 'staging', label: 'Datadog · staging', type: 'datadog', agents: false },
  ];
  const fetches: unknown[] = [];
  let failure: string | undefined;
  const run = (serverId: string, server: string, lines: object[], kind: 'remote' | 'process') => {
    const id = `${kind}-${++runs}`;
    registry.records.set(id, {
      id,
      serverId,
      server,
      status: 'exited',
      startedAt: runs,
      events: 0,
      command: id,
      sourceKind: kind,
    });
    for (const line of lines) ingestion.accept(JSON.stringify(line), 'remote', { serverId, server, sessionId: id });
    return id;
  };
  access.production = {
    connections: () => connections,
    fetch: async (input): Promise<ProductionFetchResult> => {
      fetches.push(input);
      if (failure)
        return { sourceId: 'conn:prod', label: 'Datadog · prod', fetched: 0, kept: 0, local: [], error: failure };
      const sessionId = run(
        'conn:prod',
        'Datadog · prod',
        [
          { level: 'error', message: `payment gateway timed out after 5000 ms ${SECRET}` },
          { level: 'error', message: `payment gateway timed out after 4200 ms ${SECRET}` },
          { level: 'info', message: 'ok' },
        ],
        'remote',
      );
      return {
        sessionId,
        sourceId: 'conn:prod',
        label: 'Datadog · prod',
        fetched: 3,
        kept: 3,
        total: 40,
        local: ['/x/'],
        statement: 'status:(error)',
      };
    },
    compare: (request) => new ProductionCompare(store, registry, () => undefined).build(request, false),
  };
  return { store, registry, access, fetches, run, fail: (message?: string) => (failure = message) };
}

const code = (expected: string) => (error: unknown) => error instanceof AgentAccessError && error.code === expected;

test('agents fetch production only from connections the user allowed, within a day, a few times a minute', async () => {
  const { access, fetches, fail } = fixture();
  await assert.rejects(access.fetchProduction({ shareId: 'x', connectionId: 'prod' }), code('NOT_SHARED'));
  const { shareId } = access.shareAll();
  assert.deepEqual(access.list({ shareId: shareId! }).connections, [
    { id: 'prod', label: 'Datadog · prod', type: 'datadog', agents: true },
    { id: 'staging', label: 'Datadog · staging', type: 'datadog', agents: false },
  ]);
  await assert.rejects(
    access.fetchProduction({ shareId: shareId!, connectionId: 'staging' }),
    (error: unknown) => code('CONNECTION_UNAVAILABLE')(error) && /Allow agents/.test((error as Error).message),
  );
  await assert.rejects(
    access.fetchProduction({ shareId: shareId!, connectionId: 'nope' }),
    code('CONNECTION_UNAVAILABLE'),
  );
  await assert.rejects(
    access.fetchProduction({ shareId: shareId!, connectionId: 'prod', range: '7d' }),
    code('RANGE_TOO_LARGE'),
  );
  await assert.rejects(
    access.fetchProduction({ shareId: shareId!, connectionId: 'prod', traceId: 'a b' }),
    code('INVALID_INPUT'),
  );
  await assert.rejects(
    access.fetchProduction({ shareId: shareId!, connectionId: 'prod', query: 'x'.repeat(300) }),
    code('INVALID_INPUT'),
  );
  await assert.rejects(access.fetchProduction({ shareId: shareId!, connectionId: '' }), code('INVALID_INPUT'));
  assert.equal(fetches.length, 0, 'nothing is fetched for a refused request');
  const result = (await access.fetchProduction({
    shareId: shareId!,
    connectionId: 'prod',
    query: 'level:error',
    limit: 5000,
  })) as Record<string, any>;
  assert.deepEqual(fetches[0], { connectionId: 'prod', query: 'level:error', range: '1h', limit: 1000 });
  assert.equal(result.connection, 'Datadog · prod');
  assert.deepEqual([result.fetched, result.kept, result.totalInRange], [3, 3, 40]);
  assert.deepEqual(result.filteredLocally, ['/x/']);
  assert.equal(result.errorGroups.length, 1);
  assert.equal(result.errorGroups[0].count, 2);
  assert.doesNotMatch(JSON.stringify(result), /hunter22/, 'results are redacted');
  // The run can be read with the other tools.
  const search = access.search({ shareId: shareId!, sessionIds: [result.runId], query: 'level:error' });
  assert.equal(search.events.length, 2);
  for (let i = 0; i < 9; i++) await access.fetchProduction({ shareId: shareId!, connectionId: 'prod' });
  await assert.rejects(access.fetchProduction({ shareId: shareId!, connectionId: 'prod' }), code('BUSY'));
  const other = fixture();
  const share = other.access.shareAll();
  other.fail(`Datadog refused the key ${SECRET}`);
  await assert.rejects(
    other.access.fetchProduction({ shareId: share.shareId!, connectionId: 'prod' }),
    (error: unknown) => code('REMOTE_ERROR')(error) && !/hunter22/.test((error as Error).message),
  );
});

test('a fetched run joins a share of selected runs, and is compared with the newest local runs', async () => {
  const { access, run } = fixture();
  const local = run(
    'npm-test',
    'npm test',
    [{ level: 'error', message: `payment gateway timed out after 800 ms ${SECRET}` }],
    'process',
  );
  const share = access.share(['npm-test']);
  const fetched = (await access.fetchProduction({ shareId: share.shareId!, connectionId: 'prod' })) as {
    runId: string;
  };
  assert.ok(
    access
      .list()
      .sources.some((source) => source.id === 'conn:prod' && source.runs.some((r) => r.id === fetched.runId)),
  );
  assert.throws(
    () => access.compareWithProduction({ shareId: share.shareId!, prodRunId: 'nope' }),
    code('INVALID_INPUT'),
  );
  const before = access.compareWithProduction({ shareId: share.shareId!, prodRunId: fetched.runId }) as Record<
    string,
    any
  >;
  assert.equal(before.local.sourceId, 'npm-test', 'the shared local source is chosen');
  assert.deepEqual(before.local.runs, [local]);
  assert.equal(before.summary, '1 production error reproduced');
  assert.equal(before.errors[0].status, 'reproduced');
  assert.equal(before.errors[0].production, 2);
  assert.ok(Number.isSafeInteger(before.errors[0].productionSampleId));
  // A rerun after the fix: the error is gone.
  const fixed = run('npm-test', 'npm test', [{ level: 'info', message: 'paid' }], 'process');
  const after = access.compareWithProduction({
    shareId: share.shareId!,
    prodRunId: fetched.runId,
    localSourceId: 'npm-test',
  }) as Record<string, any>;
  assert.deepEqual(after.local.runs, [local, fixed]);
  assert.equal(after.errors[0].status, 'fixed');
  assert.throws(
    () => access.compareWithProduction({ shareId: share.shareId!, prodRunId: fetched.runId, localSourceId: 'web' }),
    code('INVALID_INPUT'),
  );
  access.production = undefined;
  assert.throws(
    () => access.compareWithProduction({ shareId: share.shareId!, prodRunId: fetched.runId }),
    code('CONNECTION_UNAVAILABLE'),
  );
});
