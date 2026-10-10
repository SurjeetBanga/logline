// Checks OpenTelemetry spans and metrics against the semantic conventions
// that most affect debugging: a service name, low-cardinality span names, the
// HTTP route, error status on failed requests, current attribute names, and
// units kept out of metric names.
import type { AttrValue, Span } from './otlp';

export type TelemetryCode =
  'unnamed-service' | 'span-name-ids' | 'missing-route' | 'unmarked-error' | 'old-attributes' | 'unit-in-name';

/** A problem in what one service sends, with a trace that shows it when there is one. */
export interface TelemetryFinding {
  code: TelemetryCode;
  service: string;
  severity: 'warning' | 'information' | 'hint';
  message: string;
  traceId?: string;
}

/** A metric series as far as these checks need it. */
export interface MetricName {
  service: string;
  name: string;
  unit?: string;
  attributes: [string, string][];
}

/** Attribute names replaced in stable semantic conventions, with what replaced them. */
export const RENAMED_ATTRIBUTES: Record<string, string> = {
  'http.method': 'http.request.method',
  'http.status_code': 'http.response.status_code',
  'http.url': 'url.full',
  'http.target': 'url.path and url.query',
  'http.scheme': 'url.scheme',
  'http.user_agent': 'user_agent.original',
  'http.request_content_length': 'http.request.body.size',
  'http.response_content_length': 'http.response.body.size',
  'net.peer.name': 'server.address',
  'net.peer.port': 'server.port',
  'net.host.name': 'server.address',
  'net.host.port': 'server.port',
  'net.sock.peer.addr': 'network.peer.address',
  'http.client_ip': 'client.address',
  'db.statement': 'db.query.text',
  'db.operation': 'db.operation.name',
  'db.sql.table': 'db.collection.name',
  'messaging.destination': 'messaging.destination.name',
};

// A path segment or word that is an id: a number of two or more digits, a UUID, or a long hex string.
const ID_SEGMENT =
  /(?:^|[/\s=:])(?:\d{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})(?=$|[/\s?&.#])/i;
// Units belong in the unit field; `_total` is left alone because Prometheus adds it.
const UNIT_SUFFIX = /[._](ms|millis|milliseconds|seconds|secs|ns|nanoseconds|us|microseconds|bytes|kb|mb|percent)$/i;
const SERVER = 2;
const ERROR = 2;

const has = (attributes: Record<string, AttrValue>, key: string) =>
  Object.hasOwn(attributes, key) && attributes[key] !== null && attributes[key] !== '';
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

interface Tally {
  count: number;
  traceId?: string;
  example?: string;
  names?: Set<string>;
}

/** Findings per service, worst first. Each check needs only what the service already sent. */
export function telemetryFindings(
  traces: Iterable<[string, readonly Span[]]>,
  metrics: readonly MetricName[] = [],
): TelemetryFinding[] {
  const services = new Map<string, Map<string, Tally>>();
  const tally = (service: string, check: string, traceId?: string, example?: string) => {
    let checks = services.get(service);
    if (!checks) services.set(service, (checks = new Map()));
    let entry = checks.get(check);
    if (!entry) checks.set(check, (entry = { count: 0, traceId, example }));
    entry.count++;
    return entry;
  };
  const servers = new Map<string, number>();
  for (const [traceId, spans] of traces)
    for (const span of spans) {
      const attributes = span.attributes;
      if (isUnnamed(span.service)) tally(span.service, 'unnamed-service', traceId);
      if (ID_SEGMENT.test(span.name))
        (tally(span.service, 'span-name-ids', traceId, span.name).names ??= new Set()).add(span.name);
      for (const key of Object.keys(attributes))
        if (Object.hasOwn(RENAMED_ATTRIBUTES, key)) tally(span.service, `old:${key}`, traceId);
      if (span.kind !== SERVER) continue;
      servers.set(span.service, (servers.get(span.service) ?? 0) + 1);
      const method = has(attributes, 'http.request.method') || has(attributes, 'http.method');
      if (method && !has(attributes, 'http.route')) tally(span.service, 'missing-route', traceId, span.name);
      const status = Number(attributes['http.response.status_code'] ?? attributes['http.status_code']);
      if (status >= 500 && span.status.code !== ERROR)
        tally(span.service, 'unmarked-error', traceId, `${status} ${span.name}`);
    }
  for (const metric of metrics) {
    if (isUnnamed(metric.service)) tally(metric.service, 'unnamed-service');
    if (UNIT_SUFFIX.test(metric.name)) tally(metric.service, 'unit-in-name', undefined, metric.name);
    for (const [key] of metric.attributes)
      if (Object.hasOwn(RENAMED_ATTRIBUTES, key)) tally(metric.service, `old:${key}`);
  }

  const findings: TelemetryFinding[] = [];
  for (const [service, checks] of services) {
    const get = (check: string) => checks.get(check);
    const unnamed = get('unnamed-service');
    if (unnamed)
      findings.push({
        code: 'unnamed-service',
        service,
        severity: 'warning',
        traceId: unnamed.traceId,
        message: `Sends telemetry as ${service}, the default when no service name is set, so it cannot be told apart from other services. Set OTEL_SERVICE_NAME or the service.name resource attribute.`,
      });
    const ids = get('span-name-ids');
    if (ids)
      findings.push({
        code: 'span-name-ids',
        service,
        severity: 'warning',
        traceId: ids.traceId,
        message: `Names ${plural(ids.count, 'span')} with ids in them, such as "${ids.example}" (${plural(ids.names!.size, 'distinct name')}). Span names should name the operation, like "GET /orders/{id}", so requests group together; put the id in an attribute.`,
      });
    const route = get('missing-route');
    if (route && route.count * 2 >= (servers.get(service) ?? 0))
      findings.push({
        code: 'missing-route',
        service,
        severity: 'information',
        traceId: route.traceId,
        message: `Records ${plural(route.count, 'HTTP server span')} without http.route, such as "${route.example}", so requests cannot be grouped by endpoint. Use your framework's OpenTelemetry instrumentation or set http.route to the route template.`,
      });
    const unmarked = get('unmarked-error');
    if (unmarked)
      findings.push({
        code: 'unmarked-error',
        service,
        severity: 'warning',
        traceId: unmarked.traceId,
        message: `Returned a 5xx status on ${plural(unmarked.count, 'server span')} without marking the span as an error, such as "${unmarked.example}". Error filters and trace error counts miss them; set the span status to Error.`,
      });
    const renamed = [...checks.entries()].filter(([check]) => check.startsWith('old:'));
    if (renamed.length) {
      const names = renamed.map(([check]) => check.slice(4));
      findings.push({
        code: 'old-attributes',
        service,
        severity: 'hint',
        traceId: renamed.find(([, entry]) => entry.traceId)?.[1].traceId,
        message: `Uses attribute names from before the stable semantic conventions: ${names
          .slice(0, 4)
          .map((name) => `${name} (now ${RENAMED_ATTRIBUTES[name]})`)
          .join(
            ', ',
          )}${names.length > 4 ? `, and ${names.length - 4} more` : ''}. Dashboards and tools built on current names miss them; update the instrumentation libraries.`,
      });
    }
    const units = get('unit-in-name');
    if (units)
      findings.push({
        code: 'unit-in-name',
        service,
        severity: 'hint',
        message: `Puts units in ${plural(units.count, 'metric name')}, such as ${units.example}. Name the quantity and give the unit in the metric's unit field, like http.server.request.duration with unit s, so tools can convert and compare it.`,
      });
  }
  const rank = { warning: 0, information: 1, hint: 2 };
  return findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.service.localeCompare(b.service) || a.code.localeCompare(b.code),
  );
}

function isUnnamed(service: string): boolean {
  return service === 'unknown_service' || service.startsWith('unknown_service:');
}
