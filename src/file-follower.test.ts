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
