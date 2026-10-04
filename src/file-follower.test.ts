import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { FileFollower } from './capture/file-follower';
import { Ingestion } from './capture/ingestion';
import { RuntimeState } from './capture/runtime-state';
import { SessionRegistry } from './capture/session-registry';
import { LogStore } from './core/log-store';

function harness(settings: Record<string, unknown> = {}) {
  const store = new LogStore();
  const registry = new SessionRegistry();
  const state = new RuntimeState(() => undefined);
  const config = { get: <T>(key: string, fallback: T) => (key in settings ? settings[key] : fallback) as T };
  const follower = new FileFollower(config, registry, new Ingestion(store, () => undefined), state);
  return { store, registry, follower, messages: () => store.all().map(event => event.message) };
}

async function eventually(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for followed lines');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('following a file shows its tail, then appended lines, and stops cleanly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'logline-follow-'));
  const file = path.join(dir, 'app.log');
  try {
    await writeFile(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const h = harness({ joinStackTraces: false });
    const id = await h.follower.follow(file, { tailBytes: 30, pollMs: 20 });
    // The tail starts at a whole line, never mid-line.
    assert.deepEqual(h.messages(), ['line 97', 'line 98', 'line 99']);
    await appendFile(file, '{"level":"error","message":"boom","status":500}\npartial');
    await eventually(() => h.messages().includes('boom'));
    assert.equal(h.store.all().at(-1)!.level, 'error');
    assert.ok(!h.messages().includes('partial'), 'an unterminated line waits for its newline');
    await appendFile(file, ' line\n');
    await eventually(() => h.messages().includes('partial line'));
    const record = h.registry.records.get(id)!;
    assert.equal(record.sourceKind, 'file');
    assert.equal(record.canStop, true);
    assert.equal(record.status, 'running');
    assert.equal(h.store.all()[0].serverId, `file:${file}`);
    assert.equal(await h.follower.follow(file), id, 'a file is followed at most once');
    h.follower.stopSessionById(id);
    assert.equal(record.status, 'exited');
    assert.equal(h.follower.active, 0);
    await appendFile(file, 'after stop\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(!h.messages().includes('after stop'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('following survives truncation, rotation and a file that does not exist yet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'logline-follow-'));
  const file = path.join(dir, 'later.log');
  try {
    const h = harness();
    await h.follower.follow(file, { pollMs: 20 });
    await writeFile(file, 'INFO created\n');
    await eventually(() => h.messages().includes('INFO created'));
    await writeFile(file, 'WARN truncated\n');
    await eventually(() => h.messages().includes('WARN truncated'));
    assert.equal(h.store.all().at(-1)!.level, 'warn', 'plain-text file lines get a detected severity');
    await rename(file, `${file}.1`);
    await writeFile(file, 'ERROR rotated\nError: boom\n    at run (/srv/job.js:3:9)\n');
    await eventually(() => h.messages().includes('Error: boom'));
    assert.equal(h.store.all().at(-1)!.raw, 'Error: boom\n    at run (/srv/job.js:3:9)', 'stack traces are joined');
    await h.follower.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the poll timer cannot read a large file from its start before the tail position is known', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'logline-follow-'));
  const file = path.join(dir, 'big.log');
  // The follower calls fs/promises through the module object, so a slow first
  // stat stands in for a busy extension host during start-up.
  const fsPromises: { stat: typeof import('node:fs/promises').stat } = require('node:fs/promises');
  const stat = fsPromises.stat;
  let calls = 0;
  fsPromises.stat = (async (...args: Parameters<typeof stat>) => {
    if (++calls === 1) await new Promise(resolve => setTimeout(resolve, 100));
    return stat(...args);
  }) as typeof stat;
  try {
    await writeFile(file, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const h = harness({ joinStackTraces: false });
    await h.follower.follow(file, { tailBytes: 30, pollMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(h.messages(), ['line 4997', 'line 4998', 'line 4999']);
    await h.follower.dispose();
  } finally {
    fsPromises.stat = stat;
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopping a file source stops only that file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'logline-follow-'));
  const first = path.join(dir, 'first.log');
  const second = path.join(dir, 'second.log');
  try {
    await writeFile(first, '');
    await writeFile(second, '');
    const h = harness();
    const firstId = await h.follower.follow(first, { pollMs: 20 });
    const secondId = await h.follower.follow(second, { pollMs: 20 });
    h.follower.stopServer(`file:${first}`);
    assert.equal(h.registry.records.get(firstId)!.status, 'exited');
    assert.equal(h.registry.records.get(secondId)!.status, 'running');
    assert.equal(h.follower.active, 1);
    await appendFile(first, 'INFO ignored\n');
    await appendFile(second, 'INFO kept\n');
    await eventually(() => h.messages().includes('INFO kept'));
    assert.ok(!h.messages().includes('INFO ignored'));
    await h.follower.dispose();
    assert.equal(h.follower.active, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
