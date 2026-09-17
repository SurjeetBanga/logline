import assert from 'node:assert/strict';
import test from 'node:test';
import { Ingestion } from './capture/ingestion';
import { LogStore } from './core/log-store';
import { RuntimeState } from './capture/runtime-state';
import { withVscode } from './test/vscode-mock';

let format: 'jsonl' | 'json' | 'csv' | 'md' | undefined;
let destination: { scheme: string; path: string; fsPath: string } | undefined;
let imported: { scheme: string; path: string; fsPath: string }[] = [];
const writes: string[] = [];
const errors: string[] = [];
const warnings: string[] = [];
let failWrite = false;
let failRead = false;
const mock = {
  Uri: { file: (fsPath: string) => ({ scheme: 'file', path: fsPath, fsPath }) },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Workspace: 1 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      writeFile: async (_uri: unknown, bytes: Uint8Array) => { if (failWrite) throw new Error('provider full'); writes.push(Buffer.from(bytes).toString('utf8')); },
      readFile: async () => { if (failRead) throw new Error('provider read failed'); return Buffer.from('{"message":"imported"}\n'); }
    }
  },
  window: {
    showQuickPick: async (items: { format: typeof format }[]) => items.find(item => item.format === format),
    showSaveDialog: async () => destination,
    showOpenDialog: async () => imported,
    withProgress: async (_options: unknown, task: (progress: unknown, token: { isCancellationRequested: boolean }) => Promise<void>) => task({}, { isCancellationRequested: false }),
    showInformationMessage: () => undefined,
    showWarningMessage: (message: string) => { warnings.push(message); },
    showErrorMessage: (message: string) => { errors.push(message); }
  },
  env: { clipboard: { writeText: async (text: string) => { writes.push(text); } } }
};
const { LogTransfer } = withVscode(mock, () => require('./vscode/log-transfer') as typeof import('./vscode/log-transfer'));

function transfer() {
  const store = new LogStore();
  store.add({ id: 1, serverId: 'api', sessionId: 'run', level: 'error', message: 'token=secret', raw: '{"message":"token=secret"}' });
  store.add({ id: 2, serverId: 'web', sessionId: 'run', level: 'info', message: 'other' });
  const settings = { get: <T>(key: string, fallback: T) => {
    if (key === 'redactExports') return true as T;
    if (key === 'redactionFields') return [] as T;
    if (key === 'redactionReplacement') return '[REDACTED]' as T;
    if (key === 'maxLineLength') return 65536 as T;
    return fallback;
  } };
  return { service: new LogTransfer(store, settings, new Ingestion(store, () => { }), new RuntimeState(() => { })), store };
}

test('log transfer covers provider export, markdown/context/copy actions, and non-file imports', async () => {
  writes.length = 0; errors.length = 0; warnings.length = 0; failWrite = false; failRead = false;
  format = 'jsonl'; destination = { scheme: 'mem', path: '/export.jsonl', fsPath: '/export.jsonl' };
  const { service, store } = transfer();
  await service.exportLogs({ serverId: 'api' });
  assert.ok(writes[0].includes('[REDACTED]'));
  assert.doesNotMatch(writes[0], /secret/);
  await service.copyFiltered({ serverId: 'api' });
  assert.ok(writes.some(value => value.includes('"id":1')));
  format = 'md';
  let saved = '';
  service.saveExport = async content => { saved = content; return true; };
  await service.exportForAI({ serverId: 'api' });
  assert.match(saved, /# Logline incident context/);
  await service.exportContext([1, 99]);
  assert.match(saved, /# Logline context/);
  format = 'csv';
  await service.exportContext([1]);
  assert.match(saved, /id,timestamp/);
  imported = [{ scheme: 'mem', path: '/import.jsonl', fsPath: '/import.jsonl' }];
  await service.importLogs();
  assert.equal(store.all().at(-1)?.message, 'imported');
  failRead = true; await service.importLogs();
  assert.match(warnings.at(-1)!, /provider read failed/);
  failWrite = true;
  const { service: failedService } = transfer();
  assert.equal(await failedService.saveExport('broken', 'jsonl', 'broken.jsonl'), false);
  assert.match(errors.at(-1)!, /provider full/);
});
