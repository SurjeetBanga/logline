import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import { LogPersistence } from './storage/log-persistence';
const settings = new Map<string, unknown>();
const warnings: string[] = [];
function persistence() {
  settings.clear(); warnings.length = 0;
  return new LogPersistence({ get: <T>(key: string, fallback: T) => (settings.get(key) ?? fallback) as T }, () => undefined, message => { warnings.push(message); });
}

test('disk backlog stays bounded, reports overflow once, and resumes in order', async () => {
  const p = persistence();
  settings.set('persistLogs', true);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const batches: string[] = [];
  p.writeBatch = async batch => { await blocked; batches.push(batch); };
  const accepted: string[] = [];
  for (let i = 0; i < 300; i++) {
    const line = `${i}:` + 'x'.repeat(32768);
    const dropped = p.persistDropped;
    p.persist(line);
    if (p.persistDropped === dropped) accepted.push(line);
    assert.ok(p.queuedWriteBytes <= 8 * 1024 * 1024);
  }
  p.flushPersist();
  assert.ok(p.persistDropped > 0);
  assert.equal(warnings.length, 1);
  assert.equal(batches.length, 0);
  release();
  await p.persistChain;
  assert.equal(p.queuedWriteBytes, 0);
  assert.equal(batches.join(''), accepted.join('\n') + '\n');
  p.persist('recovered'); p.flushPersist();
  await p.persistChain;
  assert.equal(batches.at(-1), 'recovered\n');
  assert.equal(p.queuedWriteBytes, 0);
});

test('disk writes stay ordered during disposal and oversized lines cannot fill the queue', async () => {
  const p = persistence();
  settings.set('persistLogs', true);
  const batches: string[] = [];
  p.writeBatch = async batch => { await yieldToHost(); batches.push(batch); };
  p.persist('x'.repeat(8 * 1024 * 1024));
  assert.equal(p.queuedWriteBytes, 0);
  assert.equal(p.persistDropped, 1);
  p.persist('first'); p.flushPersist(); p.persist('last');
  await p.dispose();
  assert.equal(batches.join(''), 'first\nlast\n');
  assert.equal(p.queuedWriteBytes, 0);
});
