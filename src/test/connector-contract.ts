// What every log-service connector does the same way, whatever its store:
// each connector's tests run these against its fake service.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTION_KINDS } from '../core/connection-types';
import type { ConnectionType } from '../core/connections';
import type { Connector, RemoteRecord } from '../capture/connectors/types';

/** A log, as each connector's fake service is seeded with it. */
export interface ContractLog {
  timeMs: number;
  level: 'info' | 'error';
  message: string;
  service: string;
  traceId: string;
}

export interface ContractStore {
  connector: Connector;
  /** Answer the next request as the store answers a request over its rate limit. */
  rateLimit(): void;
  close(): Promise<void>;
}

export const CONTRACT_START = Date.parse('2026-10-30T12:00:00Z');

/** 600 logs a second apart: every third an error, services alternating, ten traces. */
export function contractLogs(): ContractLog[] {
  return Array.from({ length: 600 }, (_, i) => ({
    timeMs: CONTRACT_START + i * 1000,
    level: i % 3 === 0 ? 'error' : 'info',
    message: i % 3 === 0 ? `payment ${i} declined` : `order ${i} placed`,
    service: i % 2 ? 'api' : 'checkout',
    traceId: `trace${i % 10}`,
  }));
}

const times = (records: RemoteRecord[]) => records.map((record) => record.timeMs ?? NaN);

export function describeConnector(type: ConnectionType, start: (logs: ContractLog[]) => Promise<ContractStore>): void {
  const range = { fromMs: CONTRACT_START, toMs: CONTRACT_START + 3600000 };
  const label = CONNECTION_KINDS[type].label;

  test(`${label}: a search returns the newest logs within the limit, newest first, showing its first ones early`, async () => {
    const store = await start(contractLogs());
    try {
      const early: RemoteRecord[][] = [];
      const result = await store.connector.fetchLogs({
        query: '',
        ...range,
        limit: 250,
        order: 'desc',
        firstPage: (records) => early.push(records),
      });
      assert.equal(result.records.length, 250);
      const got = times(result.records);
      assert.deepEqual(
        got,
        [...got].sort((a, b) => b - a),
        'newest first',
      );
      assert.equal(got[0], CONTRACT_START + 599000, 'the newest log first');
      assert.ok(early.length <= 1, 'the first logs are shown at most once');
      for (const records of early) assert.deepEqual(records, result.records.slice(0, records.length));
      // A tail reads forward from where it was.
      const next = await store.connector.fetchLogs({
        query: '',
        fromMs: CONTRACT_START + 590000,
        toMs: CONTRACT_START + 3600000,
        limit: 5,
        order: 'asc',
      });
      assert.deepEqual(
        times(next.records),
        [0, 1, 2, 3, 4].map((i) => CONTRACT_START + (590 + i) * 1000),
      );
    } finally {
      await store.close();
    }
  });

  test(`${label}: a search sends what its preview says, and finds a trace by the kind's trace query`, async () => {
    const store = await start(contractLogs());
    try {
      const preview = await store.connector.preview('level:error');
      const result = await store.connector.fetchLogs({ query: 'level:error', ...range, limit: 1000, order: 'desc' });
      assert.equal(result.statement, preview.statement);
      assert.deepEqual(result.local, preview.local);
      assert.equal(result.records.length, 200, 'every error, and only errors');
      const traceQuery = CONNECTION_KINDS[type].traceQuery;
      if (traceQuery) {
        const trace = await store.connector.fetchLogs({
          query: '',
          native: traceQuery('trace3'),
          ...range,
          limit: 1000,
          order: 'desc',
        });
        assert.equal(trace.records.length, 60);
        assert.ok(trace.records.every((record) => record.line.includes('trace3')));
      }
    } finally {
      await store.close();
    }
  });

  test(`${label}: a cancelled search says so, and a rate limit tells a tail when to read again`, async () => {
    const store = await start(contractLogs());
    try {
      const cancel = new AbortController();
      cancel.abort();
      await assert.rejects(
        store.connector.fetchLogs({ query: '', ...range, limit: 10, order: 'desc' }, cancel.signal),
        { message: 'The query was cancelled.' },
      );
      store.rateLimit();
      const error = await store.connector.fetchLogs({ query: '', ...range, limit: 10, order: 'desc' }).then(
        () => undefined,
        (reason: unknown) => reason as { retryAfterMs?: number },
      );
      assert.ok(error && typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0, 'retryAfterMs is set');
    } finally {
      await store.close();
    }
  });
}
