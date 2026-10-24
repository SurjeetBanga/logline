import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { MetricStore } from '../core/metrics';
import type { MetricConnector, MetricResult } from './connectors/types';
import { RemoteMetrics } from './remote-metrics';
import { RuntimeState } from './runtime-state';

afterEach(() => mock.timers.reset());

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test('a watched query is polled into the Metrics list as gauges of the connection', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const store = new MetricStore();
  let notified = 0;
  const watched = new RemoteMetrics(store, new RuntimeState(() => notified++), 1000);
  const now = Date.now();
  const answers: (() => MetricResult)[] = [
    () => ({
      series: [
        {
          name: 'latency',
          scope: 'env:prod',
          unit: 'ms',
          points: [
            [now - 2000, 100],
            [now - 1000, 120],
          ],
        },
      ],
      statement: 'q',
      elapsedMs: 1,
    }),
    () => {
      throw new Error('rate limited');
    },
    // Overlapping points are not added twice.
    () => ({
      series: [
        {
          name: 'latency',
          scope: 'env:prod',
          unit: 'ms',
          points: [
            [now - 1000, 120],
            [now, 140],
          ],
        },
      ],
      statement: 'q',
      elapsedMs: 1,
    }),
  ];
  const windows: [number, number][] = [];
  const connector: MetricConnector = {
    async queryMetrics(_query, fromMs, toMs) {
      windows.push([fromMs, toMs]);
      return answers.shift()!();
    },
    listMetrics: async () => [],
  };
  watched.watch({ id: 'prod', label: 'Datadog · prod', connector }, 'avg:latency{*} by {env}');
  watched.watch({ id: 'prod', label: 'Datadog · prod', connector }, 'avg:latency{*} by {env}');
  await settle();
  assert.deepEqual(watched.watching('prod'), ['avg:latency{*} by {env}']);
  const [series] = store.list();
  assert.equal(series.name, 'latency');
  assert.equal(series.service, 'Datadog · prod');
  assert.deepEqual(series.attributes, [['env', 'prod']]);
  assert.equal(series.unit, 'ms');
  assert.deepEqual(
    series.points.map((point) => point.value),
    [100, 120],
  );
  assert.ok(windows[0][1] - windows[0][0] === 600000, 'reads the last ten minutes');
  mock.timers.tick(1000);
  await settle();
  assert.equal(watched.error('prod', 'avg:latency{*} by {env}'), 'rate limited');
  mock.timers.tick(1000);
  await settle();
  assert.equal(watched.error('prod', 'avg:latency{*} by {env}'), undefined);
  assert.deepEqual(
    store.list()[0].points.map((point) => point.value),
    [100, 120, 140],
  );
  assert.ok(notified >= 2);
  watched.stopConnection('prod');
  assert.deepEqual(watched.watching('prod'), []);
  mock.timers.tick(5000);
  await settle();
  assert.equal(windows.length, 3, 'a stopped watch polls no more');
  await watched.dispose();
});
