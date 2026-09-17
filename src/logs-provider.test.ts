import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { withVscode } from './test/vscode-mock';

let received: ((message: unknown) => void) | undefined;
let disposed: (() => void) | undefined;
const posted: unknown[] = [];
const mock = {
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts), toString() { return this.fsPath; } }) },
  window: { showErrorMessage: () => undefined }
};
const { LogsProvider } = withVscode(mock, () => require('./vscode/logs-view-provider') as typeof import('./vscode/logs-view-provider'));

test('webview provider initializes the bridge, forwards messages, and releases listeners on disposal', async () => {
  received = undefined; disposed = undefined; posted.length = 0;
  let subscriptions = 0;
  const controller = {
    notifications: { subscribe: (listener: (message: unknown) => void) => { subscriptions++; return { dispose: () => { subscriptions--; } }; } },
    guideStatus: () => ({ version: 'v1', unread: true }),
    handleMessage: async (send: (message: unknown) => void, message: unknown) => send({ type: 'details', message })
  } as any;
  const view = {
    webview: {
      cspSource: 'csp',
      options: undefined as unknown,
      html: '',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (message: unknown) => { posted.push(message); return true; },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { received = listener; return { dispose: () => { received = undefined; } }; }
    },
    onDidDispose: (listener: () => void) => { disposed = listener; return { dispose: () => { disposed = undefined; } }; }
  } as any;
  new LogsProvider({ extensionUri: { fsPath: process.cwd() } } as any, controller).resolveWebviewView(view);
  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.webview.options.localResourceRoots[0].fsPath, path.join(process.cwd(), 'media'));
  assert.match(view.webview.html, /Logline/);
  assert.deepEqual(posted[0], { type: 'guideStatus', version: 'v1', unread: true });
  assert.equal(subscriptions, 1);
  received!({ type: 'snapshot' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posted.at(-1), { type: 'details', message: { type: 'snapshot' } });
  disposed!();
  assert.equal(subscriptions, 0);
});
