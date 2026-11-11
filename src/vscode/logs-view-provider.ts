import * as vscode from 'vscode';
import type { LogsController } from './logs-controller';
import { webviewHtml } from './webview-html';

export class LogsProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** Whether the Logs panel is on screen. */
  get visible(): boolean {
    return this.view?.visible ?? false;
  }
  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>,
    private readonly controller: LogsController,
  ) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const subscription = this.controller.notifications.subscribe((message) => {
      void view.webview.postMessage(message);
    });
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    // How long the panel takes to show its first logs, from opening.
    let opened: number | undefined = performance.now();
    const messages = view.webview.onDidReceiveMessage((message) => {
      void this.controller
        .handleMessage((reply) => {
          if (opened !== undefined && (reply as { type?: string }).type === 'snapshot') {
            this.controller.usage?.record('perf', { op: 'first_render', ms: performance.now() - opened });
            opened = undefined;
          }
          void view.webview.postMessage(reply);
        }, message)
        .catch((error) => {
          this.controller.usage?.record('error', { area: 'panel', code: 'message_failed' });
          void vscode.window.showErrorMessage(`Logline: ${String(error)}`);
        });
    });
    if (view.visible) this.controller.usage?.panelOpened();
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) this.controller.usage?.panelOpened();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      subscription.dispose();
      messages.dispose();
      visibility.dispose();
    });
    view.webview.html = webviewHtml(
      view.webview,
      media,
      { html: 'viewer.html', style: 'viewer.css', script: 'viewer.js' },
      {
        GUIDE_UNREAD: String(this.controller.guideStatus().unread),
        FIRST_RUN: String(this.controller.firstRun()),
      },
    );
    void view.webview.postMessage({ type: 'guideStatus', ...this.controller.guideStatus() });
    // Hiding or disposing the view does not stop the server or retain a UI queue.
  }
}
