import * as vscode from 'vscode';
import type { LogsController } from './logs-controller';
import { webviewHtml } from './webview-html';

export class LogsProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>,
    private readonly controller: LogsController,
  ) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    const subscription = this.controller.notifications.subscribe((message) => {
      void view.webview.postMessage(message);
    });
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const messages = view.webview.onDidReceiveMessage((message) => {
      void this.controller
        .handleMessage((reply) => {
          void view.webview.postMessage(reply);
        }, message)
        .catch((error) => vscode.window.showErrorMessage(`Logline: ${String(error)}`));
    });
    view.onDidDispose(() => {
      subscription.dispose();
      messages.dispose();
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
