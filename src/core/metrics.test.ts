import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { histogramPercentile, MetricStore, readMetrics, type MetricPoint } from './metrics';
import { decodeMetricsRequest, ProtoError } from './otlp-proto';
import { SpanStore } from './traces';
import { LogStore } from './log-store';
import { Ingestion } from '../capture/ingestion';
import { OtlpReceiver } from '../capture/otlp-receiver';
import { RuntimeState } from '../capture/runtime-state';
import { SessionRegistry } from '../capture/session-registry';
import { otelDefaults } from './otel-environment';

// A tiny protobuf encoder for building wire-format fixtures.
const varint = (value: bigint | number): number[] => {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
};
const key = (field: number, wire: number) => varint((field << 3) | wire);
const bytes = (field: number, payload: number[]) => [...key(field, 2), ...varint(payload.length), ...payload];
const str = (field: number, value: string) => bytes(field, [...Buffer.from(value)]);
const num = (field: number, value: number) => [...key(field, 0), ...varint(value)];
const le64 = (value: bigint) => {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Number((BigInt.asUintN(64, value) >> BigInt(i * 8)) & 0xffn));
  return out;
};
const fixed64 = (field: number, value: bigint) => [...key(field, 1), ...le64(value)];
const f64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return [...buffer];
};
const double = (field: number, value: number) => [...key(field, 1), ...f64(value)];
const kv = (name: string, value: string, field: number) => bytes(field, [...str(1, name), ...bytes(2, str(1, value))]);
const resource = (service: string) => bytes(1, kv('service.name', service, 1));
const NS = 1_700_000_000_000_000_000n;
const ms = (offset: number) => Number(NS / 1_000_000n) + offset;
const nanos = (offset: number) => String(NS + BigInt(offset) * 1_000_000n);

test('decodes protobuf metrics of every kind into the OTLP/JSON shape', () => {
  const gauge = bytes(5, bytes(1, [...fixed64(3, NS), ...double(4, 0.75), ...kv('cpu', '0', 7)]));
  const counter = bytes(7, [
    ...bytes(1, [...fixed64(2, NS - 1_000_000_000n), ...fixed64(3, NS), ...key(6, 1), ...le64(-3n)]),
    ...num(2, 2),
    ...num(3, 1),
  ]);
  // Bucket counts packed, bounds unpacked: both encodings are valid.
  const histogram = bytes(9, [
    ...bytes(1, [
      ...fixed64(3, NS),
      ...fixed64(4, 10n),
      ...double(5, 420),
      ...bytes(6, [...le64(4n), ...le64(5n), ...le64(1n)]),
      ...double(7, 10),
      ...double(7, 100),
      ...kv('http.route', '/orders', 9),
      ...double(11, 2),
      ...double(12, 180),
    ]),
    ...num(2, 1),
  ]);
  const exponential = bytes(
    10,
    bytes(1, [
      ...kv('a', 'b', 1),
      ...fixed64(3, NS),
      ...fixed64(4, 2n),
      ...double(5, 8),
      ...double(12, 3),
      ...double(13, 5),
    ]),
  );
  const summary = bytes(
    11,
    bytes(1, [
      ...fixed64(3, NS),
      ...fixed64(4, 4n),
      ...double(5, 40),
      ...bytes(6, [...double(1, 0.95), ...double(2, 19)]),
    ]),
  );
  const metric = (name: string, unit: string, data: number[]) =>
    bytes(2, [...str(1, name), ...str(2, `${name} help`), ...str(3, unit), ...data]);
  const request = bytes(1, [
    ...resource('api'),
    ...bytes(2, [
      ...bytes(1, str(1, 'meter')),
      ...metric('cpu.utilization', '1', gauge),
      ...metric('requests', '{request}', counter),
      ...metric('http.server.duration', 'ms', histogram),
      ...metric('size', 'By', exponential),
      ...metric('latency', 's', summary),
    ]),
  ]);
  const decoded = decodeMetricsRequest(new Uint8Array(request)) as any;
  const metrics = decoded.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.deepEqual(
    metrics.map((m: any) => [m.name, m.unit, Object.keys(m).find((k) => !['name', 'description', 'unit'].includes(k))]),
    [
      ['cpu.utilization', '1', 'gauge'],
      ['requests', '{request}', 'sum'],
      ['http.server.duration', 'ms', 'histogram'],
      ['size', 'By', 'exponentialHistogram'],
      ['latency', 's', 'summary'],
    ],
  );
  assert.equal(metrics[1].sum.dataPoints[0].asInt, '-3', 'sfixed64 is signed');
  assert.deepEqual([metrics[1].sum.aggregationTemporality, metrics[1].sum.isMonotonic], [2, true]);
  assert.deepEqual(metrics[2].histogram.dataPoints[0].bucketCounts, ['4', '5', '1']);
  assert.deepEqual(metrics[2].histogram.dataPoints[0].explicitBounds, [10, 100]);

  const points = readMetrics(decoded);
  assert.equal(points.length, 5);
  assert.deepEqual(
    points.map((p) => [p.service, p.kind, p.value ?? p.count]),
    [
      ['api', 'gauge', 0.75],
      ['api', 'sum', -3],
      ['api', 'histogram', 10],
      ['api', 'exponentialHistogram', 2],
      ['api', 'summary', 4],
    ],
  );
  assert.deepEqual(points[2], {
    name: 'http.server.duration',
    description: 'http.server.duration help',
    unit: 'ms',
    kind: 'histogram',
    service: 'api',
    temporality: 1,
    attributes: Object.assign(Object.create(null), { 'http.route': '/orders' }),
    timeMs: ms(0),
    startMs: undefined,
    count: 10,
    sum: 420,
    min: 2,
    max: 180,
    bounds: [10, 100],
    buckets: [4, 5, 1],
  });
  assert.deepEqual(points[4].quantiles, [{ quantile: 0.95, value: 19 }]);
  assert.throws(
    () =>
      decodeMetricsRequest(
        new Uint8Array(
          bytes(1, bytes(2, bytes(2, [...str(1, 'x'), ...bytes(9, bytes(1, [...key(6, 2), 3, 1, 2, 3]))]))),
        ),
      ),
    ProtoError,
  );
});

test('OTLP/JSON metrics accept string numbers and enum names, and skip points without a time or value', () => {
  const points = readMetrics({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'queue.depth',
                gauge: {
                  dataPoints: [{ timeUnixNano: nanos(0), asInt: '7' }, { asInt: '1' }, { timeUnixNano: nanos(1) }],
                },
              },
              {
                name: 'bytes',
                sum: {
                  aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
                  isMonotonic: true,
                  dataPoints: [{ timeUnixNano: nanos(0), asDouble: 5 }],
                },
              },
              {
                name: 'broken',
                histogram: {
                  dataPoints: [{ timeUnixNano: nanos(0), count: '3', bucketCounts: ['1', '2'], explicitBounds: [] }],
                },
              },
              { gauge: { dataPoints: [{ timeUnixNano: nanos(0), asInt: '1' }] } },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    points.map((p) => [p.name, p.service, p.value ?? p.count]),
    [
      ['queue.depth', 'unknown_service', 7],
      ['bytes', 'unknown_service', 5],
      ['broken', 'unknown_service', 3],
    ],
  );
  assert.equal(points[1].temporality, 2);
  assert.equal(points[2].buckets, undefined, 'bucket counts must be one more than the bounds');
});

test('histogram percentiles interpolate within the bucket and stay within the minimum and maximum', () => {
  assert.equal(
    histogramPercentile([10, 100], [4, 5, 1], 0.5, 2, 180),
    28,
    'rank 5 of 10 is a fifth of the way through the 10–100 bucket',
  );
  assert.equal(
    histogramPercentile([10, 100], [4, 5, 1], 0.95, 2, 180),
    140,
    'the open last bucket is closed by the maximum',
  );
  assert.equal(histogramPercentile([10, 100], [0, 0, 0], 0.95), undefined);
  assert.equal(
    histogramPercentile([10, 100], [10, 0, 0], 0.5, 4, 6),
    5,
    'the open first bucket is closed by the minimum, and the result clamped',
  );
});

const point = (extra: Partial<MetricPoint>): MetricPoint => ({
  name: 'requests',
  kind: 'sum',
  service: 'api',
  attributes: Object.create(null),
  timeMs: ms(0),
  ...extra,
});

test('counters show a rate, cumulative histograms the p95 of the latest interval, gauges their value', () => {
  const store = new MetricStore();
  // A cumulative counter: 100 at 10 s, 160 at 20 s, then a restart.
  store.add(point({ monotonic: true, temporality: 2, startMs: ms(0), timeMs: ms(10_000), value: 100 }));
  store.add(point({ monotonic: true, temporality: 2, startMs: ms(0), timeMs: ms(20_000), value: 160 }));
  let [counter] = store.list();
  assert.deepEqual([counter.measure, counter.total, counter.points.map((p) => p.value)], ['rate', 160, [10, 6]]);
  store.add(point({ monotonic: true, temporality: 2, startMs: ms(25_000), timeMs: ms(30_000), value: 20 }));
  [counter] = store.list();
  assert.equal(counter.latest, 4, 'a restarted counter is measured from its new start');
  assert.equal(
    store.add(point({ monotonic: true, temporality: 2, startMs: ms(25_000), timeMs: ms(30_000), value: 20 })),
    false,
    'a resent point is ignored',
  );

  const histogram = (timeMs: number, buckets: number[], count: number, sum: number) =>
    point({
      name: 'http.server.duration',
      kind: 'histogram',
      unit: 'ms',
      temporality: 2,
      startMs: ms(0),
      timeMs: ms(timeMs),
      bounds: [10, 100, 1000],
      buckets,
      count,
      sum,
      min: 1,
      max: 900,
    });
  store.add(histogram(5_000, [10, 0, 0, 0], 10, 50));
  // In the second interval, 10 requests landed between 100 and 1000 ms.
  store.add(histogram(10_000, [10, 0, 10, 0], 20, 5050));
  const duration = store.list().find((series) => series.name === 'http.server.duration')!;
  assert.equal(duration.measure, 'p95');
  assert.equal(duration.count, 10);
  assert.equal(duration.average, 500);
  assert.equal(
    duration.latest,
    860,
    "the first interval's fast requests do not dilute the latest p95, and the run's maximum narrows the bucket",
  );
  assert.equal(duration.bound, false);

  // Default SDK buckets are sized for milliseconds; durations in seconds all land in the first one.
  const seconds = point({
    name: 'http.server.request.duration',
    kind: 'histogram',
    unit: 's',
    temporality: 1,
    startMs: ms(0),
    timeMs: ms(5_000),
    bounds: [0, 5, 10, 25],
    buckets: [0, 20, 0, 0, 0],
    count: 20,
    sum: 1.28,
    min: 0.02,
    max: 0.9,
  });
  store.add(seconds);
  const coarse = store.list()[0];
  assert.deepEqual(
    [coarse.latest, coarse.bound, coarse.p50],
    [0.9, true, undefined],
    'a bucket too wide to interpolate gives only an upper bound',
  );

  store.add(point({ name: 'memory', kind: 'gauge', unit: 'By', value: 1024 }));
  store.add(point({ name: 'delta', monotonic: true, temporality: 1, startMs: ms(0), timeMs: ms(2_000), value: 10 }));
  const list = store.list();
  assert.deepEqual(
    list.map((series) => series.name),
    ['delta', 'memory', 'http.server.request.duration', 'http.server.duration', 'requests'],
    'most recently updated first',
  );
  assert.deepEqual([list[0].latest, list[0].total, list[1].latest, list[1].measure], [5, 10, 1024, 'value']);
});

test('the metric store bounds series and points per series', () => {
  const store = new MetricStore(2, 3);
  for (let i = 0; i < 5; i++) store.add(point({ kind: 'gauge', timeMs: ms(i), value: i }));
  assert.deepEqual(
    store.list()[0].points.map((p) => p.value),
    [2, 3, 4],
  );
  assert.deepEqual(
    store.list(2)[0].points.map((p) => p.value),
    [2, 4],
    'a sampled list spreads its points and ends with the newest',
  );
  assert.deepEqual(
    store.list(1)[0].points.map((p) => p.value),
    [4],
  );
  store.add(point({ kind: 'gauge', name: 'b', value: 1 }));
  store.add(
    point({ kind: 'gauge', name: 'a', attributes: Object.assign(Object.create(null), { host: 'x' }), value: 1 }),
  );
  assert.deepEqual(
    store.list().map((series) => [series.name, series.attributes]),
    [
      ['a', [['host', 'x']]],
      ['b', []],
    ],
    'the least recently updated series goes first',
  );
  assert.deepEqual(
    store.names().map((series) => [series.name, series.attributes]),
    [
      ['b', []],
      ['a', [['host', 'x']]],
    ],
    'names leave the points out',
  );
  assert.equal('points' in store.names()[0], false);
  const revision = store.revision;
  store.clear();
  assert.equal(store.size, 0);
  assert.ok(store.revision > revision);
});

test('the receiver keeps metrics, and instrumented apps are asked to export them often', async (t) => {
  const metrics = new MetricStore();
  const receiver = new OtlpReceiver(
    {
      get<T>(_key: string, fallback: T): T {
        return fallback;
      },
    },
    new SessionRegistry(),
    new Ingestion(new LogStore(), () => {}),
    new RuntimeState(() => {}),
    new SpanStore(),
    undefined,
    metrics,
  );
  const { endpoint } = await receiver.start(0);
  t.after(() => receiver.stop());
  const body = JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] },
        scopeMetrics: [
          {
            metrics: [
              { name: 'orders', unit: '{order}', gauge: { dataPoints: [{ timeUnixNano: nanos(0), asInt: '3' }] } },
            ],
          },
        ],
      },
    ],
  });
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${endpoint}/v1/metrics`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(status, 200);
  assert.deepEqual(
    metrics.list().map((series) => [series.service, series.name, series.latest]),
    [['checkout', 'orders', 3]],
  );
  assert.deepEqual(
    [otelDefaults(endpoint!).OTEL_METRICS_EXPORTER, otelDefaults(endpoint!).OTEL_METRIC_EXPORT_INTERVAL],
    ['otlp', '5000'],
  );
});

test('large protobuf metrics requests are decoded on the worker thread', async (t) => {
  const metrics = new MetricStore();
  const receiver = new OtlpReceiver(
    {
      get<T>(_key: string, fallback: T): T {
        return fallback;
      },
    },
    new SessionRegistry(),
    new Ingestion(new LogStore(), () => {}),
    new RuntimeState(() => {}),
    new SpanStore(),
    1,
    metrics,
  );
  const { endpoint } = await receiver.start(0);
  t.after(() => receiver.stop());
  // ExportMetricsServiceRequest { resource_metrics { resource, scope_metrics { metrics { name, sum { data_points, temporality, monotonic } } } } }
  const dataPoint = [
    ...fixed64(2, NS),
    ...fixed64(3, NS + 10_000_000_000n),
    ...double(4, 50),
    ...kv('route', '/orders', 7),
  ];
  const sum = [...bytes(1, dataPoint), ...num(2, 2), ...num(3, 1)];
  const metric = [...str(1, 'http.requests'), ...str(3, '{request}'), ...bytes(7, sum)];
  const body = Buffer.from(bytes(1, [...resource('checkout'), ...bytes(2, bytes(2, metric))]));
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${endpoint}/v1/metrics`,
      { method: 'POST', headers: { 'content-type': 'application/x-protobuf' } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(status, 200);
  const [series] = metrics.list();
  assert.deepEqual(
    [series.service, series.name, series.measure, series.total, series.latest, series.attributes],
    ['checkout', 'http.requests', 'rate', 50, 5, [['route', '/orders']]],
  );
});
