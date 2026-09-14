import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeSetting, normalizeServers } from './core/settings';
import { withVscode } from './test/vscode-mock';

test('numeric settings follow manifest bounds and reject values that cannot size a ring or timer', () => {
  const properties = JSON.parse(readFileSync('package.json', 'utf8')).contributes.configuration.properties;
  for (const key of ['indentation', 'maxEvents', 'maxMemoryMb', 'refreshIntervalMs', 'maxLineLength', 'maxDiskMb']) {
    const schema = properties['logline.' + key];
    assert.equal(normalizeSetting(key, -1, schema.default), schema.minimum);
    assert.equal(normalizeSetting(key, 1e20, schema.default), schema.maximum);
    for (const value of [NaN, Infinity, null, '1000', {}, []]) assert.equal(normalizeSetting(key, value, schema.default), schema.default);
    const fractional = schema.minimum + 0.5;
    assert.equal(normalizeSetting(key, fractional, schema.default), schema.type === 'integer' ? schema.minimum : fractional);
  }
});

test('configuration adapter validates changed settings and refreshes its cache', () => {
  const values = new Map<string, unknown>([['maxEvents', 1000.9], ['source', 'invalid']]);
  const { Configuration } = withVscode({ workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => values.has(key) ? values.get(key) : fallback }) } },
    () => require('./vscode/configuration') as typeof import('./vscode/configuration'));
  const config = new Configuration();
  assert.equal(config.get('maxEvents', 50000), 1000);
  assert.equal(config.get('source', 'both'), 'both');
  values.set('maxEvents', 2000.1); config.refresh();
  assert.equal(config.get('maxEvents', 50000), 2000);
  values.set('persistLogs', 'true');
  assert.equal(config.get('persistLogs', false), false);
});

test('server validation filters malformed records and does not coerce autostart or environment values', () => {
  const valid = { id: 'api', label: 'API', command: 'npm start', cwd: 42, autoStart: 'true', jsonOnly: true, env: { PORT: '3000', INVALID: 1 } };
  const raw = [null, 'oops', {}, { id: 'bad', label: '', command: 'x' }, valid, { ...valid, command: 'duplicate' }];
  const servers = normalizeServers(raw);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].autoStart, false);
  assert.equal(servers[0].cwd, undefined);
  assert.equal(servers[0].jsonOnly, true);
  assert.deepEqual(servers[0].env, { PORT: '3000' });
  assert.equal(valid.cwd, 42);
  assert.deepEqual(normalizeSetting('columns', ['a', null, 'a', 'b'], []), ['a', 'b']);
});
