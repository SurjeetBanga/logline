import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseQuery } from './query';
import {
  agentClient,
  bytesBucket,
  commonProperties,
  countBucket,
  cpusBucket,
  durationBucket,
  hostApp,
  msBucket,
  queryFeatures,
  ramBucket,
  remoteKind,
  sanitizeUsage,
  USAGE_EVENTS,
  type UsageVocabulary,
} from './usage-events';

const vocabulary: UsageVocabulary = {
  commands: new Set(['logline.showLogs']),
  guideSections: new Set(['capture']),
  settings: new Map<string, 'boolean' | 'number' | 'custom' | readonly string[]>([
    ['captureTerminals', 'boolean'],
    ['maxEvents', 'number'],
    ['source', ['both', 'stdout', 'stderr']],
    ['redactionFields', 'custom'],
  ]),
};

test('only properties an event names survive, each checked against its allowed values', () => {
  assert.deepEqual(sanitizeUsage('capture_started', { kind: 'terminal', path: '/Users/someone/app.log' }, vocabulary), {
    kind: 'terminal',
  });
  assert.deepEqual(sanitizeUsage('capture_started', { kind: 'my-secret-service' }, vocabulary), {});
  assert.equal(sanitizeUsage('made_up_event', { kind: 'terminal' }, vocabulary), undefined);
  assert.equal(sanitizeUsage('constructor', {}, vocabulary), undefined, 'not an inherited property');
  assert.deepEqual(sanitizeUsage('command', { id: 'logline.showLogs' }, vocabulary), { id: 'logline.showLogs' });
  assert.deepEqual(sanitizeUsage('command', { id: 'other.extension' }, vocabulary), {});
  assert.deepEqual(sanitizeUsage('guide_section', { section: 'capture' }, vocabulary), { section: 'capture' });
  assert.deepEqual(sanitizeUsage('connection_added', { type: 'datadog', label: 'prod-eu' }, vocabulary), {
    type: 'datadog',
  });
});

test('numbers leave as buckets, codes and versions only in their own shape', () => {
  assert.deepEqual(
    sanitizeUsage(
      'agent_tool',
      {
        tool: 'logline_search_logs',
        via: 'mcp',
        client: 'claude-code',
        ok: false,
        code: 'INVALID_INPUT',
        ms: 37,
        result_size: 9000,
        truncated: 'yes',
      },
      vocabulary,
    ),
    {
      tool: 'logline_search_logs',
      via: 'mcp',
      client: 'claude-code',
      ok: false,
      code: 'INVALID_INPUT',
      ms: '25-49ms',
      result_size: '8-32KB',
    },
  );
  assert.deepEqual(
    sanitizeUsage('error', { area: 'bridge', code: 'connection refused at 10.0.0.1' }, vocabulary),
    { area: 'bridge' },
    'a message is not a code',
  );
  assert.deepEqual(
    sanitizeUsage('agent_tool', { tool: 'logline_search_logs', code: 'prodhost' }, vocabulary),
    { tool: 'logline_search_logs' },
    'only codes Logline names, not any one word',
  );
  assert.deepEqual(sanitizeUsage('updated', { from: '1.18.0' }, vocabulary), { from: '1.18.0' });
  assert.deepEqual(sanitizeUsage('updated', { from: 'C:\\Users\\me' }, vocabulary), {});
  assert.deepEqual(
    sanitizeUsage('session_summary', { views_used: ['logs', 'secret-view', 'logs'], searches: 12 }, vocabulary),
    { views_used: ['logs'], searches: '10-99' },
  );
});

test('a setting is sent by name, and its value only when it is a boolean, a bucketed number, or one of its choices', () => {
  const setting = (key: string, value: unknown) => sanitizeUsage('setting_changed', { key, value }, vocabulary);
  assert.deepEqual(setting('captureTerminals', true), { key: 'captureTerminals', value: true });
  assert.deepEqual(setting('maxEvents', 250000), { key: 'maxEvents', value: '100k+' });
  assert.deepEqual(setting('source', 'stderr'), { key: 'source', value: 'stderr' });
  assert.deepEqual(setting('source', 'something else'), { key: 'source', value: 'custom' });
  assert.deepEqual(setting('redactionFields', ['customer_email']), { key: 'redactionFields', value: 'custom' });
  assert.deepEqual(setting('notASetting', true), {});
});

test('buckets', () => {
  assert.deepEqual([0, -1, 1, 9, 10, 99, 100, 999, 1000, 99_999, 100_000].map(countBucket), [
    '0',
    '0',
    '1-9',
    '1-9',
    '10-99',
    '10-99',
    '100-999',
    '100-999',
    '1k-10k',
    '10k-100k',
    '100k+',
  ]);
  assert.deepEqual([0, 9, 10, 999, 1000, 4999, 5000, 15_000].map(msBucket), [
    '<10ms',
    '<10ms',
    '10-24ms',
    '500-999ms',
    '1-5s',
    '1-5s',
    '5-15s',
    '15s+',
  ]);
  assert.deepEqual([30_000, 60_000, 3_600_000, 86_400_000, 8 * 86_400_000].map(durationBucket), [
    '<1m',
    '1-5m',
    '1-6h',
    '1-7d',
    '7d+',
  ]);
  assert.deepEqual([1, 4, 8, 12, 64].map(cpusBucket), ['1-2', '3-4', '5-8', '9-16', '17+']);
  assert.deepEqual(
    [4, 8, 16, 64].map((gb) => ramBucket(gb * 1024 ** 3)),
    ['<8', '8-15', '16-31', '32+'],
  );
});

test('the editor, remote, and agent client are named from short lists', () => {
  assert.deepEqual(
    ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Acme IDE'].map(hostApp),
    ['vscode', 'vscode', 'cursor', 'windsurf', 'vscodium', 'other'],
  );
  assert.deepEqual([undefined, 'ssh-remote', 'wsl', 'dev-container', 'codespaces', 'tunnel'].map(remoteKind), [
    'none',
    'ssh',
    'wsl',
    'container',
    'codespaces',
    'other',
  ]);
  assert.deepEqual(['claude-code', 'Codex CLI', 'cursor-agent', 'my-internal-bot', undefined].map(agentClient), [
    'claude-code',
    'codex',
    'cursor',
    'other',
    'other',
  ]);
  assert.deepEqual(
    commonProperties({
      version: '1.19.0',
      vscode: '1.105.1',
      appName: 'Visual Studio Code',
      uiKind: 'desktop',
      platform: 'darwin',
      arch: 'arm64',
      cpus: 10,
      totalMemory: 32 * 1024 ** 3,
    }),
    {
      version: '1.19.0',
      vscode: '1.105.1',
      host: 'vscode',
      ui: 'desktop',
      remote: 'none',
      os: 'darwin',
      arch: 'arm64',
      cpus: '9-16',
      ram_gb: '32+',
    },
  );
});

test('a search is counted by the operators it used and Logline’s own field names, never its values', () => {
  const features = (query: string) => {
    const { operators, fields } = queryFeatures(parseQuery(query));
    return { operators: [...operators].sort(), fields: [...fields].sort() };
  };
  assert.deepEqual(features('service:checkout-api -"db-prod-3.acme.internal" orderId:>5000'), {
    operators: ['compare', 'field', 'negation'],
    fields: ['service'],
  });
  assert.deepEqual(features('level:error OR /time.?out/ last:15m changed:true path:/api/*'), {
    operators: ['changed', 'field', 'glob', 'or', 'regex', 'time'],
    fields: ['changed', 'last', 'level', 'path'],
  });
  assert.deepEqual(features('payment failed'), { operators: [], fields: [] });
});

test('telemetry.json lists every event and property, so code --telemetry shows what is sent', () => {
  const listed = JSON.parse(readFileSync(join(__dirname, '..', '..', 'telemetry.json'), 'utf8')) as {
    events: Record<string, Record<string, unknown>>;
  };
  const documented = Object.fromEntries(
    Object.entries(listed.events)
      .filter(([name]) => name !== 'surjeetbanga.logline/survey sent')
      .map(([name, event]) => [
        name.replace('surjeetbanga.logline/', ''),
        Object.keys(event)
          .filter((key) => key !== 'owner' && key !== 'comment')
          .sort(),
      ]),
  );
  const schema = Object.fromEntries(
    Object.entries(USAGE_EVENTS).map(([name, properties]) => [name, Object.keys(properties).sort()]),
  );
  assert.deepEqual(documented, schema, 'update telemetry.json with the event schema');
});

test('every property of every event can only carry Logline’s own names or buckets, whatever it is given', () => {
  // Everything that may come out: the schema's own choices, the manifest's names, buckets, and versions.
  const allowed = new Set<string>(['custom']);
  for (const schema of Object.values(USAGE_EVENTS))
    for (const rule of Object.values(schema) as { kind: string; values?: unknown }[])
      if (Array.isArray(rule.values)) for (const value of rule.values) allowed.add(value);
  for (const set of [vocabulary.commands, vocabulary.guideSections, new Set(vocabulary.settings.keys())])
    for (const value of set) allowed.add(value);
  for (const rule of vocabulary.settings.values())
    if (Array.isArray(rule)) for (const value of rule) allowed.add(value);
  for (let n = -1; n < 1e10; n = n < 1 ? n + 1 : n * 1.37)
    for (const bucket of [countBucket, msBucket, durationBucket]) allowed.add(bucket(n));
  for (const size of [0, 1023, 1024, 9000, 40000]) allowed.add(bytesBucket(size));
  const version = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-insider)?$/;

  const token = ['ghp', 'Q'.repeat(36)].join('_');
  const hostile: unknown[] = [
    'jane.doe@acme.com',
    '/Users/jane/work/payments',
    'C:\\Users\\jane\\app.log',
    'db-prod-3.acme.internal',
    '10.2.3.4',
    'level:error user_id:42',
    `token ${token}`,
    'Jane Doe',
    '1.0.0-janedoe',
    'INVALID_INPUT here',
    'prodhost',
    ['jane.doe@acme.com', 'logs', 'Jane Doe'],
    { name: 'Jane Doe', email: 'jane.doe@acme.com' },
    [{ path: '/Users/jane' }],
    123456789012,
    -5,
    Number.NaN,
    true,
    null,
    undefined,
  ];
  for (const [event, schema] of Object.entries(USAGE_EVENTS))
    for (const key of Object.keys(schema))
      for (const value of hostile) {
        // The setting rule reads the key beside it: try a real key and a hostile one.
        for (const extra of [{}, { key: 'source' }, { key: 'redactionFields' }]) {
          const clean = sanitizeUsage(event, { ...extra, [key]: value, unknownExtra: value }, vocabulary)!;
          assert.ok(!Object.hasOwn(clean, 'unknownExtra'), `${event} keeps only its own properties`);
          for (const [name, out] of Object.entries(clean))
            for (const item of Array.isArray(out) ? out : [out]) {
              if (typeof item === 'boolean') continue;
              assert.ok(
                allowed.has(String(item)) || version.test(String(item)),
                `${event}.${name} let ${JSON.stringify(item)} through from ${JSON.stringify(value)}`,
              );
            }
        }
      }
});

test('the editor and machine are named only from short lists and ranges', () => {
  const props = commonProperties({
    version: '1.19.0-janedoe',
    vscode: '1.105.0-insider',
    appName: 'Jane’s Custom IDE',
    uiKind: 'desktop',
    remoteName: 'ssh-remote+jane-laptop.local',
    platform: 'darwin',
    arch: 'arm64',
    cpus: 12,
    totalMemory: 32 * 1024 ** 3,
  });
  assert.deepEqual(props, {
    version: 'unknown',
    vscode: '1.105.0-insider',
    host: 'other',
    ui: 'desktop',
    remote: 'other',
    os: 'darwin',
    arch: 'arm64',
    cpus: '9-16',
    ram_gb: '32+',
  });
});
