// Minimal OpenTelemetry-style tracing: spans are exported as OTLP/JSON to
// OTEL_EXPORTER_OTLP_ENDPOINT, which Logline sets while its receiver runs.
const { randomBytes } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const pending = [];

function nanos(ms) { return String(BigInt(Math.round(ms * 1000)) * 1000n); }

async function span(service, name, fn, kind = 1) {
  const parent = storage.getStore();
  const current = { traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), parentSpanId: parent?.spanId };
  const start = performance.timeOrigin + performance.now();
  let status = { code: 1 };
  try { return await storage.run(current, fn); }
  catch (error) { status = { code: 2, message: error.message }; throw error; }
  finally {
    const end = performance.timeOrigin + performance.now();
    pending.push({ service, span: { ...current, name, kind, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end), status } });
  }
}

async function flush() {
  if (!endpoint || !pending.length) return;
  const byService = new Map();
  for (const { service, span } of pending.splice(0)) byService.set(service, [...(byService.get(service) ?? []), span]);
  const body = { resourceSpans: [...byService].map(([service, spans]) => ({
    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
    scopeSpans: [{ spans }]
  })) };
  await fetch(`${endpoint.replace(/\/$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
}
setInterval(flush, 500).unref();

module.exports = { span, flush, trace: { current: () => storage.getStore() } };
