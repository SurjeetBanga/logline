import assert from 'node:assert/strict';
import test from 'node:test';
import type { Span } from './otlp';
import { telemetryFindings } from './telemetry-findings';

let next = 0;
const span = (service: string, name: string, extra: Partial<Span> = {}): Span => ({
  traceId: `t${++next}`, spanId: `s${next}`, name, kind: 2, startMs: 0, endMs: 1, service, attributes: {}, events: [], status: { code: 0 }, ...extra
});
const traces = (...spans: Span[]): [string, Span[]][] => spans.map(item => [item.traceId, [item]]);

test('convention checks find unnamed services, ids in span names, unmarked 5xx, missing routes, and old attribute names', () => {
  const findings = telemetryFindings(traces(
    span('unknown_service:node', 'GET'),
    span('api', 'GET /orders/12345', { attributes: { 'http.request.method': 'GET', 'http.route': '/orders/{id}' } }),
    span('api', 'GET /orders/9f1c2b3a-1234-4abc-9def-0123456789ab', { attributes: { 'http.request.method': 'GET', 'http.route': '/orders/{id}' } }),
    span('api', 'POST /pay', { attributes: { 'http.method': 'POST', 'http.status_code': 502, 'net.peer.name': 'stripe' } }),
    span('api', 'POST /pay', { attributes: { 'http.request.method': 'POST', 'http.response.status_code': 503 }, status: { code: 2 } }),
    span('api', 'db query', { kind: 3, attributes: { 'db.statement': 'select 1' } })
  ), [{ service: 'api', name: 'checkout.latency_ms', unit: 'ms', attributes: [['http.method', 'GET']] }, { service: 'api', name: 'http.server.request.duration', unit: 's', attributes: [] }]);
  const byCode = new Map(findings.map(finding => [`${finding.service} ${finding.code}`, finding]));
  assert.deepEqual([...byCode.keys()], [
    'api span-name-ids', 'api unmarked-error', 'unknown_service:node unnamed-service', 'api missing-route', 'api old-attributes', 'api unit-in-name'
  ], 'warnings first, then by service');
  assert.match(byCode.get('api span-name-ids')!.message, /Names 2 spans with ids in them, such as "GET \/orders\/12345" \(2 distinct names\)/);
  assert.match(byCode.get('api unmarked-error')!.message, /on 1 server span .*"502 POST \/pay"/, 'a 5xx already marked as an error is fine');
  assert.match(byCode.get('api missing-route')!.message, /2 HTTP server spans without http\.route, such as "POST \/pay"/);
  assert.match(byCode.get('api old-attributes')!.message, /http\.method \(now http\.request\.method\), http\.status_code \(now http\.response\.status_code\), net\.peer\.name \(now server\.address\), db\.statement \(now db\.query\.text\)/);
  assert.match(byCode.get('api unit-in-name')!.message, /1 metric name, such as checkout\.latency_ms/);
  assert.ok(byCode.get('api unmarked-error')!.traceId, 'span findings point at a trace that shows them');
  assert.equal(byCode.get('api unit-in-name')!.traceId, undefined);
});

test('convention checks stay quiet on well-instrumented services and ordinary names', () => {
  assert.deepEqual(telemetryFindings(traces(
    span('api', 'GET /v1/orders/{id}', { attributes: { 'http.request.method': 'GET', 'http.route': '/v1/orders/{id}', 'http.response.status_code': 200 } }),
    span('api', 'GET /health', { attributes: { 'http.request.method': 'GET', 'http.route': '/health' } }),
    span('api', 'GET /static', { attributes: { 'http.request.method': 'GET' } }),
    span('worker', 'process batch', { kind: 1 })
  ), [{ service: 'api', name: 'http_requests_total', attributes: [] }]), [],
  'one server span in three without a route is not a pattern, and a version segment is not an id');
});
