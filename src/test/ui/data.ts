// Messages the extension host sends the Logs panel, shared by the panel's browser tests.

export const snapshot = {
  type: 'snapshot',
  generation: 1,
  newest: 20,
  total: 600,
  retained: 600,
  discarded: 0,
  bytes: 60000,
  maxBytes: 262144000,
  truncated: 0,
  columns: [],
  columnFields: [],
  fields: ['service'],
  // More than one page, so the pager's arrows are in use.
  page: 0,
  pages: 3,
  matched: 600,
  events: Array.from({ length: 20 }, (_, index) => ({
    id: 20 - index,
    message: `GET /api/items/${index} 200`,
    level: index % 5 ? 'info' : 'error',
    timestamp: '12:00:00',
    stream: 'stdout',
    serverId: 'api',
    sessionId: 'run',
    fields: { service: 'api' },
  })),
  servers: [{ id: 'api', label: 'API', status: 'running', activeSessions: 1, configured: true, canStop: true }],
  sessions: [{ id: 'run', serverId: 'api', server: 'API', command: 'npm start', status: 'running', startedAt: 1 }],
  connections: [{ id: 'app', label: 'App DB', type: 'postgres' }],
};

export const traces = {
  type: 'traces',
  traces: [
    {
      traceId: 'f1',
      name: 'POST /checkout',
      service: 'api',
      services: ['api', 'payments'],
      startMs: 1000,
      durationMs: 120,
      spans: 3,
      logs: 4,
      errors: 1,
    },
  ],
};

const span = (spanId: string, name: string, depth: number, extra: Record<string, unknown> = {}) => ({
  spanId,
  name,
  service: 'api',
  kind: 'server',
  offsetMs: depth * 12,
  durationMs: 120 - depth * 25,
  selfMs: 30,
  depth,
  error: false,
  critical: depth < 2,
  attributes: { 'http.route': '/checkout' },
  events: [],
  ...extra,
});

export const traceDetail = {
  type: 'trace',
  trace: {
    traceId: 'f1',
    durationMs: 120,
    services: ['api', 'payments', 'db'],
    errors: 1,
    omitted: 0,
    hotspots: [{ service: 'api', name: 'POST /checkout', count: 1, selfMs: 80, share: 0.66, errors: 0 }],
    spans: [
      span('a', 'POST /checkout', 0),
      span('b', 'charge card', 1, {
        service: 'payments',
        kind: 'client',
        error: true,
        critical: false,
        statusMessage: 'declined: the card issuer refused the charge and asked for another payment method',
      }),
      span('c', 'SELECT orders WHERE customer_id = $1 AND created_at > now() - interval', 2, {
        service: 'db',
        kind: 'client',
      }),
      span('d', 'render receipt', 1, { critical: false }),
      span('e', 'send confirmation email through the mail provider', 2, { critical: false }),
      span('f', 'audit', 1, { critical: false }),
    ],
    logs: [{ id: 7, level: 'warn', message: 'slow query', offsetMs: 12, spanId: 'b', server: 'OTel · payments' }],
  },
};

/** What the host answers for span `b`: many attributes, one value far wider than the panel, and two events. */
export const spanDetail = {
  type: 'span',
  traceId: 'f1',
  spanId: 'b',
  detail: {
    traceId: 'f1',
    spanId: 'b',
    parentSpanId: 'a',
    name: 'charge card',
    service: 'payments',
    kind: 'client',
    scope: '@opentelemetry/instrumentation-http',
    startMs: 1020,
    durationMs: 95,
    selfMs: 30,
    error: true,
    statusMessage: 'declined: the card issuer refused the charge and asked for another payment method',
    attributes: {
      'http.request.method': 'POST',
      'http.route': '/v1/charges',
      'http.response.status_code': 402,
      'url.full': `https://payments.example.com/v1/charges?${'customer=cus_0123456789&'.repeat(12)}`,
      'server.address': 'payments.example.com',
      'server.port': 443,
      'user_agent.original': 'node-fetch/3.3.2 (+https://github.com/node-fetch/node-fetch)',
      'db.statement': `INSERT INTO charges (${'column_name, '.repeat(40)}id) VALUES (1)`,
      retry: true,
      'net.peer.name': 'payments.internal',
    },
    events: [
      { offsetMs: 40, name: 'retry', attributes: { attempt: 2, reason: 'timeout' } },
      {
        offsetMs: 90,
        name: 'exception',
        attributes: { 'exception.type': 'CardDeclined', 'exception.message': 'declined '.repeat(30) },
      },
    ],
  },
};

const buckets = 24;
const from = Date.UTC(2026, 10, 4, 12, 0);

/** A populated Analyze view: every chart, with long error messages and plenty of values. */
export const analysis = {
  type: 'analysis',
  requestId: 1,
  analysis: {
    rate: Array.from({ length: buckets }, (_, bucket) => ({
      bucket,
      count: 20 + ((bucket * 7) % 30),
      anomalous: bucket === 17,
    })),
    errors: Array.from({ length: buckets }, (_, bucket) => ({
      bucket,
      count: bucket % 5 === 0 ? 6 : 1,
      anomalous: bucket === 17,
    })),
    warnings: Array.from({ length: buckets }, (_, bucket) => ({ bucket, count: bucket % 3 })),
    latency: Array.from({ length: buckets }, (_, bucket) => ({
      bucket,
      average: 80 + bucket * 3,
      p95: 200 + bucket * 9,
      count: 12,
      anomalous: bucket === 20,
    })),
    statusCodes: [
      { code: '200', count: 480 },
      { code: '404', count: 31 },
      { code: '500', count: 12 },
      { code: '503', count: 3 },
    ],
    errorGroups: [
      {
        key: 'chargefailed@/work/billing/charge.ts:55',
        message: `ChargeFailed: the card issuer refused the charge ${'and asked for another payment method '.repeat(4)}`,
        count: 9,
        sampleIds: [3],
        location: '/work/billing/charge.ts:55',
        trend: [0, 1, 0, 2, 1, 0, 3, 1, 0, 1],
        isNew: true,
        query: 'message:"ChargeFailed"',
      },
      {
        key: 'timeout',
        message: 'Error: upstream timeout after 30000 ms calling https://inventory.internal/api/v2/reservations',
        count: 4,
        sampleIds: [5],
        trend: [1, 0, 0, 0, 1, 0, 1, 0, 0, 1],
        query: 'message:"upstream timeout"',
      },
    ],
    patterns: Array.from({ length: 6 }, (_, index) => ({
      key: `pattern ${index}`,
      message: `GET /api/items/${index} responded in ${index * 12} ms for a customer on a very long route`,
      pattern: 'GET /api/items/* responded in * ms for a customer on a very long route',
      level: index === 0 ? 'error' : 'info',
      count: 300 - index * 40,
      sampleIds: [index + 1],
      trend: [1, 3, 2, 4, 3, 5, 4, 3, 2, 3],
      isNew: index === 1,
      query: 'message:"responded in"',
    })),
    range: { from, to: from + buckets * 60000 },
    summary: { events: 526, errors: 42, sources: 2, outside: 0, latency: { p50: 120, p95: 410, p99: 880, count: 288 } },
    topValues: [
      {
        field: 'service',
        label: 'Service',
        total: 526,
        values: [
          { value: 'api', count: 400 },
          { value: 'a-service-with-a-name-long-enough-to-need-truncating', count: 90 },
          { value: 'worker', count: 36 },
        ],
      },
      {
        field: 'level',
        label: 'Level',
        total: 526,
        values: [
          { value: 'info', count: 480 },
          { value: 'error', count: 42 },
        ],
      },
    ],
  },
};

export const aiCall = {
  traceId: 't1',
  spanId: 's1',
  kind: 'model',
  operation: 'chat',
  name: 'chat gpt-4o',
  service: 'agent',
  startMs: 0,
  durationMs: 1200,
  error: false,
  hasContent: true,
  model: 'gpt-4o',
  inputTokens: 100,
  outputTokens: 20,
};
export const aiCalls = {
  type: 'aiCalls',
  aiCalls: {
    calls: [aiCall, { ...aiCall, spanId: 's2', kind: 'tool', tool: 'get_weather', model: undefined }],
    total: 2,
    modelCalls: 1,
    toolCalls: 1,
    agentRuns: 0,
    errors: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 0,
    p50Ms: 1200,
    p95Ms: 1200,
    models: [
      {
        model: 'gpt-4o',
        provider: 'openai',
        calls: 1,
        errors: 0,
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 0,
        p50Ms: 1200,
        p95Ms: 1200,
      },
    ],
    tools: [{ tool: 'get_weather', calls: 1, errors: 0, p95Ms: 180 }],
  },
};
export const aiCallDetail = {
  type: 'aiCall',
  traceId: 't1',
  spanId: 's1',
  detail: {
    call: { ...aiCall, provider: 'openai' },
    messages: [
      { role: 'user', parts: [{ kind: 'text', text: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        output: true,
        parts: [{ kind: 'tool_call', name: 'get_weather', id: 'c1', value: '{ "city": "Paris" }' }],
      },
    ],
    toolRuns: { c1: { spanId: 's2', tool: 'get_weather', durationMs: 180, error: false, result: '{ "high": 14 }' } },
    conversation: [
      { traceId: 't1', spanId: 's1' },
      { traceId: 't1', spanId: 's2' },
    ],
    position: 0,
  },
};
