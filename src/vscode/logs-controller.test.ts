import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

const notices: string[] = [];
let buttons: string[] = [];
const settings: { key: string; value: unknown }[] = [];
let pick: (items: { runId: string }[]) => unknown = () => undefined;
const mock = {
  ConfigurationTarget: { Workspace: 2 },
  extensions: { getExtension: () => undefined },
  workspace: {
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
      update: async (key: string, value: unknown) => {
        settings.push({ key, value });
      },
    }),
  },
  window: {
    showInformationMessage: async (message: string, ...actions: unknown[]) => {
      notices.push(message);
      buttons = actions.filter((action): action is string => typeof action === 'string');
      return undefined;
    },
    showWarningMessage: async (message: string) => {
      notices.push(message);
      return undefined;
    },
    showQuickPick: async (items: { runId: string }[]) => pick(items),
  },
};
const { LogsController } = withVscode(mock, () => require('./logs-controller') as typeof import('./logs-controller'));

function setup(t: { after(fn: () => Promise<void>): void }) {
  notices.length = 0;
  settings.length = 0;
  pick = () => undefined;
  const controller = new LogsController({
    globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
  } as unknown as import('vscode').ExtensionContext);
  t.after(() => controller.dispose());
  return controller;
}

test('editor features that this host or window lacks are explained instead of failing', async (t) => {
  const controller = setup(t);
  await controller.openLogSite(404);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', message: 'no statement for this' });
  await controller.openLogSite(1);
  await controller.connectAgent();
  await controller.doctorAction('report');
  await controller.breakOnEvent(1);
  await controller.breakOnQuery('level:error', []);
  assert.deepEqual(notices, [
    'This event has been discarded from retained history.',
    'Logline could not find the log statement for this event in the workspace.',
    'Logline is not accepting MCP clients in this window. Turn on logline.externalAgents to connect Claude Code or Codex.',
    'Log doctor needs a VS Code host with diagnostics support.',
    'Log breakpoints need a VS Code host with debugging support.',
    'Log breakpoints need a VS Code host with debugging support.',
  ]);
});

test('sharing from an event that is gone, or choosing no runs, shares nothing', async (t) => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  await controller.shareWithAgent(undefined, 404);
  assert.match(notices.at(-1)!, /That log event is no longer available/);

  // Choosing runs, then clearing every choice, stops sharing.
  controller.agentAccess.share(['api'], undefined, ['a']);
  pick = () => [];
  await controller.shareWithAgent(undefined, undefined, undefined, true);
  assert.equal(controller.agentAccess.status().active, false);
});

test('without Copilot, the sharing notice offers no Ask Copilot button', async (t) => {
  const controller = setup(t);
  controller.store.add({ level: 'info', id: 1, serverId: 'api', sessionId: 'a', message: 'first' });
  pick = (items) => items;
  await controller.shareWithAgent(undefined, undefined, undefined, true);
  assert.equal(controller.agentAccess.status().active, true);
  assert.match(notices.at(-1)!, /^Logline: The selected command runs are now shared with agents/);
  assert.deepEqual(buttons, []);
});

test('secrets in output that no statement accounts for are found once, and found again after a clear', async (t) => {
  const controller = setup(t);
  // Built at runtime: secret-shaped literals are refused by push protection.
  const token = ['Bearer', 'x'.repeat(24)].join(' ');
  controller.store.add({ level: 'info', id: 1, serverId: 'api', message: `calling upstream with ${token}` });
  const first = controller.unclaimedSensitive();
  assert.equal(first.more, false);
  assert.equal(first.findings.length, 1);
  assert.doesNotMatch(JSON.stringify(first.findings), /x{24}/, 'only a masked preview is kept');
  assert.equal(controller.unclaimedSensitive().version, first.version, 'nothing new, nothing rescanned');

  controller.clear();
  assert.equal(controller.unclaimedSensitive().findings.length, 0);
  controller.store.add({ level: 'info', id: 2, serverId: 'api', message: `retry with ${token}` });
  assert.equal(controller.unclaimedSensitive().findings.length, 1);
});

test('traces, metrics, and telemetry findings read the window stores, and findings are cached', async (t) => {
  const controller = setup(t);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  controller.store.add({ level: 'info', id: 1, serverId: 'api', message: 'GET /orders', fields: { traceId } });
  assert.deepEqual(
    controller.traceList().map((trace) => trace.traceId),
    [traceId],
  );
  assert.equal(controller.traceView(traceId.toUpperCase()).traceId, traceId);
  assert.deepEqual(controller.metricList(), []);
  const findings = controller.telemetryFindings();
  assert.equal(controller.telemetryFindings(), findings, 'unchanged stores reuse the last result');
});

test('terminal capture is switched in the workspace settings and takes effect at once', async (t) => {
  const controller = setup(t);
  await controller.toggleTerminalCapture(true);
  await controller.toggleTerminalCapture(false);
  assert.deepEqual(settings, [
    { key: 'captureTerminals', value: true },
    { key: 'captureTerminals', value: false },
  ]);
});
