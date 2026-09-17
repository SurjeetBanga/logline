import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LogStore } from '../out/core/log-store.js';
import { parseLogLine } from '../out/core/log-event.js';
import { redactEvent } from '../out/core/redaction.js';
import { AgentLogAccess } from '../out/vscode/agent-access.js';
import { SessionRegistry } from '../out/capture/session-registry.js';

// Diagnostic microbenchmark, not a timing assertion in the test suite.
const store = new LogStore(50000, 100 * 1024 * 1024);
const receivedAt = new Date('2026-09-14T12:00:00Z');
const start = performance.now();
for (let id = 1; id <= 50000; id++) {
  const event = parseLogLine(JSON.stringify({ level: 'info', message: `request ${id}`, service: 'api',
    status: 200, durationMs: id % 200, token: 'synthetic-secret', requestId: `req-${id}` }), 'stdout', id, receivedAt);
  event.serverId = 'api';
  store.add(event);
}
assert.equal(store.size, 50000);
console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
console.log(`Parsed and retained 50,000 events: ${(performance.now() - start).toFixed(1)} ms; estimated storage ${(store.bytes / 1048576).toFixed(1)} MiB`);

function measure(label, action) {
  action(); // warm up
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    action();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(`${label}: ${times[2].toFixed(2)} ms (median of 5)`);
}

const request = { serverId: 'api' };
const oldSelection = () => store.all(request).map(event => redactEvent(event)).slice(-1000);
const boundedSelection = () => store.page(request).events.map(row => redactEvent(store.find(row.id)));
assert.deepEqual(boundedSelection(), oldSelection());
measure('Previous clipboard pipeline: clone/redact all matches, then limit', oldSelection);
measure('Bounded clipboard pipeline: page, then clone/redact', boundedSelection);
measure('Indexed latest page', () => store.page(request));
measure('Cached filtered page', () => store.page({ query: 'service:api status:200' }));
measure('Indexed autocomplete', () => store.fieldSuggestions('service:'));
const access = new AgentLogAccess(store, new SessionRegistry(), () => 50000);
const share = access.shareAll();
measure('Agent search page', () => access.search({ shareId: share.shareId, limit: 200 }));
measure('Agent analysis newest 10,000', () => access.analyze({ shareId: share.shareId }));
measure('Retained analysis', () => store.analysis());
