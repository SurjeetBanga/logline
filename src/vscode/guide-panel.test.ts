import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { withVscode } from '../test/vscode-mock';

let created = 0;
const executed: unknown[][] = [];
let lastPanel:
  | {
      messages: unknown[];
      revealCount: number;
      webview: { html: string };
      receive(message: unknown): void;
      dispose(): void;
    }
  | undefined;
const { GuidePanel } = withVscode(
  {
    ViewColumn: { Beside: 2 },
    Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    window: {
      createWebviewPanel: () => {
        created++;
        let receiveHandler: ((message: unknown) => void) | undefined;
        let disposeHandler: (() => void) | undefined;
        const messages: unknown[] = [];
        const panel = {
          messages,
          revealCount: 0,
          webview: {
            cspSource: 'csp',
            html: '',
            asWebviewUri: (uri: unknown) => uri,
            postMessage: async (message: unknown) => {
              messages.push(message);
              return true;
            },
            onDidReceiveMessage: (handler: (message: unknown) => void) => {
              receiveHandler = handler;
              return {
                dispose() {
                  receiveHandler = undefined;
                },
              };
            },
          },
          reveal() {
            panel.revealCount++;
          },
          onDidDispose(handler: () => void) {
            disposeHandler = handler;
            return {
              dispose() {
                disposeHandler = undefined;
              },
            };
          },
          receive(message: unknown) {
            receiveHandler?.(message);
          },
          dispose() {
            disposeHandler?.();
          },
        };
        lastPanel = panel;
        return panel;
      },
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        executed.push(args);
      },
    },
  },
  () => require('./guide-panel') as typeof import('./guide-panel'),
);

test('guide panel reuses its editor tab and acknowledges What’s new after rendering', async () => {
  created = 0;
  let rendered = 0;
  const guide = new GuidePanel(
    { extensionUri: { fsPath: process.cwd() } as unknown as import('vscode').Uri },
    async () => {
      rendered++;
    },
  );
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

test('the guide sends progress, shows controls, and only runs what its cards name', async () => {
  executed.length = 0;
  const revealed: unknown[] = [];
  const guide = new GuidePanel(
    { extensionUri: { fsPath: process.cwd() } as unknown as import('vscode').Uri },
    async () => undefined,
    {
      progress: () => ({ captured: true, searched: false, shared: false }),
      reveal: (target, fallback) => revealed.push([target, fallback]),
      unreadHighlights: () => 3,
    },
  );
  guide.open();
  const html = lastPanel!.webview.html;
  assert.match(html, /window\.__LOGLINE_GUIDE__ = \{"releases":/);
  assert.match(html, /"unreadHighlights":3/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'every placeholder is filled');
  lastPanel!.receive({ type: 'guideReady' });
  assert.deepEqual(lastPanel!.messages.at(-1), {
    type: 'guideProgress',
    progress: { captured: true, searched: false, shared: false },
  });
  lastPanel!.receive({ type: 'reveal', target: 'captureToggle' });
  lastPanel!.receive({ type: 'reveal', target: 'connectionRun', fallback: 'sourceRail' });
  lastPanel!.receive({ type: 'reveal', target: '<script>' });
  lastPanel!.receive({ type: 'reveal', target: 'search', fallback: 'not valid!' });
  assert.deepEqual(revealed, [
    ['captureToggle', undefined],
    ['connectionRun', 'sourceRail'],
    ['search', undefined],
  ]);
  lastPanel!.receive({ type: 'runCommand', command: 'logline.runCommand' });
  lastPanel!.receive({ type: 'runCommand', command: 'workbench.action.terminal.sendSequence' });
  lastPanel!.receive({ type: 'openSetting', setting: 'logline.persistLogs' });
  lastPanel!.receive({ type: 'openSetting', setting: 'editor.fontSize' });
  assert.deepEqual(executed, [['logline.runCommand'], ['workbench.action.openSettings', 'logline.persistLogs']]);
  guide.dispose();
});

test('the guide marks only unopened sections New, and tells the host when one is opened', () => {
  const seen: string[] = [];
  const guide = new GuidePanel(
    { extensionUri: { fsPath: process.cwd() } as unknown as import('vscode').Uri },
    async () => undefined,
    {
      progress: () => ({ captured: false, searched: false, shared: false }),
      reveal: () => undefined,
      newSections: () => ['connections'],
      sectionSeen: (id) => seen.push(id),
    },
  );
  guide.open();
  const data = JSON.parse(/window\.__LOGLINE_GUIDE__ = (\{.*?\});/s.exec(lastPanel!.webview.html)![1]) as {
    sections: { id: string; isNew?: boolean }[];
  };
  assert.deepEqual(
    data.sections.filter((section) => section.isNew).map((section) => section.id),
    ['connections'],
    'a new section already opened is not marked',
  );
  lastPanel!.receive({ type: 'sectionSeen', section: 'connections' });
  lastPanel!.receive({ type: 'sectionSeen', section: 42 });
  assert.deepEqual(seen, ['connections']);
  guide.dispose();
});
