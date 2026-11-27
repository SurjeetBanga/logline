// What the host would send the panel for the README's scenes: a checkout service whose payment provider times out.
// The shapes follow src/protocol/messages.ts and src/core/*.ts.

// Everything is relative to one instant, so times in the panel are the same on every run.
export const NOW = Date.UTC(2026, 9, 25, 23, 11, 19, 0);
const MINUTE = 60_000;

const TRACE_ID = '00000000000000004bf92f3577b34da8';
const clock = (ms) => new Date(ms).toISOString().slice(11, 23);

// The failing event, which the scenes select and open.
const FAILING_ID = 912;
const FAILING_TIME = Date.UTC(2026, 9, 25, 23, 11, 16, 727);

const errorLines = [
  [
    FAILING_TIME,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8811, attempt: 3, durationMs: 3001 },
  ],
  [
    FAILING_TIME - 7_315,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8809, attempt: 2, durationMs: 3002 },
  ],
  [FAILING_TIME - 18_497, 'Order 8803 left in PENDING after charge failed', 'checkout', '/orders', { orderId: 8803 }],
  [
    FAILING_TIME - 31_204,
    'Inventory reserve failed: connection reset by peer',
    'inventory',
    '/reserve',
    { sku: 'SKU-2291', attempt: 1 },
  ],
  [
    FAILING_TIME - 44_930,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8798, attempt: 3, durationMs: 3000 },
  ],
  [
    FAILING_TIME - 63_108,
    'Cannot read properties of undefined (reading id)',
    'checkout',
    '/cart',
    { cartId: 'c_41f2' },
  ],
  [
    FAILING_TIME - 92_660,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8790, attempt: 3, durationMs: 3004 },
  ],
  [FAILING_TIME - 118_020, 'Order 8781 left in PENDING after charge failed', 'checkout', '/orders', { orderId: 8781 }],
  [
    FAILING_TIME - 141_377,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8776, attempt: 2, durationMs: 3001 },
  ],
  [
    FAILING_TIME - 166_842,
    'Inventory reserve failed: connection reset by peer',
    'inventory',
    '/reserve',
    { sku: 'SKU-1048', attempt: 2 },
  ],
  [
    FAILING_TIME - 190_215,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8769, attempt: 3, durationMs: 3003 },
  ],
  [
    FAILING_TIME - 233_590,
    'Cannot read properties of undefined (reading id)',
    'checkout',
    '/cart',
    { cartId: 'c_3b90' },
  ],
  [
    FAILING_TIME - 268_104,
    'Payment provider timeout after 3000ms',
    'payments',
    '/charge',
    { provider: 'stripe', orderId: 8752, attempt: 3, durationMs: 3002 },
  ],
  [FAILING_TIME - 301_731, 'Order 8747 left in PENDING after charge failed', 'checkout', '/orders', { orderId: 8747 }],
];
const quietLines = [
  ['info', 'POST /api/checkout 201 in 212ms', 'checkout', '/checkout'],
  ['info', 'GET /api/orders 200 in 34ms', 'checkout', '/orders'],
  ['debug', 'cache hit orders:8811', 'checkout', '/orders'],
  ['warn', 'Retrying payment provider (attempt 2 of 3)', 'payments', '/charge'],
  ['info', 'GET /api/cart 200 in 18ms', 'checkout', '/cart'],
  ['info', 'Reserved 2 items for order 8811', 'inventory', '/reserve'],
  ['warn', 'Slow query: select * from orders where user_id = $1 took 412ms', 'checkout', '/orders'],
  ['info', 'POST /api/checkout 201 in 187ms', 'checkout', '/checkout'],
  ['debug', 'db query select * from carts where id = $1', 'checkout', '/cart'],
  ['info', 'GET /api/health 200 in 2ms', 'checkout', '/health'],
];

function row(id, time, level, message, service, route, extra = {}) {
  return {
    id,
    level,
    message,
    timestamp: clock(time),
    timestampMs: time,
    isJson: true,
    stream: 'stdout',
    serverId: 'dev',
    sessionId: 'dev-2',
    fields: { service, route, ...extra },
    ...(id === FAILING_ID ? { traceId: TRACE_ID, site: true } : {}),
  };
}

/** Every event of the Logs view, oldest first as the host sends them. The failing event is id 912. */
export function allEvents() {
  const events = errorLines.map(([time, message, service, route, extra], index) =>
    row(index === 0 ? FAILING_ID : 900 - index * 3, time, 'error', message, service, route, extra),
  );
  // Quieter lines between the errors, so the level marks in the list differ.
  quietLines.forEach(([level, message, service, route], index) => {
    const time = FAILING_TIME - 1_900 - index * 6_100;
    events.push(row(911 - index, time, level, message, service, route, { orderId: 8800 + index }));
  });
  return events.sort((a, b) => a.timestampMs - b.timestampMs);
}

export const errorEvents = () => allEvents().filter((event) => event.level === 'error');

/** Lines that arrive while the demo watches, newest last. */
export function liveEvents(count) {
  const lines = [
    ['info', 'POST /api/checkout 201 in 204ms', 'checkout', '/checkout'],
    ['info', 'GET /api/orders 200 in 29ms', 'checkout', '/orders'],
    ['warn', 'Retrying payment provider (attempt 2 of 3)', 'payments', '/charge'],
    ['info', 'Reserved 1 item for order 8812', 'inventory', '/reserve'],
    ['info', 'GET /api/cart 200 in 21ms', 'checkout', '/cart'],
    ['debug', 'cache hit orders:8812', 'checkout', '/orders'],
  ];
  return lines
    .slice(0, count)
    .map(([level, message, service, route], index) =>
      row(920 + index, FAILING_TIME + 1_100 + index * 1_300, level, message, service, route, { orderId: 8812 }),
    );
}

export const sessions = [
  {
    id: 'dev-1',
    serverId: 'dev',
    server: 'npm run dev',
    command: 'npm run dev',
    status: 'exited',
    exitReason: 'exit 1',
    startedAt: Date.UTC(2026, 9, 25, 23, 1, 23),
    endedAt: Date.UTC(2026, 9, 25, 23, 9, 50),
    sourceKind: 'process',
  },
  {
    id: 'dev-2',
    serverId: 'dev',
    server: 'npm run dev',
    command: 'npm run dev',
    status: 'running',
    startedAt: Date.UTC(2026, 9, 25, 23, 10, 23),
    sourceKind: 'process',
    canStop: true,
    owned: true,
  },
  {
    id: 'test-1',
    serverId: 'test',
    server: 'Task: test (watch)',
    command: 'npm test -- --watch',
    status: 'running',
    startedAt: Date.UTC(2026, 9, 25, 23, 5, 2),
    sourceKind: 'task',
    taskName: 'test (watch)',
    taskType: 'npm',
    canStop: true,
    owned: true,
  },
  {
    id: 'worker-1',
    serverId: 'worker',
    server: 'Server: worker',
    command: 'node worker.js',
    status: 'exited',
    startedAt: Date.UTC(2026, 9, 25, 22, 40, 0),
    endedAt: Date.UTC(2026, 9, 25, 23, 8, 0),
    sourceKind: 'process',
  },
  {
    id: 'otel-1',
    serverId: 'otel',
    server: 'OpenTelemetry · checkout',
    command: 'OpenTelemetry',
    status: 'running',
    startedAt: Date.UTC(2026, 9, 25, 23, 0, 0),
    sourceKind: 'otel',
  },
  {
    id: 'import-1',
    serverId: 'import',
    server: 'Imported · prod-10-23.jsonl',
    command: 'prod-10-23.jsonl',
    status: 'exited',
    startedAt: Date.UTC(2026, 9, 25, 22, 50, 0),
    sourceKind: 'import',
  },
  {
    id: 'dd-1',
    serverId: 'remote:dd',
    server: 'Datadog · prod',
    command: 'status:error · last 1h',
    status: 'exited',
    startedAt: Date.UTC(2026, 9, 25, 22, 41, 7),
    sourceKind: 'remote',
  },
  {
    id: 'claude-1',
    serverId: 'agent:claude-code',
    server: 'Claude Code',
    command: 'Fix the payment timeout on checkout',
    status: 'running',
    startedAt: Date.UTC(2026, 9, 25, 22, 58, 0),
    sourceKind: 'agent',
    detail: '13m · 24 tools · 2 failed',
  },
];

const server = (id, label, status, kind, more = {}) => ({
  id,
  label,
  status,
  kind,
  activeSessions: status === 'running' ? 1 : 0,
  configured: kind === 'process',
  canStop: status === 'running',
  ...more,
});
export const servers = [
  server('dev', 'npm run dev', 'running', 'process'),
  server('test', 'Task: test (watch)', 'running', 'task', {
    taskName: 'test (watch)',
    taskType: 'npm',
    configured: false,
  }),
  server('worker', 'Server: worker', 'exited', 'process'),
  server('otel', 'OpenTelemetry · checkout', 'running', 'otel', { configured: false }),
  server('import', 'Imported · prod-10-23.jsonl', 'exited', 'import', { configured: false }),
  server('remote:dd', 'Datadog · prod', 'exited', 'remote', { configured: false }),
  server('agent:claude-code', 'Claude Code', 'running', 'agent', { configured: false, canStop: false }),
];

export const connections = (agents) => [
  {
    id: 'dd',
    sourceId: 'remote:dd',
    label: 'Datadog · prod',
    type: 'datadog',
    mapped: true,
    sql: false,
    watching: [],
    agents,
    tailing: true,
    tail: { query: 'status:error', native: false },
    last: { sessionId: 'dd-1', kind: 'tail', running: true, fetched: 1024, kept: 1024, local: [] },
  },
  {
    id: 'pg',
    sourceId: 'remote:pg',
    label: 'Postgres · orders',
    type: 'postgres',
    mapped: true,
    sql: true,
    watching: [],
    agents: false,
    tailing: false,
    last: { sessionId: 'pg-1', kind: 'sql', running: false, fetched: 1204, kept: 1204, local: [] },
  },
];

const finding = (o) => ({
  code: 'secret',
  severity: 'warning',
  message: 'Logged a bearer token.',
  file: 'src/pay.ts',
  line: 4,
  siteId: 'src/pay.ts\u00004',
  ...o,
});
export const findings = [
  finding({}),
  finding({
    code: 'noisy',
    severity: 'hint',
    message: 'Logs the same line 480 times a minute.',
    file: 'src/cache.ts',
    line: 22,
    siteId: 'src/cache.ts\u000022',
  }),
];

/** What the host reports about sharing: off, or on for everything with the named agent reading. */
export function sharing({ on = false, reading = [] } = {}) {
  return {
    agentSharing: on
      ? {
          active: true,
          shareId: 'share-1',
          revision: 1,
          scope: 'all',
          sources: [
            { id: 'dev', label: 'npm run dev', sessions: 2, events: 2214, runs: [] },
            { id: 'test', label: 'Task: test (watch)', sessions: 1, events: 640, runs: [] },
          ],
          connections: [
            { id: 'dd', label: 'Datadog · prod', type: 'datadog', agents: true },
            { id: 'pg', label: 'Postgres · orders', type: 'postgres', agents: false },
          ],
        }
      : { active: false, revision: 0, sources: [] },
    agentClients: reading,
    agentSetup: { external: true, copilot: true, connected: ['Claude Code'] },
  };
}

/** The Logs view's snapshot. `events` are the rows to show; the rest is the same in every scene. */
export function snapshot({ events, matched, total = 2214, share = sharing(), otlp = true, ...more } = {}) {
  return {
    type: 'snapshot',
    generation: 1,
    newest: events[0]?.id ?? 0,
    total,
    retained: total,
    discarded: 0,
    bytes: 18.4 * 1024 * 1024,
    maxBytes: 100 * 1024 * 1024,
    maxRows: 200_000,
    truncated: 0,
    persistDropped: 0,
    timezone: 'UTC',
    columns: ['service', 'route'],
    columnFields: ['service', 'route'],
    fields: ['service', 'route', 'provider', 'orderId', 'attempt', 'durationMs'],
    page: 0,
    pages: 1,
    matched: matched ?? events.length,
    events,
    status: 'Running',
    command: 'npm run dev',
    running: true,
    servers,
    sessions,
    connections: connections(share.agentSharing.active),
    searches: { saved: [] },
    guideStatus: { version: '1', unread: false },
    captureTerminals: true,
    otlp: otlp ? { running: true, endpoint: 'http://127.0.0.1:4318' } : { running: false },
    traceCount: 3,
    metrics: { series: 5, revision: 1 },
    aiCalls: { calls: 4, revision: 1 },
    ...share,
    ...more,
  };
}

// Analyze: an hour of logs in two-minute bars, with a burst of errors around 22:51.
const BUCKETS = 30;
const SPIKE = new Set([19, 20, 21, 22]);
const wave = (b) => Math.round(52 + 18 * Math.cos((b - 6) / 5.2) - 0.6 * b);
const errorCount = (b) => ({ 19: 12, 20: 17, 21: 16, 22: 11 })[b] ?? (b % 7 === 3 ? 2 : b % 3 === 0 ? 1 : 0);
export function analysis() {
  const start = NOW - 60 * MINUTE;
  const errors = Array.from({ length: BUCKETS }, (_, bucket) => ({
    bucket,
    count: errorCount(bucket),
    anomalous: SPIKE.has(bucket),
  }));
  const warnings = Array.from({ length: BUCKETS }, (_, bucket) => ({
    bucket,
    count: 2 + (bucket % 3) + (SPIKE.has(bucket) ? 3 : 0),
  }));
  const rate = Array.from({ length: BUCKETS }, (_, bucket) => ({
    bucket,
    count: wave(bucket) + errors[bucket].count + warnings[bucket].count + (SPIKE.has(bucket) ? 34 : 0),
    anomalous: SPIKE.has(bucket),
  }));
  const latency = Array.from({ length: BUCKETS }, (_, bucket) => ({
    bucket,
    average: 70 + (bucket % 5) * 8 + (SPIKE.has(bucket) ? 260 : 0),
    p95: 190 + (bucket % 7) * 25 + (bucket === 20 ? 1750 : SPIKE.has(bucket) ? 900 : 0),
    count: 20,
    anomalous: SPIKE.has(bucket),
  }));
  return {
    rate,
    errors,
    warnings,
    latency,
    statusCodes: [
      { code: '200', count: 1410 },
      { code: '201', count: 520 },
      { code: '404', count: 64 },
      { code: '500', count: 87 },
    ],
    patterns: [
      {
        key: 'post',
        message: 'POST /api/checkout 201 in 212ms',
        pattern: 'POST /api/checkout 201 in *ms',
        level: 'info',
        count: 520,
        sampleIds: [911],
        trend: [8, 9, 9, 11, 12, 20, 24, 21, 12, 10],
        isNew: false,
        query: 'message:"POST /api/checkout"',
      },
      {
        key: 'retry',
        message: 'Retrying payment provider (attempt 2 of 3)',
        pattern: 'Retrying payment provider (attempt * of *)',
        level: 'warn',
        count: 96,
        sampleIds: [908],
        trend: [0, 0, 1, 2, 4, 18, 30, 22, 9, 2],
        isNew: true,
        query: 'message:"Retrying payment provider"',
      },
    ],
    errorGroups: [
      {
        key: 'timeout',
        message: 'Payment provider timeout after 3000ms',
        count: 58,
        sampleIds: [FAILING_ID],
        location: 'src/pay.ts:46',
        trend: [0, 0, 1, 2, 3, 14, 20, 12, 5, 1],
      },
      {
        key: 'pending',
        message: 'Order 8803 left in PENDING after charge failed',
        count: 21,
        sampleIds: [894],
        location: 'src/orders.ts:88',
        trend: [0, 0, 0, 1, 2, 6, 7, 4, 1, 0],
      },
      {
        key: 'reset',
        message: 'Inventory reserve failed: connection reset by peer',
        count: 8,
        sampleIds: [888],
        location: 'src/inventory.ts:31',
        trend: [1, 0, 1, 0, 1, 2, 2, 1, 0, 0],
      },
    ],
    topValues: [
      {
        field: 'service',
        label: 'Service',
        total: 2214,
        values: [
          { value: 'checkout', count: 1320 },
          { value: 'payments', count: 610 },
          { value: 'inventory', count: 284 },
        ],
      },
    ],
    range: { from: start, to: NOW },
    summary: {
      events: 2214,
      errors: 87,
      sources: 1,
      outside: 0,
      latency: { p50: 96, p95: 812, p99: 2122, count: 1930 },
    },
  };
}

// Traces: the checkout whose payment call failed.
const T0 = FAILING_TIME - 3_100;
export const traces = [
  {
    traceId: TRACE_ID,
    name: 'POST /checkout',
    service: 'checkout',
    services: ['checkout', 'payments', 'postgres'],
    startMs: T0,
    durationMs: 3412,
    spans: 7,
    logs: 4,
    errors: 1,
  },
  {
    traceId: 'a1b2c3d4e5f60718',
    name: 'GET /orders',
    service: 'checkout',
    services: ['checkout', 'postgres'],
    startMs: T0 - 6_000,
    durationMs: 96,
    spans: 4,
    logs: 2,
    errors: 0,
  },
  {
    traceId: 'b2c3d4e5f6071829',
    name: 'POST /checkout',
    service: 'checkout',
    services: ['checkout', 'payments', 'postgres'],
    startMs: T0 - 21_000,
    durationMs: 412,
    spans: 7,
    logs: 3,
    errors: 0,
  },
];
const span = (spanId, parentSpanId, name, service, offsetMs, durationMs, selfMs, depth, extra = {}) => ({
  spanId,
  parentSpanId,
  name,
  service,
  kind: 'server',
  offsetMs,
  durationMs,
  selfMs,
  depth,
  error: false,
  critical: false,
  attributes: {},
  events: [],
  ...extra,
});
export const trace = {
  traceId: TRACE_ID,
  startMs: T0,
  durationMs: 3412,
  services: ['checkout', 'payments', 'postgres'],
  errors: 1,
  omitted: 0,
  spans: [
    span('s1', undefined, 'POST /checkout', 'checkout', 0, 3412, 62, 0, {
      critical: true,
      error: true,
      attributes: { 'http.method': 'POST', 'http.status_code': 502 },
    }),
    span('s2', 's1', 'SELECT orders', 'postgres', 14, 48, 48, 1, {
      kind: 'client',
      attributes: { 'db.system': 'postgresql' },
    }),
    span('s3', 's1', 'POST /charge', 'payments', 70, 3250, 140, 1, { critical: true, kind: 'client' }),
    span('s4', 's3', 'validate card', 'payments', 84, 36, 36, 2, { kind: 'internal' }),
    span('s5', 's3', 'stripe.charges.create', 'payments', 128, 3000, 3000, 2, {
      critical: true,
      kind: 'client',
      error: true,
      statusMessage: 'timeout after 3000ms',
      events: [{ offsetMs: 3128, name: 'exception' }],
    }),
    span('s6', 's1', 'UPDATE orders', 'postgres', 3330, 70, 70, 1, { kind: 'client' }),
  ],
  hotspots: [
    { service: 'payments', name: 'stripe.charges.create', count: 1, selfMs: 3000, share: 0.88, errors: 1 },
    { service: 'payments', name: 'POST /charge', count: 1, selfMs: 140, share: 0.04, errors: 0 },
    { service: 'postgres', name: 'UPDATE orders', count: 1, selfMs: 70, share: 0.02, errors: 0 },
  ],
  logs: [
    { id: 905, level: 'info', message: 'Charging order 8811', offsetMs: 90, spanId: 's3', server: 'npm run dev' },
    {
      id: FAILING_ID,
      level: 'error',
      message: 'Payment provider timeout after 3000ms',
      offsetMs: 3128,
      spanId: 's5',
      server: 'npm run dev',
    },
  ],
};

// Compare: production's errors against the newest local runs.
const sample = (id, sessionId, time, region, extra = {}) => ({
  id,
  sessionId,
  timestamp: time,
  level: 'error',
  message: 'Payment provider timeout after 3000ms',
  fields: { service: 'checkout', region, ...extra },
  differs: ['region'],
});
export const compare = {
  baseline: { serverId: 'remote:dd', sessionId: 'dd-1', label: 'Datadog · prod · status:error · last 1h', events: 440 },
  local: { serverId: 'dev', label: 'npm run dev' },
  runs: [
    { id: 'dev-0', label: '22:11', startedAt: Date.UTC(2026, 9, 25, 22, 11, 0) },
    { id: 'dev-1', label: '23:01', startedAt: Date.UTC(2026, 9, 25, 23, 1, 23) },
    { id: 'dev-2', label: '23:10', startedAt: Date.UTC(2026, 9, 25, 23, 10, 23) },
  ],
  summary: '1 production error fixed locally · 1 still reproduces',
  rows: [
    {
      signature: 'sig1',
      message: 'Payment provider timeout after 3000ms',
      pattern: 'Payment provider timeout after <n>ms',
      location: 'src/pay.ts:46',
      baseline: 312,
      runs: [4, 3, 2],
      status: 'reproduced',
      changed: true,
      baselineSample: 1,
      localSample: 2,
      samples: {
        baseline: sample(1, 'dd-1', '20:41:07.112', 'us-east-1'),
        local: sample(2, 'dev-2', '23:11:16.727', 'local'),
      },
    },
    {
      signature: 'sig2',
      message: 'Order <id> left in PENDING after charge failed',
      pattern: 'Order <id> left in PENDING after charge failed',
      location: 'src/orders.ts:88',
      baseline: 87,
      runs: [2, 1, 0],
      status: 'fixed',
      samples: {},
    },
    {
      signature: 'sig3',
      message: 'Deadlock found when trying to get lock',
      pattern: 'Deadlock found when trying to get lock',
      baseline: 41,
      runs: [0, 0, 0],
      status: 'notSeen',
      samples: {},
    },
    {
      signature: 'sig4',
      message: 'Cannot read properties of undefined (reading id)',
      pattern: "Cannot read properties of undefined (reading '<id>')",
      location: 'src/cart.ts:17',
      baseline: 0,
      runs: [0, 0, 5],
      status: 'new',
      changed: true,
      samples: {},
    },
  ],
};

/** The inspector's text and links for an event. */
export function details(id) {
  const failing = id === FAILING_ID;
  const event = allEvents().find((candidate) => candidate.id === id) ?? allEvents()[0];
  const body = {
    time: new Date(event.timestampMs).toISOString(),
    level: event.level,
    msg: event.message,
    service: event.fields.service,
    ...(failing
      ? { provider: 'stripe', orderId: 8811, attempt: 3, durationMs: 3001, traceId: TRACE_ID }
      : { route: event.fields.route }),
  };
  return {
    type: 'details',
    id,
    target: 'main',
    text: JSON.stringify(body, null, 2),
    exceptions: [],
    // The host marks an error, as Analyze counts them, so Investigate can hand it to an agent.
    ...(event.level === 'error' || event.level === 'fatal' ? { error: true } : {}),
    ...(failing ? { site: 'pay.ts:46', traceId: TRACE_ID, findings: [] } : {}),
  };
}

// AI calls and metrics are only counted in the tab labels of these scenes.
export const emptyAiCalls = {
  calls: [],
  total: 0,
  modelCalls: 0,
  toolCalls: 0,
  agentRuns: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  p50Ms: 0,
  p95Ms: 0,
  models: [],
  tools: [],
};
