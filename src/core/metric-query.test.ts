import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundSeries, datadogSeries, downsample, rowsToSeries, scopeAttributes } from './metric-query';

test('rows from a metric SELECT become series by their label columns', () => {
  const rows = [
    { minute: '2026-10-23 09:01:00', value: 120, service: 'api' },
    { minute: '2026-10-23 09:00:00', value: 100, service: 'api' },
    { minute: '2026-10-23 09:00:00', value: 7.5, service: 'checkout' },
    { minute: 'not a time', value: 1, service: 'api' },
    { minute: '2026-10-23 09:02:00', value: null, service: 'api' },
  ];
  assert.deepEqual(rowsToSeries(rows, 'value'), [
    {
      name: 'value',
      scope: 'service:api',
      points: [
        [Date.parse('2026-10-23T09:00:00Z'), 100],
        [Date.parse('2026-10-23T09:01:00Z'), 120],
      ],
    },
    { name: 'value', scope: 'service:checkout', points: [[Date.parse('2026-10-23T09:00:00Z'), 7.5]] },
  ]);
  // Without a `value` column, the first numeric column after the time is the value.
  assert.deepEqual(rowsToSeries([{ ts: 1761210000, p95: '250' }], 'p95'), [
    { name: 'p95', scope: '', points: [[1761210000000, 250]] },
  ]);
  assert.throws(() => rowsToSeries([{ time: 1, label: 'x' }], 'v'), /numeric value column/);
  assert.deepEqual(rowsToSeries([], 'v'), []);
});

test("series are bounded for the chart, keeping each one's newest point", () => {
  const points = Array.from({ length: 1000 }, (_, i) => [i, i] as [number, number]);
  const sampled = downsample(points, 300);
  assert.equal(sampled.length, 300);
  assert.deepEqual(sampled[0], [0, 0]);
  assert.deepEqual(sampled.at(-1), [999, 999]);
  assert.equal(downsample(points.slice(0, 10)).length, 10);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: 'm', scope: `s:${i}`, points: points.slice(0, i + 1) }));
  const bounded = boundSeries(many);
  assert.equal(bounded.length, 20);
  assert.equal(bounded[0].scope, 's:29', 'the series with the most points first');
});

test('Datadog timeseries and scopes are read into series and attributes', () => {
  assert.deepEqual(
    datadogSeries({
      status: 'ok',
      series: [
        {
          metric: 'trace.http.request.duration',
          scope: 'env:prod,service:checkout',
          pointlist: [
            [1000, 0.2],
            [2000, null],
            [3000, 0.4],
          ],
          unit: [{ short_name: 's', family: 'time' }, null],
        },
        { display_name: 'other', pointlist: 'nope' },
      ],
    }),
    [
      {
        name: 'trace.http.request.duration',
        scope: 'env:prod,service:checkout',
        unit: 's',
        points: [
          [1000, 0.2],
          [3000, 0.4],
        ],
      },
      { name: 'other', scope: '*', points: [] },
    ],
  );
  assert.deepEqual(datadogSeries(null), []);
  assert.deepEqual(scopeAttributes('env:prod, service:checkout,host,*'), {
    env: 'prod',
    service: 'checkout',
    host: '',
  });
  assert.deepEqual(scopeAttributes('*'), {});
});
