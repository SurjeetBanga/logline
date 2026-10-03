import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLogSites } from './core/log-sites';
import { parseLogLine } from './core/log-event';
import { withVscode } from './test/vscode-mock';

const executed: string[] = [];
const mock = {
  workspace: { onDidChangeConfiguration: () => ({ dispose() { } }), getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  window: { showInformationMessage: async () => undefined },
  commands: { executeCommand: async (name: string) => { executed.push(name); } }
};
const { LogsController } = withVscode(mock, () => require('./vscode/logs-controller') as typeof import('./vscode/logs-controller'));

function setup(t: { after(fn: () => Promise<void>): void }) {
  const controller = new LogsController({ globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } } as never);
  t.after(() => controller.dispose());
  return controller;
}

test('details link an event to its log statement and trace', t => {
  const controller = setup(t);
  const event = parseLogLine('{"msg":"user 9 logged in","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"}', 'stdout', 1, new Date());
  assert.deepEqual(controller.detailLinks(event), { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  event.location = { file: '/w/src/auth.ts', line: 18 };
  assert.equal(controller.detailLinks(event).site, 'auth.ts:18');
  // With the editor index enabled, the matched statement's workspace path is shown.
  controller.logSites.setFile('src/auth.ts', extractLogSites('src/auth.ts', '\n'.repeat(17) + 'logger.info(`user ${id} logged in`)'));
  controller.lens = { enabled: true, openSite: async () => undefined } as never;
  delete event.location;
  assert.equal(controller.detailLinks(event).site, 'src/auth.ts:18');
});

test('an editor filter request is delivered once with the next snapshot', async t => {
  const controller = setup(t);
  const sent: unknown[] = [];
  controller.notifications.subscribe(message => sent.push(message));
  await controller.showQuery('message:/ready/');
  assert.deepEqual(executed, ['logline.logs.focus']);
  assert.deepEqual(sent, [{ type: 'update' }]);
  assert.equal(controller.snapshot({ type: 'snapshot' }).applyQuery, 'message:/ready/');
  assert.equal(controller.snapshot({ type: 'snapshot' }).applyQuery, undefined);
});
