const test = require('node:test');
const assert = require('node:assert/strict');
const { LogStore, LineReader } = require('./log-store');
const { parseLogLine } = require('./log-event');
const { formatDetails } = require('./format-details');

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
  assert.equal(store.find(900001).id, 900001);
  assert.equal(store.page().events.length, 1000);
  assert.equal(store.page().events.at(-1).id, 1000000);
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
  store.add({ raw: 'x'.repeat(2000) });
  assert.equal(store.discarded, 1);
  assert.equal(store.bytes, 0);
});

test('search, level filtering, history pages and frozen boundaries', () => {
  const store = new LogStore();
  for (let id = 1; id <= 350; id++) {
    store.add({ id, raw: `request ${id}`, level: id % 2 ? 'error' : 'info' });
  }
  assert.equal(store.page({ level: 'error' }).matched, 175);
  assert.equal(store.page({ query: 'REQUEST 350' }).events[0].id, 350);
  assert.equal(store.page({ page: 1 }).events.at(-1).id, 350);
  assert.equal(store.page({ before: 100 }).events.at(-1).id, 100);
});

test('line reader handles split UTF-8, CRLF and a final unterminated line', () => {
  const output = [];
  const reader = new LineReader((line, truncated) => output.push({ line, truncated }));
  const input = Buffer.from('hi 😀\r\nlast');
  for (const byte of input) reader.write(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(output, [{ line: 'hi 😀', truncated: false }, { line: 'last', truncated: false }]);
});

test('newline-free output is bounded and parsing recovers after a truncated line', () => {
  const output = [];
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

test('a level filter on a large store reports the filtered match count, not the total', () => {
  const store = new LogStore();
  for (let id = 1; id <= 20000; id++) {
    store.add({ id, raw: `event ${id}`, message: `event ${id}`, level: id % 5 === 0 ? 'error' : 'info' });
  }
  const result = store.page({ level: 'error' });
  assert.equal(result.matched, 4000);
  assert.equal(result.pages, 4);
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

const event = (id, level, message) =>
  parseLogLine(JSON.stringify({ level, message }), 'stdout', id, new Date());

test('find locates events by id across the whole retained ring', () => {
  const store = new LogStore(50, 1024 * 1024);
  for (let i = 1; i <= 120; i++) store.add(event(i, 'info', `line ${i}`));
  assert.equal(store.find(71).message, 'line 71');
  assert.equal(store.find(120).message, 'line 120');
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
  assert.equal(store.find(100).message, 'line 100', 'the newest events are the ones kept');
  assert.equal(store.find(90), undefined);
  assert.ok(store.bytes <= store.maxBytes);
  store.add(event(101, 'info', 'line 101'));
  assert.equal(store.size, 10, 'the new row budget still holds after a resize');
  assert.equal(store.find(101).message, 'line 101');
});

test('a resize that raises the limits keeps every retained event', () => {
  const store = new LogStore(10, 1024 * 1024);
  for (let i = 1; i <= 10; i++) store.add(event(i, 'info', `line ${i}`));
  store.resize(1000, 4 * 1024 * 1024);
  assert.equal(store.size, 10);
  assert.equal(store.find(1).message, 'line 1');
  assert.equal(store.find(10).message, 'line 10');
});
