// Performance benchmarks for the extension host's hot paths.
//
//   node --expose-gc scripts/benchmark.mjs                 print a table for this build
//   node --expose-gc scripts/benchmark.mjs --root <dir>    measure the build in <dir>/out
//   node --expose-gc scripts/benchmark.mjs --json <file>   also write the results as JSON
//   node --expose-gc scripts/benchmark.mjs --only a,b      measure only these cases
//   node scripts/benchmark.mjs --list                      print the case names, in order, as JSON
//
// scripts/perf-compare.mjs runs this against two builds on the same machine and fails on regressions.
// Each case is independent: one that cannot load in an older build is reported as unavailable.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: '.' },
    json: { type: 'string' },
    only: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
});
const root = path.resolve(args.root);
const only = args.only ? new Set(args.only.split(',')) : undefined;
const load = (module) => import(pathToFileURL(path.join(root, 'out', module)).href);
const gc = globalThis.gc ?? (() => {});

const RETAINED = 50000;
const receivedAt = new Date('2026-09-14T12:00:00Z');
// A credential-shaped value, built at runtime: secret-shaped literals are refused by push protection.
const bearer = ['Bearer', 'synthetic'.repeat(3)].join(' ');
const line = (id) =>
  JSON.stringify({
    level: id % 50 ? 'info' : 'error',
    message: `request ${id}`,
    service: 'api',
    status: id % 50 ? 200 : 500,
    durationMs: id % 200,
    token: 'synthetic-secret',
    requestId: `req-${id}`,
    traceId: (id % 100).toString(16).padStart(32, '0'),
  });

/**
 * Time one operation: warm it up, repeat it in batches of at least 10 ms so fast operations are measurable,
 * and return the median time per operation over the batches.
 */
function time(operation) {
  const warmUntil = performance.now() + 50;
  let calls = 0;
  while (calls < 3 || performance.now() < warmUntil) {
    operation();
    calls++;
  }
  let start = performance.now();
  operation();
  const single = Math.max(performance.now() - start, 0.001);
  const perBatch = Math.max(1, Math.ceil(10 / single));
  const batches = Math.max(5, Math.min(15, Math.floor(1000 / (single * perBatch))));
  const samples = [];
  for (let batch = 0; batch < batches; batch++) {
    start = performance.now();
    for (let i = 0; i < perBatch; i++) operation();
    samples.push((performance.now() - start) / perBatch);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const results = {};
const cases = [];
/** A timed case: `prepare` loads modules and builds fixtures, and returns the operation to time. */
const timed = (name, label, prepare) => cases.push({ name, label, unit: 'ms', prepare, measure: time });
/** A size case: `measure` returns a deterministic quantity, such as bytes sent or memory retained. */
const sized = (name, label, unit, measure) =>
  cases.push({ name, label, unit, prepare: async () => measure, measure: (value) => value() });

/** The shared fixture: 50,000 parsed events retained in a store. */
let fixture;
async function retained() {
  if (fixture) return fixture;
  const { LogStore } = await load('core/log-store.js');
  const { parseLogLine } = await load('core/log-event.js');
  gc();
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const store = new LogStore(RETAINED, 100 * 1024 * 1024);
  for (let id = 1; id <= RETAINED; id++) {
    const event = parseLogLine(line(id), 'stdout', id, receivedAt);
    event.serverId = 'api';
    store.add(event);
  }
  gc();
  gc();
  const heap = process.memoryUsage().heapUsed - heapBefore;
  assert.equal(store.size, RETAINED);
  fixture = { store, heap, parseLogLine, next: RETAINED };
  return fixture;
}

async function snapshotSources() {
  const { store } = await retained();
  const { SessionRegistry } = await load('capture/session-registry.js');
  const { RuntimeState } = await load('capture/runtime-state.js');
  const { buildSnapshot } = await load('vscode/snapshot.js');
  const sources = {
    store,
    config: { get: (_key, fallback) => fallback },
    registry: new SessionRegistry(),
    state: new RuntimeState(() => {}),
    ingestion: { sequence: fixture.next },
    persistence: { persistDropped: 0 },
    searches: { savedSearches: () => [] },
    running: true,
    guideStatus: { version: '', unread: false },
    agentAccess: { status: () => ({ active: false, sources: [] }) },
  };
  return { sources, buildSnapshot };
}

function addEvents(count) {
  const { store, parseLogLine } = fixture;
  for (let i = 0; i < count; i++) {
    const id = ++fixture.next;
    const event = parseLogLine(
      JSON.stringify({ level: 'info', message: 'tick', durationMs: id % 200 }),
      'stdout',
      id,
      receivedAt,
    );
    event.serverId = 'api';
    store.add(event);
  }
}

// Memory first: the heap the fixture retains is measured before any other case has run, so what other cases
// leave behind (compiled code, caches awaiting collection) cannot change it.
sized('heap', 'Heap retained by 50,000 events', 'MiB', async () => (await retained()).heap / 1048576);
sized('estimate', 'Retention estimate for 50,000 events', 'MiB', async () => (await retained()).store.bytes / 1048576);

// Ingestion: what every captured line costs.
timed('ingest', 'Parse and retain 10,000 JSON lines', async () => {
  const { LogStore } = await load('core/log-store.js');
  const { parseLogLine } = await load('core/log-event.js');
  const lines = Array.from({ length: 10000 }, (_, i) => line(i + 1));
  return () => {
    const store = new LogStore(10000, 100 * 1024 * 1024);
    for (let i = 0; i < lines.length; i++) {
      const event = parseLogLine(lines[i], 'stdout', i + 1, receivedAt);
      event.serverId = 'api';
      store.add(event);
    }
  };
});
timed('frame', 'Frame 10,000 lines with stack traces and Compose prefixes', async () => {
  const { LinePipeline } = await load('capture/line-pipeline.js');
  const lines = Array.from({ length: 10000 }, (_, i) =>
    i % 10 === 9 ? `api-1  |     at handler (/srv/app.js:${i}:5)` : `api-1  | {"level":"info","msg":"request ${i}"}`,
  );
  return () => {
    let count = 0;
    const pipeline = new LinePipeline(() => count++, { join: true, containers: true, limit: 65536 });
    for (const text of lines) pipeline.write(text, false);
    pipeline.end();
  };
});
timed('otlp', 'Read an OTLP/JSON request of 2,000 log records', async () => {
  const { readLogs } = await load('core/otlp.js');
  const request = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
        scopeLogs: [
          {
            logRecords: Array.from({ length: 2000 }, (_, i) => ({
              timeUnixNano: String(1_700_000_000_000_000_000n + BigInt(i)),
              severityNumber: 9,
              body: { stringValue: `request ${i}` },
              attributes: [{ key: 'http.route', value: { stringValue: '/orders/:id' } }],
              traceId: i.toString(16).padStart(32, '0'),
            })),
          },
        ],
      },
    ],
  };
  return () => readLogs(request, 0);
});
/** An OTLP/JSON trace request of `count` spans, each with `attributes(i)` as its attributes. */
function spanRequest(count, attributes) {
  const value = (item) => (typeof item === 'number' ? { intValue: String(item) } : { stringValue: String(item) });
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent' } }] },
        scopeSpans: [
          {
            spans: Array.from({ length: count }, (_, i) => ({
              traceId: (i >> 4).toString(16).padStart(32, '0'),
              spanId: (i + 1).toString(16).padStart(16, '0'),
              name: `span ${i}`,
              kind: 3,
              startTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(i) * 1_000_000n),
              endTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(i) * 1_000_000n + 500_000n),
              attributes: Object.entries(attributes(i)).map(([key, item]) => ({ key, value: value(item) })),
            })),
          },
        ],
      },
    ],
  };
}
const httpAttributes = (i) => ({
  'http.request.method': 'GET',
  'http.route': '/orders/:id',
  'http.response.status_code': 200,
  'url.path': `/orders/${i}`,
  'server.address': 'api.internal',
  'user_agent.original': 'checkout/1.0',
});
timed('otlp-spans', 'Read an OTLP/JSON request of 2,000 spans', async () => {
  const { readSpans } = await load('core/otlp.js');
  const request = spanRequest(2000, httpAttributes);
  return () => readSpans(request);
});
timed('otlp-genai', 'Read 50 LLM call spans with 50 KB of messages each', async () => {
  const { readSpans } = await load('core/otlp.js');
  const messages = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'w'.repeat(50 * 1024) }] }]);
  const request = spanRequest(50, () => ({
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': 'gpt-4o',
    'gen_ai.input.messages': messages,
  }));
  return () => readSpans(request);
});
timed('ai-calls', 'List AI calls among 20,000 spans, 2,000 of them GenAI', async () => {
  const { readSpans } = await load('core/otlp.js');
  const { summarizeGenAi } = await load('core/gen-ai.js');
  const spans = readSpans(
    spanRequest(20000, (i) =>
      i % 10
        ? httpAttributes(i)
        : {
            'gen_ai.operation.name': i % 30 ? 'chat' : 'execute_tool',
            'gen_ai.request.model': i % 20 ? 'gpt-4o' : 'claude-sonnet-5-5',
            'gen_ai.tool.name': 'get_weather',
            'gen_ai.usage.input_tokens': 1000 + i,
            'gen_ai.usage.output_tokens': 100,
          },
    ),
  );
  const traces = new Map();
  for (const span of spans) traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
  return () => summarizeGenAi(traces);
});
timed('redact', 'Redact 1,000 lines that carry credentials', async () => {
  const { createRedactor } = await load('core/redaction.js');
  const redactor = createRedactor();
  const lines = Array.from({ length: 1000 }, (_, i) => `call ${i} with ${bearer} for user ${i}@example.com`);
  return () => {
    for (const text of lines) redactor.text(text);
  };
});
timed('sites', 'Index 200 source files and attribute 1,000 events', async () => {
  const { LogSiteIndex, extractLogSites } = await load('core/log-sites.js');
  const { parseLogLine } = await load('core/log-event.js');
  // Each statement has a word of its own, as in real code; the index finds candidates by their longest word.
  const files = Array.from({ length: 200 }, (_, f) => [
    `src/module${f}.ts`,
    Array.from(
      { length: 20 },
      (_, s) => `function f${s}() {\n  logger.info(\`handler${f}stage${s} finished for \${id}\`);\n}`,
    ).join('\n'),
  ]);
  const events = Array.from({ length: 1000 }, (_, i) =>
    parseLogLine(`handler${i % 200}stage${i % 20} finished for ${i}`, 'stdout', i + 1, receivedAt),
  );
  return () => {
    const index = new LogSiteIndex();
    for (const [file, text] of files) index.setFile(file, extractLogSites(file, text));
    let matched = 0;
    for (const event of events) if (index.match(event)) matched++;
    assert.equal(matched, events.length);
  };
});

timed('sites-shared', 'Attribute 1,000 events among 4,000 statements that share their words', async () => {
  const { LogSiteIndex, extractLogSites } = await load('core/log-sites.js');
  const { parseLogLine } = await load('core/log-event.js');
  // Statements told apart only by numbers and short words, such as `retry 2 of 5 failed`.
  const files = Array.from({ length: 200 }, (_, f) => [
    `src/step${f}.ts`,
    Array.from(
      { length: 20 },
      (_, s) => `function f${s}() {\n  logger.info(\`module ${f} step ${s} done for \${id}\`);\n}`,
    ).join('\n'),
  ]);
  const events = Array.from({ length: 1000 }, (_, i) =>
    parseLogLine(`module ${i % 200} step ${i % 20} done for ${i}`, 'stdout', i + 1, receivedAt),
  );
  const index = new LogSiteIndex();
  for (const [file, text] of files) index.setFile(file, extractLogSites(file, text));
  const extra = extractLogSites('src/extra.ts', 'logger.info(`an unrelated statement for ${id}`);');
  let toggle = false;
  return () => {
    // Adding or removing a statement anywhere clears the match cache, so every message is matched afresh.
    index.setFile('src/extra.ts', (toggle = !toggle) ? extra : []);
    for (const event of events) index.match(event);
  };
});

// Reading retained history: what the Logs panel, search, and agents ask for.
timed('page', 'Newest page of 50,000 retained events', async () => {
  const { store } = await retained();
  return () => store.page({ serverId: 'api' });
});
timed('query', 'Evaluate a search over 50,000 events', async () => {
  const { store } = await retained();
  const { parseQuery, matchesQuery } = await load('core/query.js');
  const parsed = parseQuery('level:error status:500 message:"request 4"');
  const events = store.all();
  return () => {
    let matched = 0;
    for (const event of events) if (matchesQuery(event, parsed)) matched++;
    return matched;
  };
});
timed('suggest', 'Autocomplete four keystrokes of a field value', async () => {
  const { store } = await retained();
  return () => {
    for (const value of ['r', 're', 'req', 'req-']) store.fieldSuggestions(`requestId:${value}`);
  };
});
timed('copy', 'Copy the newest 1,000 matching events, redacted', async () => {
  const { store } = await retained();
  const { redactEvent } = await load('core/redaction.js');
  return () => store.page({ serverId: 'api' }).events.map((row) => redactEvent(store.find(row.id)));
});
timed('analysis', 'Analyze 50,000 retained events', async () => {
  const { store } = await retained();
  return () => store.analysis();
});
timed('sort', 'Sort 50,000 events by durationMs', async () => {
  const { store } = await retained();
  return () => store.all({ sort: 'durationMs' });
});
timed('agent-search', 'Agent search page of 200', async () => {
  const { store } = await retained();
  const { AgentLogAccess } = await load('vscode/agent-access.js');
  const { SessionRegistry } = await load('capture/session-registry.js');
  const access = new AgentLogAccess(store, new SessionRegistry(), () => RETAINED);
  const { shareId } = access.shareAll();
  return () => access.search({ shareId, limit: 200 });
});
timed('agent-analyze', 'Agent analysis of the newest 10,000', async () => {
  const { store } = await retained();
  const { AgentLogAccess } = await load('vscode/agent-access.js');
  const { SessionRegistry } = await load('capture/session-registry.js');
  const access = new AgentLogAccess(store, new SessionRegistry(), () => RETAINED);
  const { shareId } = access.shareAll();
  return () => access.analyze({ shareId });
});
timed('traces', 'List traces from 50,000 events', async () => {
  const { store } = await retained();
  const { summarizeTraces } = await load('core/traces.js');
  return () => summarizeTraces([], store.reversePage({ query: 'exists:traceId' }, 5000).events);
});
timed('snapshot', 'Live snapshot of the newest page', async () => {
  const { sources, buildSnapshot } = await snapshotSources();
  return () => buildSnapshot({ type: 'snapshot' }, sources);
});

// Sizes and memory: deterministic, so any growth is real.
sized('snapshot-full', 'Full snapshot message', 'KiB', async () => {
  const { sources, buildSnapshot } = await snapshotSources();
  return JSON.stringify(buildSnapshot({ type: 'snapshot' }, sources)).length / 1024;
});
sized('snapshot-refresh', 'Live refresh message after 50 new events', 'KiB', async () => {
  const { sources, buildSnapshot } = await snapshotSources();
  const full = buildSnapshot({ type: 'snapshot' }, sources);
  addEvents(50);
  sources.ingestion.sequence = fixture.next;
  const have = { last: full.events.at(-1).id, count: full.events.length, version: full.rowsVersion };
  const refresh = buildSnapshot({ type: 'snapshot', have }, sources);
  assert.equal(refresh.events.length, 50, 'a live refresh sends only the new rows');
  return JSON.stringify(refresh).length / 1024;
});

timed('stream', 'Sorted page while 1,000 events stream in, 50 at a time', async () => {
  const { LogStore } = await load('core/log-store.js');
  const { parseLogLine } = await load('core/log-event.js');
  // A store of its own, filled with copies of one parsed event: parsing is measured by `ingest`, and the shared
  // store stays as other cases expect it.
  const template = parseLogLine(line(1), 'stdout', 1, receivedAt);
  template.serverId = 'api';
  let next = 0;
  const copy = () => {
    next++;
    return { ...template, id: next, fields: { ...template.fields, durationMs: (next * 7919) % 1000 } };
  };
  const store = new LogStore(RETAINED, 100 * 1024 * 1024);
  for (let i = 0; i < RETAINED; i++) store.add(copy());
  store.page({ sort: 'durationMs', sortDirection: 'desc' });
  // Twenty refreshes per measurement, so an occasional full re-sort weighs the same in every sample.
  return () => {
    for (let refresh = 0; refresh < 20; refresh++) {
      for (let i = 0; i < 50; i++) store.add(copy());
      store.page({ sort: 'durationMs', sortDirection: 'desc' });
    }
  };
});

if (args.list) {
  console.log(JSON.stringify(cases.map(({ name }) => name)));
  process.exit(0);
}
for (const { name, label, unit, prepare, measure } of cases) {
  if (only && !only.has(name)) continue;
  try {
    const value = await measure(await prepare());
    results[name] = { label, unit, value };
  } catch (error) {
    results[name] = { label, unit, error: String(error instanceof Error ? error.message : error).split('\n')[0] };
  }
}

if (args.json) writeFileSync(args.json, JSON.stringify({ node: process.version, results }, null, 2));
else {
  console.log(
    `Node ${process.version}, ${process.platform}/${process.arch}${globalThis.gc ? '' : ' (run with --expose-gc for heap)'}`,
  );
  for (const { label, unit, value, error } of Object.values(results))
    console.log(`${label}: ${error ? `unavailable (${error})` : `${value.toFixed(unit === 'ms' ? 3 : 1)} ${unit}`}`);
}
