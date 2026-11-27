import * as vscode from 'vscode';
import { counted, type Usage } from './usage';
import {
  extractLogSites,
  LOG_SITE_EXTENSIONS,
  siteDurations,
  siteQuery,
  type LogSite,
  type LogSiteIndex,
  type LogSiteTracker,
  type SiteDurations,
  type SiteStats,
} from '../core/log-sites';
import type { LogStore } from '../core/log-store';
import type { Settings } from '../core/settings';
import { isInsertedLine, loggedValue } from '../core/log-insert';
import { shortValue, siteValue } from '../core/inline-value';
import type { RedactionOptions } from '../core/redaction';
import { openSourceLocation } from './source-navigation';

export type LensMode = 'off' | 'codelens' | 'codelens+gutter';

export interface LensSources {
  store: Pick<LogStore, 'eventsAfter' | 'find'>;
  config: Settings;
  index: LogSiteIndex;
  tracker: LogSiteTracker;
  /** Changes when retained logs are cleared. */
  generation(): number;
  /** Filter the Logs panel and bring it into view. */
  showQuery(query: string): Promise<void>;
  usage?: Usage;
}

const GLOB = `**/*.{${LOG_SITE_EXTENSIONS.join(',')}}`;
const EXCLUDE = '**/{node_modules,.git,out,dist,build,target,vendor,.venv,venv,__pycache__,coverage,.next,bin,obj}/**';
const MAX_FILE_BYTES = 512 * 1024;
// Indexing a workspace changes the index many times a second; recounting
// waits for it to settle.
const INDEX_SETTLE_MS = 1000;

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

export function formatMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 100) / 100} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${Math.round(ms / 10) / 100} s`;
}

/** Durations as a lens shows them: percentiles once there are enough to mean something. */
export function durationText(durations: SiteDurations): string {
  if (durations.count >= 5) return `p50 ${formatMs(durations.p50)} · p95 ${formatMs(durations.p95)}`;
  if (durations.min === durations.max) return formatMs(durations.min);
  return `${formatMs(durations.min)}–${formatMs(durations.max)}`;
}

export function lensTitle(stats: SiteStats, now = Date.now()): string {
  const parts = [`$(pulse) ${stats.hits.toLocaleString()} ${stats.hits === 1 ? 'hit' : 'hits'}`];
  const durations = siteDurations(stats);
  if (durations) parts.push(durationText(durations));
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
  // What each statement logged last, after its line; a statement that logged an error has its own colour.
  private valueDecoration?: vscode.TextEditorDecorationType;
  private errorValueDecoration?: vscode.TextEditorDecorationType;
  // Each statement's latest value, kept until it logs again.
  private readonly values = new Map<string, { id: number; value: string | undefined }>();
  // Statements whose line was edited since they last logged, with the event shown then, until a newer one.
  private readonly dismissed = new Map<string, number>();
  private mode: LensMode = 'off';
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private generation?: number;
  private indexedAt = 0;
  private scan = 0;
  private disposed = false;
  // Basenames already looked up on demand, so each is searched for once.
  private readonly located = new Set<string>();

  constructor(
    private readonly sources: LensSources,
    private readonly extensionUri: vscode.Uri,
  ) {
    const selector = LOG_SITE_EXTENSIONS.map((extension) => ({ scheme: 'file', pattern: `**/*.${extension}` }));
    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerHoverProvider(selector, this),
      vscode.commands.registerCommand(
        'logline.showLogSite',
        counted(this.sources.usage, 'logline.showLogSite', (id: unknown) => this.showSite(id)),
      ),
      vscode.commands.registerCommand(
        'logline.copyLogValue',
        counted(this.sources.usage, 'logline.copyLogValue', (id: unknown) => this.copyValue(id)),
      ),
      vscode.commands.registerCommand(
        'logline.breakAtLogSite',
        counted(this.sources.usage, 'logline.breakAtLogSite', (id: unknown) => this.breakAt(id)),
      ),
      vscode.commands.registerCommand(
        'logline.showQuietLogStatements',
        counted(this.sources.usage, 'logline.showQuietLogStatements', () => this.showQuietStatements()),
      ),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('logline.logLenses')) this.applyMode();
        else if (event.affectsConfiguration('logline.inlineValues')) {
          this.changeEmitter.fire();
          this.decorate();
        }
      }),
    );
    this.applyMode();
  }

  /** Whether each log statement shows what it logged last after its line. */
  get inlineValues(): boolean {
    return this.enabled && this.sources.config.get('inlineValues', true);
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** Count newly captured events; coalesced to the panel refresh interval. */
  schedule(delay = this.sources.config.get('refreshIntervalMs', 500)): void {
    if (!this.enabled || this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, delay);
    this.refreshTimer.unref?.();
  }

  /**
   * Bring counts up to date. New events are counted and evicted events
   * subtracted incrementally; clearing logs or re-indexing source recounts the
   * retained events, so counts match what the Logs panel can show.
   */
  refresh(now = Date.now()): void {
    if (!this.enabled) return;
    const { tracker, index, store } = this.sources;
    const generation = this.sources.generation();
    const cleared = generation !== this.generation;
    const reindexed = tracker.indexVersion !== index.version;
    if (reindexed && !cleared && now - this.indexedAt < INDEX_SETTLE_MS) {
      this.schedule(INDEX_SETTLE_MS);
      return;
    }
    let changed: boolean;
    if (cleared || reindexed) {
      const hadStats = tracker.stats.size > 0;
      this.generation = generation;
      tracker.reset();
      changed = tracker.process(store.eventsAfter(0)) || hadStats;
    } else {
      changed = tracker.process(store.eventsAfter(tracker.watermark));
      // Evicted events are always the oldest, so subtract what they counted.
      changed = tracker.evict(store.eventsAfter(0).next().value?.id ?? Infinity) || changed;
    }
    if (changed) {
      this.changeEmitter.fire();
      this.decorate();
    }
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
      const escaped = name.replace(/[[\]{}*?]/g, (char) => `[${char}]`);
      const uris = await vscode.workspace.findFiles(`**/${escaped}`, EXCLUDE, 20).then(
        (found) => found,
        () => [],
      );
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
      const value = this.inlineValues ? undefined : this.insertedValue(document, site, stats);
      lenses.push(
        new vscode.CodeLens(range, {
          title: value ? `${value} · ${lensTitle(stats, now).replace('$(pulse) ', '')}` : lensTitle(stats, now),
          command: 'logline.showLogSite',
          arguments: [site.id],
          tooltip: `Show the ${stats.hits.toLocaleString()} matching events in the Logs panel`,
        }),
      );
    }
    return lenses;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!this.enabled) return undefined;
    const site = this.sources.index.sitesIn(this.fileId(document.uri)).find((item) => item.line === position.line + 1);
    const stats = site && this.sources.tracker.stats.get(site.id);
    if (!site || !stats?.hits) return undefined;
    const markdown = new vscode.MarkdownString(undefined, true);
    const how =
      stats.exact === stats.hits
        ? 'matched by the code location in each event'
        : stats.exact
          ? 'matched by code location and message text'
          : 'matched by message text';
    markdown.appendMarkdown(`**Logline** · ${lensTitle(stats).replace('$(pulse) ', '')} · ${how}\n\n`);
    const durations = siteDurations(stats);
    if (durations) {
      const spread =
        durations.count >= 5
          ? `p50 ${formatMs(durations.p50)} · p95 ${formatMs(durations.p95)} · p99 ${formatMs(durations.p99)} · max ${formatMs(durations.max)}`
          : durationText(durations);
      markdown.appendMarkdown(
        `Duration ${spread}, from the latest ${durations.count.toLocaleString()} ${durations.count === 1 ? 'event' : 'events'} with \`durationMs\` or a similar field\n\n`,
      );
    }
    const values = this.inlineValues ? this.recentValues(site, stats) : [];
    if (values.length) {
      const now = Date.now();
      for (const { time, value } of values) {
        markdown.appendMarkdown(`- ${time === undefined ? '' : `${formatAgo(now - time)} · `}`);
        markdown.appendMarkdown(`\`${shortValue(value, 120).replace(/`/g, "'")}\`\n`);
      }
    } else {
      for (const sample of [...stats.samples].reverse()) {
        markdown.appendMarkdown(`- \`${sample.level.toUpperCase()}\` `);
        markdown.appendText(sample.message);
        markdown.appendMarkdown('\n');
      }
    }
    const args = encodeURIComponent(JSON.stringify([site.id]));
    markdown.isTrusted = { enabledCommands: ['logline.showLogSite', 'logline.copyLogValue', 'logline.breakAtLogSite'] };
    markdown.appendMarkdown(`\n[Show in Logs](command:logline.showLogSite?${args})`);
    if (values.length) markdown.appendMarkdown(` · [Copy value](command:logline.copyLogValue?${args})`);
    if (this.uris.has(site.file)) markdown.appendMarkdown(` · [Break here](command:logline.breakAtLogSite?${args})`);
    return new vscode.Hover(markdown);
  }

  /** Redaction for values shown in the editor: always on, with the fields and replacement the user set. */
  private redaction(): RedactionOptions {
    return {
      enabled: true,
      fields: this.sources.config.get<string[]>('redactionFields', []),
      replacement: this.sources.config.get('redactionReplacement', '[REDACTED]'),
    };
  }

  /** What a statement logged last, in full, read once per event. */
  private latestValue(site: LogSite, stats: SiteStats): string | undefined {
    const latest = stats.samples[stats.samples.length - 1];
    if (!latest) return undefined;
    const cached = this.values.get(site.id);
    if (cached?.id === latest.id) return cached.value;
    const event = this.sources.store.find(latest.id);
    const value = event ? siteValue(event, site, this.redaction()) : undefined;
    this.values.set(site.id, { id: latest.id, value });
    return value;
  }

  /** The values of a statement's retained samples, newest first. */
  private recentValues(site: LogSite, stats: SiteStats): { time?: number; value: string }[] {
    const redaction = this.redaction();
    return [...stats.samples].reverse().flatMap((sample) => {
      const event = this.sources.store.find(sample.id);
      const value = event && siteValue(event, site, redaction);
      return value ? [{ time: sample.time, value }] : [];
    });
  }

  private copyValue(id: unknown): void {
    const site = typeof id === 'string' ? this.sources.index.find(id) : undefined;
    const stats = site && this.sources.tracker.stats.get(site.id);
    const value = site && stats ? this.latestValue(site, stats) : undefined;
    if (value !== undefined) void vscode.env.clipboard.writeText(value);
  }

  private breakAt(id: unknown): void {
    const site = typeof id === 'string' ? this.sources.index.find(id) : undefined;
    const uri = site && this.uris.get(site.file);
    if (!site || !uri) return;
    const position = new vscode.Position(site.line - 1, Math.max(0, site.column - 1));
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, position))]);
    void vscode.window.showInformationMessage(
      'Logline added a breakpoint on this log statement. Run it under the debugger to stop there before it logs.',
    );
  }

  /**
   * For a line Insert Log wrote, what it logged last: `order = {"id":42}`.
   * The name comes from the label, `checkout: order`.
   */
  private insertedValue(document: vscode.TextDocument, site: LogSite, stats: SiteStats): string | undefined {
    if (!isInsertedLine(document.lineAt(site.line - 1).text)) return undefined;
    const latest = stats.samples[stats.samples.length - 1];
    const event = latest && this.sources.store.find(latest.id);
    if (!event) return undefined;
    const label = site.literals[0] ?? '';
    const value = loggedValue(event, label.trim());
    if (!value) return undefined;
    const name = label.match(/:\s*([^:]+?)\s*=?\s*$/)?.[1];
    return name && !name.startsWith('reached line')
      ? `$(debug-console) ${name} = ${value}`
      : `$(debug-console) ${value}`;
  }

  /** The file an indexed site was read from, when it was indexed in this window. */
  siteUri(site: LogSite): vscode.Uri | undefined {
    return this.uris.get(site.file);
  }

  /** Open the statement for a site found in the index. */
  async openSite(site: LogSite): Promise<void> {
    const uri = this.uris.get(site.file);
    if (!uri) {
      await openSourceLocation(site, 'Choose log statement');
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(Math.min(site.line - 1, document.lineCount - 1), Math.max(0, site.column - 1));
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
  }

  dispose(): void {
    this.disposed = true;
    this.stopIndexing();
    this.valueDecoration?.dispose();
    this.errorValueDecoration?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.changeEmitter.dispose();
  }

  private async showSite(id: unknown): Promise<void> {
    const site = typeof id === 'string' ? this.sources.index.find(id) : undefined;
    if (!site) return;
    this.sources.usage?.record('log_lens_clicked');
    await this.sources.showQuery(siteQuery(site));
  }

  private async showQuietStatements(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!this.enabled) {
      void vscode.window.showInformationMessage(
        'Logline log lenses are off. Turn on logline.logLenses to find quiet log statements.',
      );
      return;
    }
    const sites = editor ? this.sources.index.sitesIn(this.fileId(editor.document.uri)) : [];
    if (!editor || !sites.length) {
      void vscode.window.showInformationMessage('Logline found no log statements in the active editor.');
      return;
    }
    const quiet = sites.filter((site) => !this.sources.tracker.stats.get(site.id)?.hits);
    if (!quiet.length) {
      void vscode.window.showInformationMessage(
        `Every log statement in ${vscode.workspace.asRelativePath(editor.document.uri)} produced retained events.`,
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      quiet.map((site) => ({
        label: `Line ${site.line}`,
        description: site.level,
        detail: site.template,
        site,
      })),
      {
        title: `${quiet.length} of ${sites.length} log statements produced no retained events`,
        placeHolder: 'Go to a log statement that has not logged',
      },
    );
    if (picked) await this.openSite(picked.site);
  }

  private applyMode(): void {
    const mode = lensMode(this.sources.config);
    if (mode === this.mode) return;
    const wasEnabled = this.enabled;
    this.mode = mode;
    if (mode === 'codelens+gutter' && !this.decoration) {
      this.decoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'log-error.svg'),
        gutterIconSize: '70%',
        overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      });
    } else if (mode !== 'codelens+gutter' && this.decoration) {
      this.decoration.dispose();
      this.decoration = undefined;
    }
    if (this.enabled && !this.valueDecoration) {
      const after = { margin: '0 0 0 2em', fontStyle: 'italic' };
      this.valueDecoration = vscode.window.createTextEditorDecorationType({
        after: {
          ...after,
          color: new vscode.ThemeColor('editorInlayHint.foreground'),
          backgroundColor: new vscode.ThemeColor('editorInlayHint.background'),
        },
      });
      this.errorValueDecoration = vscode.window.createTextEditorDecorationType({
        after: { ...after, color: new vscode.ThemeColor('editorError.foreground') },
      });
    } else if (!this.enabled && this.valueDecoration) {
      this.valueDecoration.dispose();
      this.errorValueDecoration?.dispose();
      this.valueDecoration = this.errorValueDecoration = undefined;
    }
    if (this.enabled && !wasEnabled) this.startIndexing();
    else if (!this.enabled && wasEnabled) {
      this.stopIndexing();
      this.sources.index.clear();
      this.sources.tracker.reset();
      this.values.clear();
      this.dismissed.clear();
    }
    this.changeEmitter.fire();
    this.decorate();
  }

  private decorate(): void {
    this.decorateValues();
    if (!this.decoration) return;
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      const ranges = this.sources.index
        .sitesIn(this.fileId(editor.document.uri))
        .filter(
          (site) =>
            (this.sources.tracker.stats.get(site.id)?.errors ?? 0) > 0 && site.line <= editor.document.lineCount,
        )
        .map((site) => new vscode.Range(site.line - 1, 0, site.line - 1, 0));
      editor.setDecorations(this.decoration, ranges);
    }
  }

  /** Put each statement's latest value after its line, in the visible editors only. */
  private decorateValues(): void {
    if (!this.valueDecoration || !this.errorValueDecoration) return;
    const on = this.inlineValues;
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      const plain: vscode.DecorationOptions[] = [];
      const errors: vscode.DecorationOptions[] = [];
      if (on) {
        for (const site of this.sources.index.sitesIn(this.fileId(editor.document.uri))) {
          const stats = this.sources.tracker.stats.get(site.id);
          const latest = stats?.samples[stats.samples.length - 1];
          if (!stats || !latest || site.line > editor.document.lineCount) continue;
          if ((this.dismissed.get(site.id) ?? -1) >= latest.id) continue;
          const value = this.lineValue(editor.document, site, stats);
          if (!value) continue;
          const line = editor.document.lineAt(site.line - 1);
          const range = new vscode.Range(line.range.end, line.range.end);
          const error = latest.level === 'error' || latest.level === 'fatal';
          (error ? errors : plain).push({ range, renderOptions: { after: { contentText: value } } });
        }
      }
      editor.setDecorations(this.valueDecoration, plain);
      editor.setDecorations(this.errorValueDecoration, errors);
    }
  }

  /** The text after a statement's line: its value, named for a line Insert Log wrote. */
  private lineValue(document: vscode.TextDocument, site: LogSite, stats: SiteStats): string | undefined {
    const value = this.latestValue(site, stats);
    if (value === undefined) return undefined;
    // Insert Log labels its line `checkout: order`, which names the value.
    const name = isInsertedLine(document.lineAt(site.line - 1).text)
      ? (site.literals[0] ?? '').match(/:\s*([^:]+?)\s*=?\s*$/)?.[1]
      : undefined;
    return shortValue(name && !name.startsWith('reached line') ? `${name} = ${value}` : value);
  }

  /** An edited line hides its value until the statement logs again. */
  private hideEdited(event: vscode.TextDocumentChangeEvent): void {
    if (!this.inlineValues || !event.contentChanges.length) return;
    const sites = this.sources.index.sitesIn(this.fileId(event.document.uri));
    if (!sites.length) return;
    let changed = false;
    for (const change of event.contentChanges) {
      const first = change.range.start.line + 1;
      const last = change.range.end.line + 1;
      for (const site of sites) {
        if (site.line < first || site.line > last) continue;
        const latest = this.sources.tracker.stats.get(site.id)?.samples.at(-1);
        if (!latest || this.dismissed.get(site.id) === latest.id) continue;
        this.dismissed.set(site.id, latest.id);
        changed = true;
      }
    }
    if (changed) this.decorateValues();
  }

  // Multi-root workspaces prefix the folder name, so `src/index.ts` in two
  // folders stays two files.
  private fileId(uri: vscode.Uri): string {
    return vscode.workspace
      .asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1)
      .replace(/\\/g, '/');
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
      if (
        vscode.workspace.textDocuments.some(
          (document) => document.uri.toString() === uri.toString() && document.isDirty,
        )
      )
        return;
      void this.indexFromDisk(uri);
    };
    this.indexing.push(
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete((uri) => {
        const file = this.fileId(uri);
        this.uris.delete(file);
        this.sources.index.deleteFile(file);
        this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.hideEdited(event);
        this.documentChanged(event.document);
      }),
    );
    // Relative times in CodeLens titles age between bursts of logs.
    this.clockTimer = setInterval(() => {
      if (this.sources.tracker.stats.size) this.changeEmitter.fire();
    }, 15000);
    this.clockTimer.unref?.();
    void (async () => {
      const uris = await vscode.workspace.findFiles(
        GLOB,
        EXCLUDE,
        Math.max(100, Math.min(50000, this.sources.config.get('logLensMaxFiles', 5000))),
      );
      for (let start = 0; start < uris.length; start += 50) {
        if (scan !== this.scan || this.disposed) return;
        await Promise.all(uris.slice(start, start + 50).map((uri) => this.indexFromDisk(uri)));
        await new Promise((resolve) => setImmediate(resolve));
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

  private indexable(uri: vscode.Uri): boolean {
    return this.indexableName(uri.path);
  }

  private indexableName(name: string): boolean {
    return LOG_SITE_EXTENSIONS.includes(name.slice(name.lastIndexOf('.') + 1).toLowerCase());
  }

  // Lens positions follow edits before the file is saved.
  private documentChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' || !this.indexable(document.uri)) return;
    const key = document.uri.toString();
    clearTimeout(this.pendingDocuments.get(key));
    this.pendingDocuments.set(
      key,
      setTimeout(() => {
        this.pendingDocuments.delete(key);
        if (this.enabled) this.index(document.uri, document.getText());
      }, 300),
    );
  }

  private async indexFromDisk(uri: vscode.Uri): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES || !this.enabled) return;
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (this.enabled) this.index(uri, new TextDecoder().decode(bytes));
    } catch {
      /* deleted or unreadable files simply have no sites */
    }
  }
}
