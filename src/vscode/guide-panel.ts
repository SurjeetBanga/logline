import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { GUIDE_RELEASES } from './guide-content';

type GuideSection = 'guide' | 'whatsNew';
type GuideMessage =
  | { type: 'guideReady' }
  | { type: 'guideRendered'; section: GuideSection }
  | { type: 'openChangelog' };

/** Owns the single editor tab used by the offline Logline Guide. */
export class GuidePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pendingSection: GuideSection = 'guide';

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>,
    private readonly onWhatsNewRendered: () => Promise<void>
  ) { }

  open(section: GuideSection = 'guide'): void {
    this.pendingSection = section;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      if (this.ready) this.select(section);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'logline.guide', 'Logline Guide', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] }
    );
    this.panel = panel;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const replacements: Record<string, string> = {
      '{{CSP_SOURCE}}': panel.webview.cspSource,
      '{{NONCE}}': randomBytes(16).toString('hex'),
      '{{STYLE_URI}}': String(panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'guide.css'))),
      '{{SCRIPT_URI}}': String(panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'guide.js'))),
      '{{RELEASES_JSON}}': JSON.stringify(GUIDE_RELEASES).replace(/</g, '\\u003c')
    };
    const messageSubscription = panel.webview.onDidReceiveMessage(message => {
      const value = message as Partial<GuideMessage>;
      if (value.type === 'guideReady') {
        this.ready = true;
        this.select(this.pendingSection);
      } else if (value.type === 'guideRendered' && value.section === 'whatsNew') {
        void this.onWhatsNewRendered().catch(() => { /* Keep the badge if persistence fails. */ });
      } else if (value.type === 'openChangelog') {
        void vscode.commands.executeCommand('markdown.showPreview', this.changelogUri());
      }
    });
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
      }
    });
    panel.webview.html = readFileSync(vscode.Uri.joinPath(media, 'guide.html').fsPath, 'utf8')
      .replace(/\{\{[A-Z_]+\}\}/g, key => replacements[key] ?? '');
  }

  private select(section: GuideSection): void {
    void this.panel?.webview.postMessage({ type: 'selectSection', section });
  }

  private changelogUri(): vscode.Uri {
    const upper = vscode.Uri.joinPath(this.context.extensionUri, 'CHANGELOG.md');
    return existsSync(upper.fsPath) ? upper : vscode.Uri.joinPath(this.context.extensionUri, 'changelog.md');
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.ready = false;
  }
}
