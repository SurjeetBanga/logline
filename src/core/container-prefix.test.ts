import assert from 'node:assert/strict';
import test from 'node:test';
import { Ingestion } from '../capture/ingestion';
import { LinePipeline } from '../capture/line-pipeline';
import { splitContainerPrefix, type ContainerTag } from './container-prefix';
import { LogStore } from './log-store';

test('Compose v2, Compose v1 and kubectl prefixes are split from their payload', () => {
  assert.deepEqual(splitContainerPrefix('api-1  | {"level":"error","msg":"db timeout"}'),
    { tag: { service: 'api', container: 'api-1' }, payload: '{"level":"error","msg":"db timeout"}' });
  assert.deepEqual(splitContainerPrefix('shop_worker_2 | level=warn msg=slow'),
    { tag: { service: 'worker', container: 'shop_worker_2' }, payload: 'level=warn msg=slow' });
  assert.deepEqual(splitContainerPrefix('[pod/api-7d9f8/api] started'),
    { tag: { service: 'api', container: 'pod/api-7d9f8/api', pod: 'api-7d9f8' }, payload: 'started' });
  // Color codes around the prefix, as `docker compose up` prints them.
  assert.equal(splitContainerPrefix('\x1b[36mapi-gateway-1  |\x1b[0m ready')?.tag.service, 'api-gateway');
});

test('ordinary text with a pipe is not a container prefix', () => {
  for (const line of ['a | b', '| col | col |', 'worker | done', 'GET /x | 200', '{"msg":"api-1 | x"}']) {
    assert.equal(splitContainerPrefix(line), undefined, line);
  }
});

test('a Docker timestamp becomes the event time unless the payload has its own', () => {
  const split = splitContainerPrefix('db-1  | 2026-10-03T12:00:01.123456789Z ready to accept connections');
  assert.equal(split?.payload, 'ready to accept connections');
  assert.equal(split?.tag.time, Date.parse('2026-10-03T12:00:01.123Z'));
  const store = new LogStore();
  const ingestion = new Ingestion(store, () => undefined);
  const plain = ingestion.accept(split!.payload, 'stdout', { serverId: 'compose', server: 'Compose', sessionId: 's', container: split!.tag })!;
  assert.equal(plain.timestampMs, Date.parse('2026-10-03T12:00:01.123Z'));
  const own = splitContainerPrefix('db-1  | 2026-10-03T12:00:01Z {"time":"2026-10-03T12:05:00Z","msg":"x"}')!;
  assert.equal(ingestion.accept(own.payload, 'stdout', { serverId: 'compose', server: 'Compose', sessionId: 's', container: own.tag })!.timestampMs,
    Date.parse('2026-10-03T12:05:00Z'));
});

test('each service becomes its own source with a parsed payload', () => {
  const store = new LogStore();
  const persisted: string[] = [];
  const ingestion = new Ingestion(store, raw => persisted.push(raw));
  const pipeline = new LinePipeline((line, truncated, container) => ingestion.accept(line, 'stdout',
    { serverId: 'up', server: 'docker compose up', sessionId: 'run', truncated, persist: true, container }), { join: true, containers: true, flushMs: 0 });
  pipeline.write('Attaching to api-1, db-1', false);
  pipeline.write('api-1  | {"level":"error","msg":"db timeout","durationMs":812}', false);
  pipeline.write('db-1   | LOG:  checkpoint complete', false);
  pipeline.end();
  const events = store.all();
  assert.deepEqual(events.map(event => [event.server, event.serverId, event.level, event.message]), [
    ['docker compose up', 'up', 'info', 'Attaching to api-1, db-1'],
    ['api', 'up::api', 'error', 'db timeout'],
    ['db', 'up::db', 'info', 'LOG:  checkpoint complete']
  ]);
  assert.equal(events[1].fields?.durationMs, 812);
  assert.equal(events[1].fields?.container, 'api-1');
  assert.equal(events[1].sessionId, 'run');
  assert.deepEqual(persisted.slice(1), ['api-1 | {"level":"error","msg":"db timeout","durationMs":812}', 'db-1 | LOG:  checkpoint complete']);
});

test('stack traces are joined per container even when services interleave', () => {
  const out: { line: string; tag?: ContainerTag }[] = [];
  const pipeline = new LinePipeline((line, _truncated, tag) => out.push({ line, tag }), { join: true, containers: true, flushMs: 0 });
  for (const line of [
    'api-1  | Error: boom',
    'web-1  | GET / 200',
    'api-1  |     at handler (/srv/app.js:12:5)',
    'api-1  |     at main (/srv/app.js:3:1)',
    'web-1  | GET /about 200'
  ]) pipeline.write(line, false);
  pipeline.end();
  const api = out.filter(item => item.tag?.service === 'api').map(item => item.line);
  assert.deepEqual(api, ['Error: boom\n    at handler (/srv/app.js:12:5)\n    at main (/srv/app.js:3:1)']);
  assert.deepEqual(out.filter(item => item.tag?.service === 'web').map(item => item.line), ['GET / 200', 'GET /about 200']);
});

test('container prefixes can be turned off', () => {
  const out: string[] = [];
  const pipeline = new LinePipeline(line => out.push(line), { join: false, containers: false });
  pipeline.write('api-1  | ready', false);
  assert.deepEqual(out, ['api-1  | ready']);
});
