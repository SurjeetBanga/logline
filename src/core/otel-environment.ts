/**
 * Standard OpenTelemetry SDK variables that point an instrumented app at
 * Logline's receiver. Batch delays are shortened so telemetry appears within
 * a second during development instead of after the SDK default of 5 seconds,
 * and metrics are exported every 5 seconds instead of every minute.
 */
export function otelDefaults(endpoint: string, serviceName?: string): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_METRIC_EXPORT_INTERVAL: '5000',
    OTEL_BSP_SCHEDULE_DELAY: '500',
    OTEL_BLRP_SCHEDULE_DELAY: '500',
    ...(serviceName ? { OTEL_SERVICE_NAME: serviceName } : {})
  };
}

// Any of these means the user already chose where telemetry goes.
const DESTINATION = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_TRACES_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_SDK_DISABLED'];

/**
 * The defaults to add to an environment. A user who configured an exporter
 * destination keeps it entirely; otherwise only unset variables are added,
 * and a service name already given through resource attributes is kept.
 */
export function missingOtelVariables(env: Record<string, string | undefined>, defaults: Record<string, string>): Record<string, string> {
  if (DESTINATION.some(name => env[name] !== undefined && env[name] !== '')) return {};
  const added: Record<string, string> = {};
  for (const [name, value] of Object.entries(defaults)) {
    if (env[name] !== undefined && env[name] !== '') continue;
    if (name === 'OTEL_SERVICE_NAME' && /(?:^|,)\s*service\.name\s*=/.test(env.OTEL_RESOURCE_ATTRIBUTES ?? '')) continue;
    added[name] = value;
  }
  return added;
}
