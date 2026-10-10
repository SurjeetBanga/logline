// Minimal OpenTelemetry-style metrics: a counter and a histogram, exported as
// cumulative OTLP/JSON to OTEL_EXPORTER_OTLP_ENDPOINT every 2 seconds.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const start = Date.now();
const BOUNDS = [25, 50, 75, 100, 150, 250, 500];
const orders = new Map();
const duration = { count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array(BOUNDS.length + 1).fill(0) };

function nanos(ms) { return String(BigInt(Math.round(ms)) * 1000000n); }

function countOrder(outcome) { orders.set(outcome, (orders.get(outcome) ?? 0) + 1); }

function recordDuration(ms) {
  duration.count++;
  duration.sum += ms;
  duration.min = Math.min(duration.min, ms);
  duration.max = Math.max(duration.max, ms);
  const bucket = BOUNDS.findIndex(bound => ms <= bound);
  duration.buckets[bucket === -1 ? BOUNDS.length : bucket]++;
}

async function flush() {
  if (!endpoint || !duration.count) return;
  const now = Date.now();
  const metrics = [
    { name: 'checkout.orders', unit: '{order}', description: 'Orders by outcome', sum: { aggregationTemporality: 2, isMonotonic: true,
      dataPoints: [...orders].map(([outcome, count]) => ({ attributes: [{ key: 'outcome', value: { stringValue: outcome } }], startTimeUnixNano: nanos(start), timeUnixNano: nanos(now), asInt: String(count) })) } },
    { name: 'checkout.duration', unit: 'ms', description: 'Time to place an order', histogram: { aggregationTemporality: 2,
      dataPoints: [{ startTimeUnixNano: nanos(start), timeUnixNano: nanos(now), count: String(duration.count), sum: duration.sum, min: duration.min, max: duration.max,
        explicitBounds: BOUNDS, bucketCounts: duration.buckets.map(String) }] } }
  ];
  const body = { resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout-api' } }] }, scopeMetrics: [{ metrics }] }] };
  await fetch(`${endpoint.replace(/\/$/, '')}/v1/metrics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}
setInterval(flush, 2000).unref();

module.exports = { countOrder, recordDuration, flush };
