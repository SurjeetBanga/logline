import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

const host = {
  remoteName: undefined as string | undefined,
  values: {} as Record<string, unknown>,
  explicit: {} as Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>,
};
const mock = {
  env: {
    get remoteName() {
      return host.remoteName;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T) => (Object.hasOwn(host.values, key) ? (host.values[key] as T) : fallback),
      inspect: (key: string) => ({ key, ...host.explicit[key] }),
    }),
  },
};
const { Configuration } = withVscode(mock, () => require('./configuration') as typeof import('./configuration'));

function reset(remoteName?: string) {
  Object.assign(host, { remoteName, values: {}, explicit: {} });
}

test('terminal capture is on by default on this machine and off on a remote host', () => {
  reset();
  host.values.captureTerminals = true;
  const config = new Configuration();
  assert.equal(config.isDefault('captureTerminals'), true);
  assert.equal(config.get('captureTerminals', false), true);

  reset('codespaces');
  host.values.captureTerminals = true;
  assert.equal(new Configuration().get('captureTerminals', false), false);
});

test('a value someone set for terminal capture wins over the default, wherever it is set', () => {
  reset();
  host.values.captureTerminals = false;
  host.explicit.captureTerminals = { globalValue: false };
  const config = new Configuration();
  assert.equal(config.isDefault('captureTerminals'), false);
  assert.equal(config.get('captureTerminals', true), false);

  reset('ssh-remote');
  host.values.captureTerminals = true;
  host.explicit.captureTerminals = { workspaceValue: true };
  assert.equal(new Configuration().get('captureTerminals', false), true);
});

test('settings without a host default read as before', () => {
  reset('codespaces');
  host.values.maxEvents = 5000;
  const config = new Configuration();
  assert.equal(config.get('maxEvents', 100000), 5000);
  assert.equal(config.get('persistLogs', false), false);
});
