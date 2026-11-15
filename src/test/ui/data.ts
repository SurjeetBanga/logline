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

export const traceDetail = {
  type: 'trace',
  trace: {
    traceId: 'f1',
    durationMs: 120,
    services: ['api', 'payments'],
    errors: 1,
    omitted: 0,
    hotspots: [{ service: 'api', name: 'POST /checkout', count: 1, selfMs: 80, share: 0.66, errors: 0 }],
    spans: [
      {
        spanId: 'a',
        name: 'POST /checkout',
        service: 'api',
        kind: 'server',
        offsetMs: 0,
        durationMs: 120,
        selfMs: 80,
        depth: 0,
        error: false,
        critical: true,
        attributes: { 'http.route': '/checkout' },
        events: [],
      },
      {
        spanId: 'b',
        name: 'charge card',
        service: 'payments',
        kind: 'client',
        offsetMs: 20,
        durationMs: 40,
        selfMs: 40,
        depth: 1,
        error: true,
        critical: false,
        attributes: {},
        events: [],
        statusMessage: 'declined',
      },
    ],
    logs: [{ id: 7, level: 'warn', message: 'slow query', offsetMs: 12, spanId: 'b', server: 'OTel · payments' }],
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
