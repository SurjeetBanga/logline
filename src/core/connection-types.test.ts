import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONNECTION_TYPES } from './connection-form';
import { CONNECTION_KINDS, keepsSecret, storeName } from './connection-types';
import { connectionLabel, normalizeConnections, type ConnectionType } from './connections';

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  contributes: {
    configuration: { properties: Record<string, { items?: { properties?: Record<string, unknown> } }> }[];
  };
};

test('every kind of connection is in the settings schema and the form, in the same order', () => {
  const properties = Object.assign({}, ...manifest.contributes.configuration.map((category) => category.properties));
  const types = (properties['logline.connections'].items.properties.type as { enum: string[] }).enum;
  assert.deepEqual([...types].sort(), Object.keys(CONNECTION_KINDS).sort());
  assert.deepEqual(
    CONNECTION_TYPES.map((entry) => entry.type),
    Object.keys(CONNECTION_KINDS),
  );
});

test('a kind says how its connections are searched, named, and kept', () => {
  for (const [type, kind] of Object.entries(CONNECTION_KINDS) as [
    ConnectionType,
    (typeof CONNECTION_KINDS)[ConnectionType],
  ][]) {
    // A log service is searched as it is, so it needs no typed query language; a database without one is only
    // searched, so it needs its logs mapped.
    if (kind.service) assert.equal(kind.language, undefined, type);
    else if (kind.language === undefined) assert.equal(kind.mappingRequired, true, type);
    assert.equal(CONNECTION_TYPES.find((entry) => entry.type === type)?.kind, kind.service ? 'logs' : 'database');
  }
  assert.equal(storeName('datadog'), 'Datadog');
  assert.equal(storeName('mongodb'), 'MongoDB');
  assert.equal(storeName('postgres'), 'database');
  assert.equal(CONNECTION_KINDS.datadog.traceQuery?.('abc123'), 'trace_id:abc123');
  const [datadog, sqlite] = normalizeConnections([
    { id: 'prod', type: 'datadog', site: 'datadoghq.com', logs: { table: 'ignored', timestamp: 'ts' } },
    { id: 'local', type: 'sqlite', path: 'app.db' },
  ]);
  assert.equal(connectionLabel(datadog), 'Datadog · prod');
  // A log service keeps no table mapping, even when the setting has one.
  assert.equal(datadog.logs, undefined);
  assert.equal(keepsSecret(datadog), true);
  assert.equal(keepsSecret(sqlite), false);
});
