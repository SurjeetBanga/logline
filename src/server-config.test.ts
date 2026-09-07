import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, nextServerId, resolveAutoStartServers, resolveRunTarget, resolveCwd } from './server-config';
import type { ServerConfig } from './types';

test('slugify normalizes labels and falls back when nothing survives', () => {
  assert.equal(slugify('My Server!'), 'my-server');
  assert.equal(slugify('  --API--  '), 'api');
  assert.equal(slugify('###'), 'server');
});

test('nextServerId disambiguates id collisions', () => {
  const servers = [{ id: 'api' }, { id: 'api-2' }] as ServerConfig[];
  assert.equal(nextServerId(servers, 'API'), 'api-3');
  assert.equal(nextServerId(servers, 'Worker'), 'worker');
});

test('resolveAutoStartServers only runs autoStart servers, and reports untrusted workspaces', () => {
  const servers = [{ id: 'a', autoStart: true }, { id: 'b', autoStart: false }] as ServerConfig[];
  assert.deepEqual(resolveAutoStartServers(servers, true), { blocked: false, servers: [servers[0]] });
  assert.deepEqual(resolveAutoStartServers(servers, false), { blocked: true, servers: [] });
  assert.deepEqual(resolveAutoStartServers([{ id: 'b', autoStart: false }] as ServerConfig[], false), { blocked: false, servers: [] });
});

test('resolveRunTarget looks up a saved server, forwards its env, and falls back to the workspace cwd', () => {
  const servers: ServerConfig[] = [
    { id: 'api', label: 'API', command: 'npm start', env: { PORT: '3000' } },
    { id: 'worker', label: 'Worker', command: 'npm run worker', cwd: '/srv/worker' }
  ];
  assert.deepEqual(resolveRunTarget(servers, 'api', '/workspace'),
    { command: 'npm start', cwd: '/workspace', server: servers[0], env: { PORT: '3000' } });
  assert.deepEqual(resolveRunTarget(servers, 'worker', '/workspace'),
    { command: 'npm run worker', cwd: '/srv/worker', server: servers[1], env: undefined });
  assert.equal(resolveRunTarget(servers, 'missing', '/workspace'), undefined);
});

test('a saved server cwd expands ${workspaceFolder} like tasks.json does', () => {
  const servers: ServerConfig[] = [{ id: 'api', label: 'API', command: 'npm run dev', cwd: '${workspaceFolder}/node' }];
  assert.equal(resolveRunTarget(servers, 'api', '/repo')!.cwd, '/repo/node');
  assert.equal(resolveCwd(undefined, '/repo'), '/repo', 'no cwd falls back to the workspace');
  assert.equal(resolveCwd('/absolute/path', '/repo'), '/absolute/path', 'absolute paths pass through');
});
