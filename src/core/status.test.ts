import assert from 'node:assert/strict';
import test from 'node:test';
import { statusItems, statusText, type StatusInput } from './status';

const healthy = (): StatusInput => ({
  receiver: {
    running: true,
    endpoint: 'http://127.0.0.1:4318',
    requestedPort: 4318,
    port: 4318,
    injectEnvironment: true,
    traces: 3,
    metricSeries: 1,
  },
  agents: {
    enabled: true,
    bridgeRunning: true,
    clients: ['Claude Code'],
    skills: ['Claude Code'],
    sharing: { active: true, scope: 'all', sources: 2 },
    copilot: true,
  },
  capture: {
    terminal: { state: 'capturing', detail: 'Capturing 1 terminal command' },
    debugSessions: true,
    running: 1,
  },
  retention: { events: 1200, bytes: 2 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, discarded: 0, persist: false },
  editor: { lenses: true, doctor: 'all', findings: 2, changedFiles: 4 },
});
const byArea = (input: StatusInput) => new Map(statusItems(input).map((item) => [item.area, item]));

test('a healthy window reports what each part is doing', () => {
  const items = statusItems(healthy());
  assert.ok(
    items.every((item) => item.state === 'ok'),
    JSON.stringify(items.filter((item) => item.state !== 'ok')),
  );
  const areas = byArea(healthy());
  assert.equal(
    areas.get('OpenTelemetry receiver')!.summary,
    'Receiving on http://127.0.0.1:4318 · 3 traces, 1 metric series',
  );
  assert.equal(areas.get('Claude Code and Codex')!.summary, 'Used recently by Claude Code');
  assert.equal(areas.get('Sharing with agents')!.summary, 'Sharing all sources and new runs (2 sources)');
  assert.equal(areas.get('GitHub Copilot'), undefined, 'Copilot is only mentioned when it is missing');
  assert.equal(items[0].area, 'Capture');
  assert.equal(areas.get('My changes')!.summary, '4 files changed since the last commit');
});

test('problems and switched-off parts each offer the step that fixes them', () => {
  const input = healthy();
  input.receiver = {
    ...input.receiver,
    endpoint: 'http://127.0.0.1:53111',
    error: 'Port 4318 is in use; receiving on 53111 instead.',
  };
  input.agents = { ...input.agents, clients: [], skills: [], sharing: { active: false, sources: 0 }, copilot: false };
  input.capture.terminal = { state: 'off', detail: '' };
  input.retention = { ...input.retention, bytes: 99 * 1024 * 1024, discarded: 5000 };
  input.editor = { lenses: false, doctor: 'all', findings: 0 };
  const areas = byArea(input);
  const receiver = areas.get('OpenTelemetry receiver')!;
  assert.deepEqual(
    [receiver.state, receiver.action],
    [
      'problem',
      { label: 'Change the receiver port', command: 'workbench.action.openSettings', args: ['logline.otlp.port'] },
    ],
  );
  assert.match(receiver.detail!, /configured for port 4318 send their telemetry to whatever is using it/);
  assert.deepEqual(areas.get('Claude Code and Codex')!.action, {
    label: 'Connect Claude Code or Codex',
    command: 'logline.connectAgent',
  });
  assert.equal(areas.get('Sharing with agents')!.action!.command, 'logline.shareWithAgent');
  assert.match(areas.get('GitHub Copilot')!.detail!, /Everything else works without it/);
  assert.equal(areas.get('Terminal capture')!.action!.command, 'logline.enableTerminalCapture');
  assert.equal(areas.get('Retention')!.state, 'problem');
  assert.deepEqual(areas.get('Log lenses and log doctor')!.action!.args, ['logline.logLenses']);
  assert.equal(areas.get('My changes')!.state, 'off');

  const failed = healthy();
  failed.receiver = {
    ...failed.receiver,
    running: false,
    endpoint: undefined,
    error: 'Could not start the OpenTelemetry receiver: EACCES',
  };
  failed.agents = { ...failed.agents, bridgeRunning: false };
  const broken = byArea(failed);
  assert.equal(broken.get('OpenTelemetry receiver')!.summary, 'Could not start the OpenTelemetry receiver: EACCES');
  assert.equal(broken.get('Claude Code and Codex')!.action!.command, 'workbench.action.reloadWindow');
  failed.receiver.error = undefined;
  assert.equal(byArea(failed).get('OpenTelemetry receiver')!.action!.command, 'logline.startOtlpReceiver');
  failed.agents.enabled = false;
  assert.deepEqual(byArea(failed).get('Claude Code and Codex')!.action!.args, ['logline.externalAgents']);
});

test('the copied status is plain text with a mark per state', () => {
  const input = healthy();
  input.agents.copilot = false;
  const text = statusText(statusItems(input), '1.14.0');
  assert.match(text, /^Logline 1\.14\.0 status\n✓ Capture: 1 running/);
  assert.match(text, /\n– GitHub Copilot: Not installed\n {4}Ask Copilot/);
});
