import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uninstallBatch } from './uninstall';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 12, 0, 30);
const will = {
  id: 'install-id',
  projectKey: 'project',
  installedAt: NOW - 3 * DAY,
  milestones: ['first_capture', 'first_search'],
  common: { version: '1.23.0', os: 'win32', host: 'vscode', internal: true },
};

test('an uninstall sends one event: how long ago Logline was installed and the firsts it reached', () => {
  const body = JSON.parse(uninstallBatch(will, {}, NOW)!);
  assert.equal(body.api_key, 'project');
  assert.equal(body.batch.length, 1);
  const [event] = body.batch;
  assert.equal(event.event, 'uninstalled');
  assert.equal(event.distinct_id, 'install-id');
  assert.equal(event.timestamp, '2026-11-27T12:00:00.000Z', 'to the minute');
  assert.deepEqual(event.properties, {
    version: '1.23.0',
    os: 'win32',
    host: 'vscode',
    internal: true,
    age: '1-7d',
    reached: ['first_capture', 'first_search'],
    $process_person_profile: false,
    $geoip_disable: true,
  });
});

test('an uninstall sends nothing it was not left, and nothing the schema does not name', () => {
  assert.equal(uninstallBatch(will, { DO_NOT_TRACK: '1' }, NOW), undefined);
  assert.equal(uninstallBatch({ ...will, id: '' }, {}, NOW), undefined);
  assert.equal(uninstallBatch({ ...will, projectKey: undefined }, {}, NOW), undefined);
  const hostile = JSON.parse(
    uninstallBatch(
      {
        ...will,
        milestones: ['first_capture', '/Users/jane/secret'],
        common: { version: 'jane', path: { nested: true }, 'Bad Key': 'x', os: 'linux' },
      },
      {},
      NOW,
    )!,
  ).batch[0].properties;
  assert.deepEqual(hostile.reached, ['first_capture']);
  assert.equal(hostile.version, undefined, 'a version that is not one is left out');
  assert.equal(hostile.os, 'linux');
  assert.equal('path' in hostile || 'Bad Key' in hostile, false);
});
