import test from 'node:test';
import assert from 'node:assert/strict';
import { LogStore, LineReader } from './log-store';
import { parseLogLine } from './log-event';
import { formatDetails } from './format-details';
import type { LogEvent } from './types';

test('detail formatting preserves whitespace inside strings and large numeric IDs', () => {
  const raw = '{"message":"a  b", "id":9007199254740993,"empty":{},"list":[1,true]}';
  assert.match(formatDetails(raw), /"id": 9007199254740993/);
  assert.equal(JSON.parse(formatDetails(raw)).message, 'a  b');
  assert.equal(formatDetails('{"a":[1,2]}'), JSON.stringify({ a: [1, 2] }, null, 2));
});

test('deep detail expansion has a bounded output size', () => {
  const raw = '['.repeat(10000) + '1' + ']'.repeat(100000);
  assert.ok(formatDetails(raw, 8).length < 263000);
});

test('a million incoming events retain only the newest 100,000', () => {
  const store = new LogStore();
  for (let id = 1; id <= 1000000; id++) {
    store.add({ id, raw: `event ${id}`, message: `event ${id}`, level: 'info' });
  }
  assert.equal(store.size, 100000);
  assert.equal(store.total, 1000000);
  assert.equal(store.discarded, 900000);
  assert.ok(store.bytes <= store.maxBytes);
  assert.equal(store.find(900000), undefined);
  assert.equal(store.find(900001)!.id, 900001);
  assert.equal(store.page().events.length, 1000);
  assert.equal(store.page().events.at(-1)!.id, 1000000);
});

test('byte budget evicts before the row budget and releases references', () => {
  const store = new LogStore(5000, 4096);
  for (let id = 1; id <= 1000; id++) store.add({ id, raw: 'x'.repeat(1000), level: 'info' });
  assert.equal(store.size, 1);
  assert.ok(store.bytes <= 4096);
  assert.equal(store.slots.filter(Boolean).length, 1);
  store.clear();
  assert.equal(store.bytes, 0);
  assert.equal(store.total, 0);
  assert.equal(store.slots.filter(Boolean).length, 0);
});

test('oversized records cannot exceed the storage budget', () => {
  const store = new LogStore(10, 1024);
  // id/level are irrelevant here — the record is rejected for its size before
  // either is ever read.
  store.add({ raw: 'x'.repeat(2000) } as LogEvent);
  assert.equal(store.discarded, 1);
  assert.equal(store.bytes, 0);
});

test('server indexes release evicted records under the memory budget', () => {
  const store = new LogStore(5000, 8192);
  for (let id = 1; id <= 3000; id++) {
    const serverId = id < 10 ? `finished-${id}` : 'api';
    store.add({ id, raw: 'x'.repeat(1000), level: 'info', serverId, fields: { serverId } });
  }
  const referenced = [...store.serverIndex.values()].flatMap(index => index.items.filter(slot => slot !== undefined));
  assert.equal(referenced.length, store.size);
  assert.ok(referenced.every(slot => store.find(slot.event.id) === slot.event));
  assert.deepEqual([...store.serverIndex.keys()], ['api'], 'empty server indexes are removed');
});

test('search, level filtering, history pages and frozen boundaries', () => {
  const store = new LogStore();
  for (let id = 1; id <= 350; id++) {
    store.add({ id, raw: `request ${id}`, level: id % 2 ? 'error' : 'info' });
  }
  assert.equal(store.page({ levels: ['error'] }).matched, 175);
  assert.equal(store.page({ query: 'REQUEST 350' }).events[0].id, 350);
  assert.equal(store.page({ page: 1 }).events.at(-1)!.id, 350);
  assert.equal(store.page({ before: 100 }).events.at(-1)!.id, 100);
});

test('line reader handles split UTF-8, CRLF and a final unterminated line', () => {
  const output: { line: string; truncated: boolean }[] = [];
  const reader = new LineReader((line, truncated) => output.push({ line, truncated }));
  const input = Buffer.from('hi 😀\r\nlast');
  for (const byte of input) reader.write(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(output, [{ line: 'hi 😀', truncated: false }, { line: 'last', truncated: false }]);
});

test('newline-free output is bounded and parsing recovers after a truncated line', () => {
  const output: { line: string; truncated: boolean }[] = [];
  const reader = new LineReader((line, truncated) => output.push({ line, truncated }), 16);
  for (let i = 0; i < 10000; i++) reader.write(Buffer.from('x'.repeat(1024)));
  assert.equal(reader.pending.length, 16);
  reader.write(Buffer.from('\n{"ok":true}\n'));
  reader.end();
  assert.deepEqual(output, [{ line: 'x'.repeat(16), truncated: true }, { line: '{"ok":true}', truncated: false }]);
});

test('messages preserve repeated spaces and Pino numeric levels', () => {
  const event = parseLogLine('{"level":50,"msg":"a  b    c"}', 'stdout', 1, new Date());
  assert.equal(event.message, 'a  b    c');
  assert.equal(event.level, 'error');
});

test('columns prefers known fields in a fixed order and caps at six', () => {
  const store = new LogStore();
  store.add({ id: 1, raw: '{}', level: 'info', fields: { host: 'h', service: 'api', junk: 'x' } });
  store.add({ id: 2, raw: '{}', level: 'info', fields: { status: 200, method: 'GET', path: '/', durationMs: 5, environment: 'prod', traceId: 't' } });
  assert.deepEqual(store.columns(), ['service', 'traceId', 'method', 'path', 'status', 'durationMs']);
});

test('the large-store fast path agrees with the general search path', () => {
  const store = new LogStore();
  for (let id = 1; id <= 20000; id++) {
    store.add({ id, raw: `event ${id}`, message: `event ${id}`, level: id % 5 === 0 ? 'error' : 'info' });
  }
  const fast = store.page();
  const general = store.page({ before: store.total });
  assert.deepEqual(fast.events, general.events.slice(0, 1000));
  assert.equal(fast.matched, general.matched);
  assert.equal(fast.matched, store.size);
});

test('the per-server fast path agrees with the general search path', () => {
  const store = new LogStore();
  for (let id = 1; id <= 20000; id++) {
    const serverId = id % 3 === 0 ? 'api' : 'web';
    store.add({ id, raw: `event ${id}`, message: `event ${id}`, level: 'info', serverId, fields: { serverId } });
  }
  const fast = store.page({ query: 'serverId:api' });
  const general = store.page({ query: 'serverId:api', before: store.total });
  assert.deepEqual(fast.events, general.events.slice(0, 1000));
  assert.equal(fast.matched, general.matched);
  assert.equal(fast.matched, Math.floor(20000 / 3));
});

test('server searches preserve substring, case and regex matching across live and history views', () => {
  const store = new LogStore();
  const servers = ['api', 'api-worker', 'API', 'web', '/api/'];
  for (let id = 1; id <= 20000; id++) {
    const serverId = servers[id % servers.length];
    store.add({ id, level: 'info', serverId, fields: { serverId } });
  }
  for (const query of ['serverId:api', 'serverId:API', 'serverId:worker', 'serverId:/api/', 'serverId:/api/g', '-serverId:api']) {
    const live = store.page({ query });
    const history = store.page({ query, before: store.total });
    assert.deepEqual(live, history, query);
  }
  assert.equal(store.page({ query: 'serverId:api' }).matched, 16000);
  assert.equal(store.page({ query: 'serverId:worker' }).matched, 4000);
});

test('the per-server fast path stays correct after evictions and a resize', () => {
  const store = new LogStore(30000, 1024 * 1024 * 1024);
  for (let id = 1; id <= 40000; id++) {
    const serverId = id % 2 ? 'a' : 'b';
    store.add({ id, raw: `event ${id}`, message: `event ${id}`, level: 'info', serverId, fields: { serverId } });
  }
  let fast = store.page({ query: 'serverId:b' });
  let general = store.page({ query: 'serverId:b', before: store.total });
  assert.deepEqual(fast.events, general.events.slice(0, 1000));
  assert.equal(fast.matched, general.matched);
  store.resize(12000, 1024 * 1024 * 1024);
  fast = store.page({ query: 'serverId:b' });
  general = store.page({ query: 'serverId:b', before: store.total });
  assert.deepEqual(fast.events, general.events.slice(0, 1000));
  assert.equal(fast.matched, general.matched);
});

test('a level filter on a large store reports the filtered match count, not the total', () => {
  const store = new LogStore();
  for (let id = 1; id <= 20000; id++) {
    store.add({ id, raw: `event ${id}`, message: `event ${id}`, level: id % 5 === 0 ? 'error' : 'info' });
  }
  const result = store.page({ levels: ['error'] });
  assert.equal(result.matched, 4000);
  assert.equal(result.pages, 4);
});

test('levels filters to exactly the checked set, in any combination', () => {
  const store = new LogStore();
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  for (let id = 1; id <= 60; id++) store.add({ id, raw: `e${id}`, message: `e${id}`, level: levels[id % levels.length] });
  const warnOnly = store.page({ levels: ['warn'] });
  const warnAndFatal = store.page({ levels: ['warn', 'fatal'] });
  const none = store.page({ levels: [] });
  const all = store.page({});
  assert.equal(warnOnly.matched, 10);
  assert.equal(warnAndFatal.matched, 20, 'a combination that skips levels in between');
  assert.equal(none.matched, 0, 'an empty selection matches nothing, unlike omitting levels entirely');
  assert.equal(all.matched, 60, 'omitting levels applies no filter');
  assert.ok(warnOnly.events.every(event => event.level === 'warn'));
});

test('all returns filtered retained events chronologically for exports', () => {
  const store = new LogStore();
  store.add({ id: 1, level: 'info', message: 'one', serverId: 'api', server: 'API' });
  store.add({ id: 2, level: 'error', message: 'two', serverId: 'web', server: 'Web' });
  store.add({ id: 3, level: 'error', message: 'three', serverId: 'api', server: 'API' });
  const events = store.all({ query: 'serverId:api', levels: ['error'] });
  assert.deepEqual(events.map(event => event.id), [3]);
  assert.deepEqual(store.all({ serverId: 'api' }).map(event => event.id), [1, 3]);
  assert.deepEqual(store.serverIds(), ['api', 'web']);
  assert.equal(store.serverLabel('api'), 'API');
});

test('analysis helpers provide facets, arbitrary sorting, groups and charts', () => {
  const store = new LogStore();
  const add = (id: number, level: string, message: string, fields: Record<string, string | number | boolean>, timestampMs: number) =>
    store.add({ id, level, message, timestampMs, timestamp: new Date(timestampMs).toISOString(), fields, sessionId: id < 3 ? 'one' : 'two' });
  add(1, 'error', 'timeout for user 123', { service: 'api', statusCode: 500, durationMs: 80 }, 1000);
  add(2, 'error', 'timeout for user 456', { service: 'api', statusCode: 500, durationMs: 100 }, 1100);
  add(3, 'info', 'ok', { service: 'web', statusCode: 200, durationMs: 20 }, 1200);
  assert.deepEqual(store.page({ sort: 'durationMs', sortDirection: 'desc' }).events.map(event => event.id), [2, 1, 3]);
  assert.equal(store.facets('service').find(value => value.value === 'api')?.count, 2);
  assert.equal(store.fieldSuggestions('ser').fields.includes('service'), true);
  const analysis = store.analysis();
  assert.equal(analysis.errorGroups[0].count, 2);
  assert.equal(analysis.statusCodes.find(value => value.code === '500')?.count, 2);
  assert.equal(analysis.patterns.find(pattern => pattern.message === 'timeout for user 123')?.count, 2);
  assert.equal(store.all({ from: 1100, to: 1200 }).length, 2);
});

test('page and all restrict results to one capture session', () => {
  const store = new LogStore();
  store.add({ id: 1, level: 'info', message: 'a', sessionId: 'run1' });
  store.add({ id: 2, level: 'info', message: 'b', sessionId: 'run2' });
  store.add({ id: 3, level: 'info', message: 'c', sessionId: 'run1' });
  assert.deepEqual(store.page({ sessionId: 'run1' }).events.map(event => event.id), [1, 3]);
  assert.deepEqual(store.all({ sessionId: 'run1' }).map(event => event.id), [1, 3]);
  assert.equal(store.page({ sessionId: 'nope' }).matched, 0);
});

test('fieldSuggestions autocompletes a value for the field typed before the colon', () => {
  const store = new LogStore();
  store.add({ id: 1, level: 'info', message: 'x', fields: { service: 'api' } });
  store.add({ id: 2, level: 'info', message: 'x', fields: { service: 'api' } });
  store.add({ id: 3, level: 'info', message: 'x', fields: { service: 'worker' } });
  const suggestions = store.fieldSuggestions('service:ap');
  assert.deepEqual(suggestions.values, [{ value: 'api', count: 2 }]);
  assert.equal(store.fieldSuggestions('service:worker').values[0]?.count, 1);
  assert.equal(store.fieldSuggestions('nomatch:xyz').values.length, 0);
});

test('fieldNames lists builtin fields plus every observed payload field, sorted', () => {
  const store = new LogStore();
  store.add({ id: 1, level: 'info', message: 'x', fields: { zebra: 1, apple: 2 } });
  const names = store.fieldNames();
  assert.ok(names.includes('traceId'), 'builtin fields are always offered');
  assert.ok(names.includes('zebra') && names.includes('apple'), 'observed payload fields are included');
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), names, 'the list is sorted');
});

test('log patterns cluster every retained event, any level, by normalized message template', () => {
  const store = new LogStore();
  const add = (id: number, level: string, message: string, timestampMs: number) =>
    store.add({ id, level, message, timestampMs, timestamp: new Date(timestampMs).toISOString() });
  add(1, 'info', 'user 1 logged in', 0);
  add(2, 'info', 'user 2 logged in', 500);
  add(3, 'info', 'user 3 logged in', 900);
  add(4, 'warn', 'cache miss for key abc', 950);
  const patterns = store.patterns();
  assert.equal(patterns[0].message, 'user 1 logged in');
  assert.equal(patterns[0].count, 3);
  assert.equal(patterns[0].level, 'info');
  assert.equal(patterns[0].trend.reduce((sum, value) => sum + value, 0), 3);
  const cacheMiss = patterns.find(pattern => pattern.message === 'cache miss for key abc');
  assert.equal(cacheMiss?.count, 1);
  assert.equal(cacheMiss?.level, 'warn');
});

test('log patterns are capped at the top 10 by volume', () => {
  const store = new LogStore();
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar'];
  let id = 0;
  for (let template = 0; template < words.length; template++) {
    for (let occurrence = 0; occurrence <= template; occurrence++) {
      store.add({ id: ++id, level: 'info', message: `${words[template]} pattern occurred`, timestampMs: id, timestamp: new Date(id).toISOString() });
    }
  }
  const patterns = store.patterns();
  assert.equal(patterns.length, 10);
  assert.equal(patterns[0].message, 'oscar pattern occurred');
});

test('analysis flags rate buckets that spike against the series baseline, not raw counts alone', () => {
  const store = new LogStore();
  for (let i = 0; i < 20; i++) store.add({ id: i + 1, level: 'info', message: 'heartbeat', timestampMs: i * 100, timestamp: new Date(i * 100).toISOString() });
  const burstStart = 2900;
  for (let i = 0; i < 30; i++) store.add({ id: 1000 + i, level: 'info', message: 'burst', timestampMs: burstStart + i, timestamp: new Date(burstStart + i).toISOString() });
  const analysis = store.analysis();
  const peak = Math.max(...analysis.rate.map(bucket => bucket.count));
  const spike = analysis.rate.find(bucket => bucket.count === peak);
  assert.equal(spike?.anomalous, true);
  const quiet = analysis.rate.filter(bucket => bucket.count > 0 && bucket.count < peak);
  assert.ok(quiet.length > 0);
  assert.ok(quiet.every(bucket => bucket.anomalous === false));
});

test('error groups fingerprint by exception type and originating stack frame, not raw message text', () => {
  const store = new LogStore();
  const raw = (payload: unknown) => JSON.stringify(payload);
  store.add({ id: 1, level: 'error', isJson: true, message: 'Failed to charge card ending 4242',
    raw: raw({ message: 'Failed to charge card ending 4242',
      err: { type: 'PaymentError', message: 'card declined', stack: 'PaymentError: card declined\n    at charge (/work/billing.ts:55:3)' } }) });
  store.add({ id: 2, level: 'error', isJson: true, message: 'Failed to charge card ending 9999 for premium plan',
    raw: raw({ message: 'Failed to charge card ending 9999 for premium plan',
      err: { type: 'PaymentError', message: 'insufficient funds', stack: 'PaymentError: insufficient funds\n    at charge (/work/billing.ts:55:3)' } }) });
  store.add({ id: 3, level: 'error', isJson: true, message: 'Failed to charge card ending 1111',
    raw: raw({ message: 'Failed to charge card ending 1111',
      err: { type: 'PaymentError', message: 'card declined', stack: 'PaymentError: card declined\n    at charge (/work/refund.ts:80:5)' } }) });
  const groups = store.errorGroups();
  assert.equal(groups.length, 2);
  const billing = groups.find(group => group.location === '/work/billing.ts:55');
  assert.equal(billing?.count, 2, 'differently-worded messages from the same call site should still merge');
  const refund = groups.find(group => group.location === '/work/refund.ts:80');
  assert.equal(refund?.count, 1, 'the same exception type/message from a different call site should not merge');
});

test('formatDetails marks output truncated at the byte limit', () => {
  const raw = '[' + Array.from({ length: 5000 }, (_, i) => `${i}`).join(',') + ']';
  const output = formatDetails(raw, 2, 100);
  assert.ok(output.endsWith('[Formatted preview truncated]'));
  assert.ok(output.length < 200);
});

test('formatDetails clamps indentation width to 1-8 spaces', () => {
  assert.equal(formatDetails('{"a":1}', 1), '{\n "a": 1\n}');
  assert.equal(formatDetails('{"a":1}', 20), '{\n        "a": 1\n}');
});

test('formatDetails passes through a top-level scalar unchanged', () => {
  assert.equal(formatDetails('"just a string"'), '"just a string"');
  assert.equal(formatDetails('42'), '42');
});

const event = (id: number, level: string, message: string) =>
  parseLogLine(JSON.stringify({ level, message }), 'stdout', id, new Date());

test('find locates events by id across the whole retained ring', () => {
  const store = new LogStore(50, 1024 * 1024);
  for (let i = 1; i <= 120; i++) store.add(event(i, 'info', `line ${i}`));
  assert.equal(store.find(71)!.message, 'line 71');
  assert.equal(store.find(120)!.message, 'line 120');
  assert.equal(store.find(1), undefined, 'evicted ids are not found');
  assert.equal(store.find(999), undefined, 'unseen ids are not found');
});

test('resize applies new retention limits to already retained events', () => {
  const store = new LogStore(100, 1024 * 1024);
  for (let i = 1; i <= 100; i++) store.add(event(i, 'info', `line ${i}`));
  const before = store.total;
  store.resize(10, 1024 * 1024);
  assert.equal(store.size, 10);
  assert.equal(store.total, before, 'the received counter survives a resize');
  assert.equal(store.find(100)!.message, 'line 100', 'the newest events are the ones kept');
  assert.equal(store.find(90), undefined);
  assert.ok(store.bytes <= store.maxBytes);
  store.add(event(101, 'info', 'line 101'));
  assert.equal(store.size, 10, 'the new row budget still holds after a resize');
  assert.equal(store.find(101)!.message, 'line 101');
});

test('a resize that raises the limits keeps every retained event', () => {
  const store = new LogStore(10, 1024 * 1024);
  for (let i = 1; i <= 10; i++) store.add(event(i, 'info', `line ${i}`));
  store.resize(1000, 4 * 1024 * 1024);
  assert.equal(store.size, 10);
  assert.equal(store.find(1)!.message, 'line 1');
  assert.equal(store.find(10)!.message, 'line 10');
});
