import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeSetting, normalizeServers } from './settings';
import { withVscode } from '../test/vscode-mock';

interface SettingSchema {
  type: string;
  default: unknown;
  minimum: number;
  maximum: number;
  order?: number;
  description?: string;
  markdownDescription?: string;
}
interface Manifest {
  contributes: {
    commands: { command: string }[];
    configuration: { id: string; title: string; order: number; properties: Record<string, SettingSchema> }[];
  };
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
const properties: Record<string, SettingSchema> = Object.assign(
  {},
  ...manifest.contributes.configuration.map((category) => category.properties),
);

test('settings are grouped into ordered categories, each setting once and in order', () => {
  const categories = manifest.contributes.configuration;
  assert.deepEqual(
    categories.map((category) => category.order),
    categories.map((_, index) => index + 1),
  );
  const names = categories.flatMap((category) => Object.keys(category.properties));
  assert.equal(new Set(names).size, names.length, 'a setting is in more than one category');
  for (const category of categories) {
    assert.ok(category.title && category.id.startsWith('logline.'));
    assert.deepEqual(
      Object.values(category.properties).map((schema) => schema.order),
      Object.keys(category.properties).map((_, index) => index + 1),
      `${category.title} settings need an order that matches their position`,
    );
  }
});

test('setting descriptions link only to settings and commands that exist', () => {
  const commands = new Set(manifest.contributes.commands.map((command) => command.command));
  for (const [name, schema] of Object.entries(properties)) {
    const text = schema.markdownDescription ?? schema.description ?? '';
    assert.ok(text, `${name} has no description`);
    for (const [, linked] of text.matchAll(/#(logline\.[\w.]+)#/g))
      assert.ok(linked in properties, `${name} links to unknown setting ${linked}`);
    for (const [, command] of text.matchAll(/\(command:([\w.]+)\)/g))
      assert.ok(commands.has(command), `${name} links to unknown command ${command}`);
  }
});

test('numeric settings follow manifest bounds and reject values that cannot size a ring or timer', () => {
  for (const key of ['indentation', 'maxEvents', 'maxMemoryMb', 'refreshIntervalMs', 'maxLineLength', 'maxDiskMb']) {
    const schema = properties['logline.' + key];
    assert.equal(normalizeSetting(key, -1, schema.default), schema.minimum);
    assert.equal(normalizeSetting(key, 1e20, schema.default), schema.maximum);
    for (const value of [NaN, Infinity, null, '1000', {}, []])
      assert.equal(normalizeSetting(key, value, schema.default), schema.default);
    const fractional = schema.minimum + 0.5;
    assert.equal(
      normalizeSetting(key, fractional, schema.default),
      schema.type === 'integer' ? schema.minimum : fractional,
    );
  }
});

test('configuration adapter validates changed settings and refreshes its cache', () => {
  const values = new Map<string, unknown>([
    ['maxEvents', 1000.9],
    ['source', 'invalid'],
  ]);
  const { Configuration } = withVscode(
    {
      workspace: {
        getConfiguration: () => ({
          get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
        }),
      },
    },
    () => require('../vscode/configuration') as typeof import('../vscode/configuration'),
  );
  const config = new Configuration();
  assert.equal(config.get('maxEvents', 50000), 1000);
  assert.equal(config.get('source', 'both'), 'both');
  values.set('maxEvents', 2000.1);
  config.refresh();
  assert.equal(config.get('maxEvents', 50000), 2000);
  values.set('persistLogs', 'true');
  assert.equal(config.get('persistLogs', false), false);
});

test('server validation filters malformed records and does not coerce autostart or environment values', () => {
  const valid = {
    id: 'api',
    label: 'API',
    command: 'npm start',
    cwd: 42,
    autoStart: 'true',
    jsonOnly: true,
    env: { PORT: '3000', INVALID: 1 },
  };
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

test('new feature settings are clamped and validated', () => {
  assert.equal(normalizeSetting('otlp.port', 70000, 4318), 65535);
  assert.equal(normalizeSetting('otlp.port', 4318.7, 4318), 4318);
  assert.equal(normalizeSetting('otlp.port', '4318', 4318), 4318);
  assert.equal(normalizeSetting('logLensMaxFiles', 10, 5000), 100);
  assert.equal(normalizeSetting('logLenses', 'everything', 'codelens'), 'codelens');
  assert.equal(normalizeSetting('logLenses', 'codelens+gutter', 'codelens'), 'codelens+gutter');
  assert.equal(normalizeSetting('otlp.showSpans', 'some', 'entry'), 'entry');
});
