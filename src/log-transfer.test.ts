import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { withVscode } from './test/vscode-mock';
import { LogStore } from './core/log-store';
import { Ingestion } from './capture/ingestion';
import { RuntimeState } from './capture/runtime-state';

let target: { scheme: string; fsPath: string } | undefined;
let cancelled = false;
let snapshots = 0;
const errors: string[] = [];
const { LogTransfer } = withVscode({
  ProgressLocation: { Notification: 1 },
  workspace: { fs: { writeFile() { throw new Error('Native exports must stream'); } } },
  window: {
    showQuickPick: async () => ({ format: 'jsonl' }),
    showSaveDialog: async () => { assert.equal(snapshots, 0, 'collect only after destination selection'); return target; },
    withProgress: async (_options: unknown, callback: Function) => callback({}, { get isCancellationRequested() { return cancelled; } }),
    showInformationMessage() {}, showErrorMessage: (message: string) => errors.push(message)
  }
}, () => require('./vscode/log-transfer') as typeof import('./vscode/log-transfer'));

test('full export selects a destination before capture and streams a filtered redacted snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'logline-transfer-'));
  try {
    const store = new LogStore();
    const ingestion = new Ingestion(store, () => {});
    for (const serverId of ['api', 'worker']) ingestion.accept('{"message":"line","password":"secret"}', 'stdout', { serverId, server: serverId, sessionId: serverId });
    const collect = store.exportEvents.bind(store);
    store.exportEvents = request => { snapshots++; return collect(request); };
    store.all = () => { throw new Error('Full exports must not clone retained history'); };
    const transfer = new LogTransfer(store, { get: (_key, fallback) => fallback }, ingestion, new RuntimeState(() => {}));
    target = undefined; snapshots = 0;
    await transfer.exportLogs();
    assert.equal(snapshots, 0, 'cancelled destination does no export work');
    target = { scheme: 'file', fsPath: path.join(root, 'logs.jsonl') };
    cancelled = true;
    await transfer.exportLogs();
    assert.equal(snapshots, 0, 'cancelled progress does no export work');
    cancelled = false;
    await transfer.exportLogs({ serverId: 'api' });
    assert.equal(snapshots, 1);
    const text = await readFile(target.fsPath, 'utf8');
    assert.ok(!text.includes('secret'));
    assert.equal(JSON.parse(text).serverId, 'api');
    assert.equal(errors.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
