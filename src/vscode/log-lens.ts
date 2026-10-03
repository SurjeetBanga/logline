import * as vscode from 'vscode';
import { extractLogSites, LOG_SITE_EXTENSIONS, siteQuery, type LogSite, type LogSiteIndex, type LogSiteTracker, type SiteStats } from '../core/log-sites';
import type { LogStore } from '../core/log-store';
import type { Settings } from '../core/settings';
import { openSourceLocation } from './source-navigation';

export type LensMode = 'off' | 'codelens' | 'codelens+gutter';

export interface LensSources {
  store: Pick<LogStore, 'eventsAfter' | 'discarded'>;
  config: Settings;
  index: LogSiteIndex;
  tracker: LogSiteTracker;
  /** Changes when retained logs are cleared. */
  generation(): number;
  /** Filter the Logs panel and bring it into view. */
  showQuery(query: string): Promise<void>;
}

const GLOB = `**/*.{${LOG_SITE_EXTENSIONS.join(',')}}`;
const EXCLUDE = '**/{node_modules,.git,out,dist,build,target,vendor,.venv,venv,__pycache__,coverage,.next,bin,obj}/**';
const MAX_FILE_BYTES = 512 * 1024;
// Indexing a workspace changes the index many times a second; recounting
// waits for it to settle. Evictions only lower counts, so they are folded in
// at most this often.
const INDEX_SETTLE_MS = 1000;
const EVICTION_RECOUNT_MS = 10000;

export function lensMode(config: Settings): LensMode {
  const value = config.get<string>('logLenses', 'codelens');
  return value === 'off' || value === 'codelens+gutter' ? value : 'codelens';
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function lensTitle(stats: SiteStats, now = Date.now()): string {
  const parts = [`$(pulse) ${stats.hits.toLocaleString()} ${stats.hits === 1 ? 'hit' : 'hits'}`];
  if (stats.errors) parts.push(`${stats.errors.toLocaleString()} ${stats.errors === 1 ? 'error' : 'errors'}`);
  if (stats.lastSeen !== undefined) parts.push(`last ${formatAgo(now - stats.lastSeen)}`);
  return parts.join(' · ');
}

/**
 * Connects logging statements in the editor to captured logs: CodeLens
 * counts above each statement that produced retained events, hovers with
 * recent values, optional gutter markers for statements that logged errors,
 * and navigation from an event back to the statement that produced it.
 */
export class LogLens implements vscode.CodeLensProvider, vscode.HoverProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;
  private readonly uris = new Map<string, vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly indexing: vscode.Disposable[] = [];
  private readonly pendingDocuments = new Map<string, ReturnType<typeof setTimeout>>();
  private decoration?: vscode.TextEditorDecorationType;
  private mode: LensMode = 'off';
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private generation?: number;
  private discarded = 0;
  private indexedAt = 0;
  private recountedAt = 0;
  private scan = 0;
  private disposed = false;
  // Basenames already looked up on demand, so each is searched for once.
  private readonly located = new Set<string>();

  constructor(private readonly sources: LensSources, private readonly extensionUri: vscode.Uri) {
    const selector = LOG_SITE_EXTENSIONS.map(extension => ({ scheme: 'file', pattern: `**/*.${extension}` }));
    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerHoverProvider(selector, this),
      vscode.commands.registerCommand('logline.showLogSite', (id: unknown) => this.showSite(id)),
      vscode.commands.registerCommand('logline.showQuietLogStatements', () => this.showQuietStatements()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('logline.logLenses')) this.applyMode(); })
    );
    this.applyMode();
  }

  get enabled(): boolean { return this.mode !== 'off'; }

  /** Count newly captured events; coalesced to the panel refresh interval. */
  schedule(delay = this.sources.config.get('refreshIntervalMs', 500)): void {
    if (!this.enabled || this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.refresh(); }, delay);
    this.refreshTimer.unref?.();
  }

  /**
   * Bring counts up to date. New events are counted incrementally; clearing
   * logs, re-indexing source, or evicting old events recounts the retained
   * events, so counts match what the Logs panel can show.
   */
  refresh(now = Date.now()): void {
    if (!this.enabled) return;
    const { tracker, index, store } = this.sources;
    const generation = this.sources.generation();
    const cleared = generation !== this.generation;
    const reindexed = tracker.indexVersion !== index.version;
    if (reindexed && !cleared && now - this.indexedAt < INDEX_SETTLE_MS) { this.schedule(INDEX_SETTLE_MS); return; }
    const evicted = store.discarded !== this.discarded;
    const recount = cleared || reindexed || (evicted && now - this.recountedAt >= EVICTION_RECOUNT_MS);
    let changed: boolean;
    if (recount) {
      const hadStats = tracker.stats.size > 0;
      this.generation = generation;
      this.discarded = store.discarded;
      this.recountedAt = now;
      tracker.reset();
      changed = tracker.process(store.eventsAfter(0)) || hadStats;
    } else {
      changed = tracker.process(store.eventsAfter(tracker.watermark));
      if (evicted) this.schedule(EVICTION_RECOUNT_MS - (now - this.recountedAt));
    }
    if (changed) { this.changeEmitter.fire(); this.decorate(); }
    const unresolved = index.takeUnresolved();
    if (unresolved.length) void this.indexReported(unresolved);
  }

  /**
   * Index files that events report as their origin but the workspace scan
   * did not reach, such as files beyond the file limit in a large repository.
   */
  private async indexReported(files: string[]): Promise<void> {
    const scan = this.scan;
    for (const reported of files) {
      const path = reported.replace(/\\/g, '/');
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!name || this.located.has(name) || this.located.size >= 1000 || !this.indexableName(name)) continue;
      this.located.add(name);
      const escaped = name.replace(/[[\]{}*?]/g, char => `[${char}]`);
      const uris = await vscode.workspace.findFiles(`**/${escaped}`, EXCLUDE, 20).then(found => found, () => []);
      if (scan !== this.scan || !this.enabled) return;
      // Keep files whose path agrees with the reported one as far as both go.
      const tail = path.split('/').filter(Boolean).slice(-3).join('/');
      for (const uri of uris) {
        if (uri.path.endsWith('/' + tail) || tail.endsWith(this.fileId(uri))) await this.indexFromDisk(uri);
      }
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled) return [];
    const now = Date.now();
    const lenses: vscode.CodeLens[] = [];
    for (const site of this.sources.index.sitesIn(this.fileId(document.uri))) {
      const stats = this.sources.tracker.stats.get(site.id);
      if (!stats?.hits || site.line > document.lineCount) continue;
      const range = new vscode.Range(site.line - 1, 0, site.line - 1, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: lensTitle(stats, now), command: 'logline.showLogSite', arguments: [site.id],
        tooltip: `Show the ${stats.hits.toLocaleString()} matching events in the Logs panel`
      }));
    }
    return lenses;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.enabled) return undefined;
    const site = this.sources.index.sitesIn(this.fileId(document.uri)).find(item => item.line === position.line + 1);
    const stats = site && this.sources.tracker.stats.get(site.id);
    if (!site || !stats?.hits) return undefined;
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: ['logline.showLogSite'] };
    const how = stats.exact === stats.hits ? 'matched by the code location in each event'
      : stats.exact ? 'matched by code location and message text' : 'matched by message text';
    markdown.appendMarkdown(`**Logline** · ${lensTitle(stats).replace('$(pulse) ', '')} · ${how}\n\n`);
    for (const sample of [...stats.samples].reverse()) {
      markdown.appendMarkdown(`- \`${sample.level.toUpperCase()}\` `);
      markdown.appendText(sample.message);
      markdown.appendMarkdown('\n');
    }
    markdown.appendMarkdown(`\n[Show in Logs](command:logline.showLogSite?${encodeURIComponent(JSON.stringify([site.id]))})`);
    return new vscode.Hover(markdown);
  }

  /** Open the statement for a site found in the index. */
  async openSite(site: LogSite): Promise<void> {
    const uri = this.uris.get(site.file);
    if (!uri) { await openSourceLocation(site, 'Choose log statement'); return; }
    const document = await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(Math.min(site.line - 1, document.lineCount - 1), Math.max(0, site.column - 1));
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
  }

  dispose(): void {
    this.disposed = true;
    this.stopIndexing();
    for (const disposable of this.disposables) disposable.dispose();
    this.changeEmitter.dispose();
  }

  private async showSite(id: unknown): Promise<void> {
    const site = typeof id === 'string' ? this.sources.index.find(id) : undefined;
    if (site) await this.sources.showQuery(siteQuery(site));
  }

  private async showQuietStatements(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!this.enabled) { void vscode.window.showInformationMessage('Logline log lenses are off. Turn on logline.logLenses to find quiet log statements.'); return; }
    const sites = editor ? this.sources.index.sitesIn(this.fileId(editor.document.uri)) : [];
    if (!editor || !sites.length) { void vscode.window.showInformationMessage('Logline found no log statements in the active editor.'); return; }
    const quiet = sites.filter(site => !this.sources.tracker.stats.get(site.id)?.hits);
    if (!quiet.length) { void vscode.window.showInformationMessage(`Every log statement in ${vscode.workspace.asRelativePath(editor.document.uri)} produced retained events.`); return; }
    const picked = await vscode.window.showQuickPick(quiet.map(site => ({
      label: `Line ${site.line}`, description: site.level, detail: site.template, site
    })), { title: `${quiet.length} of ${sites.length} log statements produced no retained events`, placeHolder: 'Go to a log statement that has not logged' });
    if (picked) await this.openSite(picked.site);
  }

  private applyMode(): void {
    const mode = lensMode(this.sources.config);
    if (mode === this.mode) return;
    const wasEnabled = this.enabled;
    this.mode = mode;
    if (mode === 'codelens+gutter' && !this.decoration) {
      this.decoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'log-error.svg'), gutterIconSize: '70%',
        overviewRulerColor: new vscode.ThemeColor('editorError.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right
      });
    } else if (mode !== 'codelens+gutter' && this.decoration) {
      this.decoration.dispose();
      this.decoration = undefined;
    }
    if (this.enabled && !wasEnabled) this.startIndexing();
    else if (!this.enabled && wasEnabled) { this.stopIndexing(); this.sources.index.clear(); this.sources.tracker.reset(); }
    this.changeEmitter.fire();
    this.decorate();
  }

  private decorate(): void {
    if (!this.decoration) return;
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      const ranges = this.sources.index.sitesIn(this.fileId(editor.document.uri))
        .filter(site => (this.sources.tracker.stats.get(site.id)?.errors ?? 0) > 0 && site.line <= editor.document.lineCount)
        .map(site => new vscode.Range(site.line - 1, 0, site.line - 1, 0));
      editor.setDecorations(this.decoration, ranges);
    }
  }

  // Multi-root workspaces prefix the folder name, so `src/index.ts` in two
  // folders stays two files.
  private fileId(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1).replace(/\\/g, '/');
  }

  private index(uri: vscode.Uri, text: string): void {
    const file = this.fileId(uri);
    this.uris.set(file, uri);
    const version = this.sources.index.version;
    // Open editors are indexed from memory, so they get the same bound as files read from disk.
    this.sources.index.setFile(file, text.length > MAX_FILE_BYTES ? [] : extractLogSites(file, text));
    if (this.sources.index.version !== version) this.indexedAt = Date.now();
    this.schedule();
  }

  private startIndexing(): void {
    const scan = ++this.scan;
    for (const document of vscode.workspace.textDocuments ?? []) {
      if (document.uri.scheme === 'file' && this.indexable(document.uri)) this.index(document.uri, document.getText());
    }
    const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    const reload = (uri: vscode.Uri) => {
      if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty)) return;
      void this.indexFromDisk(uri);
    };
    this.indexing.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload),
      watcher.onDidDelete(uri => { const file = this.fileId(uri); this.uris.delete(file); this.sources.index.deleteFile(file); this.schedule(); }),
      vscode.workspace.onDidChangeTextDocument(event => this.documentChanged(event.document)));
    // Relative times in CodeLens titles age between bursts of logs.
    this.clockTimer = setInterval(() => { if (this.sources.tracker.stats.size) this.changeEmitter.fire(); }, 15000);
    this.clockTimer.unref?.();
    void (async () => {
      const uris = await vscode.workspace.findFiles(GLOB, EXCLUDE, Math.max(100, Math.min(50000, this.sources.config.get('logLensMaxFiles', 5000))));
      for (let start = 0; start < uris.length; start += 50) {
        if (scan !== this.scan || this.disposed) return;
        await Promise.all(uris.slice(start, start + 50).map(uri => this.indexFromDisk(uri)));
        await new Promise(resolve => setImmediate(resolve));
      }
    })().catch(() => undefined);
  }

  private stopIndexing(): void {
    this.scan++;
    for (const disposable of this.indexing.splice(0)) disposable.dispose();
    for (const timer of this.pendingDocuments.values()) clearTimeout(timer);
    this.pendingDocuments.clear();
    clearInterval(this.clockTimer);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.uris.clear();
    this.located.clear();
  }

  private indexable(uri: vscode.Uri): boolean { return this.indexableName(uri.path); }

  private indexableName(name: string): boolean {
    return LOG_SITE_EXTENSIONS.includes(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
  }

  // Lens positions follow edits before the file is saved.
  private documentChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' || !this.indexable(document.uri)) return;
    const key = document.uri.toString();
    clearTimeout(this.pendingDocuments.get(key));
    this.pendingDocuments.set(key, setTimeout(() => {
      this.pendingDocuments.delete(key);
      if (this.enabled) this.index(document.uri, document.getText());
    }, 300));
  }

  private async indexFromDisk(uri: vscode.Uri): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES || !this.enabled) return;
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (this.enabled) this.index(uri, new TextDecoder().decode(bytes));
    } catch { /* deleted or unreadable files simply have no sites */ }
  }
}
