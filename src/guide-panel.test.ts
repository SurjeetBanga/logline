import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { withVscode } from './test/vscode-mock';

let created = 0;
let lastPanel: { messages: unknown[]; revealCount: number; webview: { html: string; }; receive(message: unknown): void; dispose(): void; } | undefined;
const { GuidePanel } = withVscode({
  ViewColumn: { Beside: 2 },
  Uri: { joinPath: (base: { fsPath: string; }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  window: {
    createWebviewPanel: () => {
      created++;
      let receiveHandler: ((message: unknown) => void) | undefined;
      let disposeHandler: (() => void) | undefined;
      const messages: unknown[] = [];
      const panel = {
        messages, revealCount: 0,
        webview: {
          cspSource: 'csp', html: '',
          asWebviewUri: (uri: unknown) => uri,
          postMessage: async (message: unknown) => { messages.push(message); return true; },
          onDidReceiveMessage: (handler: (message: unknown) => void) => { receiveHandler = handler; return { dispose() { receiveHandler = undefined; } }; }
        },
        reveal() { panel.revealCount++; },
        onDidDispose(handler: () => void) { disposeHandler = handler; return { dispose() { disposeHandler = undefined; } }; },
        receive(message: unknown) { receiveHandler?.(message); },
        dispose() { disposeHandler?.(); }
      };
      lastPanel = panel;
      return panel;
    }
  },
  commands: { executeCommand: async () => undefined }
}, () => require('./vscode/guide-panel') as typeof import('./vscode/guide-panel'));

test('guide panel reuses its editor tab and acknowledges What’s new after rendering', async () => {
  created = 0;
  let rendered = 0;
  const guide = new GuidePanel({ extensionUri: { fsPath: process.cwd() } as unknown as import('vscode').Uri }, async () => { rendered++; });
  guide.open('whatsNew');
  assert.equal(created, 1);
  assert.ok(lastPanel?.webview.html.includes('Logline Guide'));
  lastPanel!.receive({ type: 'guideReady' });
  await Promise.resolve();
  assert.deepEqual(lastPanel!.messages.at(-1), { type: 'selectSection', section: 'whatsNew' });
  lastPanel!.receive({ type: 'guideRendered', section: 'whatsNew' });
  await Promise.resolve();
  assert.equal(rendered, 1);
  guide.open('guide');
  assert.equal(created, 1);
  assert.equal(lastPanel!.revealCount, 1);
  assert.deepEqual(lastPanel!.messages.at(-1), { type: 'selectSection', section: 'guide' });
  guide.dispose();
});
