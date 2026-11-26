import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonlTail, listFolder } from './jsonl-tail';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'logline-tail-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a tail returns whole lines, holding a partial line until it is complete', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, 'one\ntwo\nthr');
    const tail = new JsonlTail(file);
    const lines: string[] = [];
    assert.equal(await tail.read(1024, (line) => lines.push(line)), 11);
    assert.deepEqual(lines, ['one', 'two']);
    await appendFile(file, 'ee\nfour\n');
    await tail.read(1024, (line) => lines.push(line));
    assert.deepEqual(lines, ['one', 'two', 'three', 'four']);
    assert.equal(await tail.read(1024, (line) => lines.push(line)), 0);
  });
});

test('a file that shrank is read again from its start, and a missing file reads nothing', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, 'first line\nsecond line\n');
    const tail = new JsonlTail(file);
    const lines: string[] = [];
    await tail.read(1024, (line) => lines.push(line));
    await writeFile(file, 'new\n');
    await tail.read(1024, (line) => lines.push(line));
    assert.deepEqual(lines, ['first line', 'second line', 'new']);
    assert.equal(await new JsonlTail(join(dir, 'missing')).read(1024, () => void assert.fail('no lines')), 0);
    assert.deepEqual(await listFolder(join(dir, 'missing')), []);
    assert.deepEqual(await listFolder(dir), ['a.jsonl']);
  });
});

test('a read stops after its byte budget and resumes where it left off', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'a.jsonl');
    await writeFile(file, 'a\n'.repeat(3));
    const tail = new JsonlTail(file);
    const lines: string[] = [];
    // The whole small file fits one chunk, so the budget only gates further chunks.
    await tail.read(0, (line) => lines.push(line));
    assert.equal(lines.length, 0);
    await tail.read(1, (line) => lines.push(line));
    assert.deepEqual(lines, ['a', 'a', 'a']);
  });
});
