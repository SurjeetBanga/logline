import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';

/**
 * A page from media/ for a webview, its placeholders filled: `{{CSP_SOURCE}}`,
 * a fresh `{{NONCE}}`, `{{STYLE_URI}}` and `{{SCRIPT_URI}}`, and `values` by
 * name. A placeholder with no value becomes empty, so none reaches the page.
 */
export function webviewHtml(
  webview: vscode.Webview,
  media: vscode.Uri,
  files: { html: string; style: string; script: string },
  values: Record<string, string> = {},
): string {
  const replacements: Record<string, string> = {
    ...values,
    CSP_SOURCE: webview.cspSource,
    NONCE: randomBytes(16).toString('hex'),
    STYLE_URI: String(webview.asWebviewUri(vscode.Uri.joinPath(media, files.style))),
    SCRIPT_URI: String(webview.asWebviewUri(vscode.Uri.joinPath(media, files.script))),
  };
  return readFileSync(vscode.Uri.joinPath(media, files.html).fsPath, 'utf8').replace(
    /\{\{([A-Z_]+)\}\}/g,
    (_, key: string) => replacements[key] ?? '',
  );
}
