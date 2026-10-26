import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { webviewHtml } from './webview-html';
import { GUIDE_CARDS, GUIDE_KEYS, GUIDE_RELEASES, GUIDE_SECTIONS, type GuideProgress } from './guide-content';

type GuideSection = 'guide' | 'whatsNew';
type GuideMessage =
  | { type: 'guideReady' }
  | { type: 'guideRendered'; section: GuideSection }
  | { type: 'openChangelog' }
  | { type: 'reveal'; target: string; fallback?: string }
  | { type: 'runCommand'; command: string }
  | { type: 'openSetting'; setting: string }
  | { type: 'openDocs'; anchor: string }
  | { type: 'takeTour' }
  | { type: 'sectionSeen'; section: string };

/** What the guide needs from the rest of the extension. */
export interface GuideHost {
  /** How far someone has got, for the Get started steps. */
  progress(): GuideProgress;
  /** Show a control in the Logs panel, or `fallback` while it is hidden. */
  reveal(target: string, fallback?: string): void;
  /** How many highlights of the latest release are unread. */
  unreadHighlights?(): number;
  /** Start the Logs panel tour. */
  takeTour?(): void;
  /** The sections still marked New, and telling the host one was opened. */
  newSections?(): string[];
  sectionSeen?(id: string): void;
}

// The guide can only ask for what its own cards name.
const COMMANDS = new Set(GUIDE_CARDS.flatMap((card) => (card.command ? [card.command] : [])));
const SETTINGS = new Set(GUIDE_CARDS.flatMap((card) => (card.setting ? [card.setting] : [])));
const DOCS = new Set(GUIDE_CARDS.flatMap((card) => (card.docs ? [card.docs] : [])));
const CONTROL = /^[A-Za-z][\w-]{0,63}$/;

/** Owns the single editor tab used by the offline Logline Guide. */
export class GuidePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private pendingSection: GuideSection = 'guide';

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>,
    private readonly onWhatsNewRendered: () => Promise<void>,
    private readonly host?: GuideHost,
  ) {}

  open(section: GuideSection = 'guide'): void {
    this.pendingSection = section;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      if (this.ready) {
        this.select(section);
        this.sendProgress();
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel('logline.guide', 'Logline Guide', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    this.panel = panel;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const guide = {
      releases: GUIDE_RELEASES,
      // A section stays New until it is opened; without a host every new section is.
      sections: GUIDE_SECTIONS.map((section) =>
        section.isNew && this.host?.newSections && !this.host.newSections().includes(section.id)
          ? { ...section, isNew: false }
          : section,
      ),
      cards: GUIDE_CARDS,
      keys: GUIDE_KEYS,
      unreadHighlights: this.host?.unreadHighlights?.() ?? 0,
    };
    const messageSubscription = panel.webview.onDidReceiveMessage((message) => this.receive(message as GuideMessage));
    // Steps done elsewhere tick off when the guide is looked at again.
    const visibility = panel.onDidChangeViewState?.(() => {
      if (panel.visible) this.sendProgress();
    });
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      visibility?.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        this.ready = false;
      }
    });
    panel.webview.html = webviewHtml(
      panel.webview,
      media,
      { html: 'guide.html', style: 'guide.css', script: 'guide.js' },
      { GUIDE_JSON: JSON.stringify(guide).replace(/</g, '\\u003c') },
    );
  }

  private receive(value: Partial<GuideMessage>): void {
    if (value.type === 'guideReady') {
      this.ready = true;
      this.select(this.pendingSection);
      this.sendProgress();
    } else if (value.type === 'guideRendered' && value.section === 'whatsNew') {
      void this.onWhatsNewRendered().catch(() => {
        /* Keep the badge if persistence fails. */
      });
    } else if (value.type === 'openChangelog') {
      void vscode.commands.executeCommand('markdown.showPreview', this.changelogUri());
    } else if (value.type === 'reveal' && typeof value.target === 'string' && CONTROL.test(value.target)) {
      const fallback = typeof value.fallback === 'string' && CONTROL.test(value.fallback) ? value.fallback : undefined;
      this.host?.reveal(value.target, fallback);
    } else if (value.type === 'runCommand' && typeof value.command === 'string' && COMMANDS.has(value.command)) {
      void vscode.commands.executeCommand(value.command);
    } else if (value.type === 'openSetting' && typeof value.setting === 'string' && SETTINGS.has(value.setting)) {
      void vscode.commands.executeCommand('workbench.action.openSettings', value.setting);
    } else if (value.type === 'sectionSeen' && typeof value.section === 'string') {
      this.host?.sectionSeen?.(value.section);
    } else if (value.type === 'takeTour') {
      this.host?.takeTour?.();
    } else if (value.type === 'openDocs' && typeof value.anchor === 'string' && DOCS.has(value.anchor)) {
      const usage = vscode.Uri.joinPath(this.context.extensionUri, 'docs', 'usage.md');
      void vscode.commands.executeCommand('markdown.showPreview', usage.with?.({ fragment: value.anchor }) ?? usage);
    }
  }

  private sendProgress(): void {
    const progress = this.host?.progress();
    if (progress) void this.panel?.webview.postMessage({ type: 'guideProgress', progress });
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
