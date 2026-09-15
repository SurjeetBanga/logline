import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { LogsController } from './logs-controller';

export class LogsProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>, private readonly controller: LogsController) { }
  resolveWebviewView(view: vscode.WebviewView): void {
    const subscription = this.controller.notifications.subscribe(message => { void view.webview.postMessage(message); });
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const messages = view.webview.onDidReceiveMessage(message => {
      void this.controller.handleMessage(reply => { void view.webview.postMessage(reply); }, message)
        .catch(error => vscode.window.showErrorMessage(`Logline: ${String(error)}`));
    });
    view.onDidDispose(() => { subscription.dispose(); messages.dispose(); });
    const replacements: Record<string, string> = {
      '{{CSP_SOURCE}}': view.webview.cspSource,
      '{{NONCE}}': randomBytes(16).toString('hex'),
      '{{STYLE_URI}}': String(view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'))),
      '{{SCRIPT_URI}}': String(view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js'))),
      '{{GUIDE_UNREAD}}': String(this.controller.guideStatus().unread)
    };
    view.webview.html = readFileSync(vscode.Uri.joinPath(media, 'viewer.html').fsPath, 'utf8')
      .replace(/\{\{[A-Z_]+\}\}/g, key => replacements[key] ?? '');
    void view.webview.postMessage({ type: 'guideStatus', ...this.controller.guideStatus() });
    // Hiding or disposing the view does not stop the server or retain a UI queue.
  }
}
