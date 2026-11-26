import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SourceLocation } from '../core/exceptions';
import type { LogStore } from '../core/log-store';
import { RuntimeErrorTracker, runtimeErrorText, type RuntimeError } from '../core/runtime-errors';
import type { Settings } from '../core/settings';
import { counted, type Usage } from './usage';

export type RuntimeErrorMode = 'inline' | 'problems' | 'off';

export interface RuntimeErrorSources {
  store: Pick<LogStore, 'eventsAfter'>;
  config: Settings;
  /** Changes when retained logs are cleared. */
  generation(): number;
  showQuery(query: string): Promise<void>;
  usage?: Usage;
}

const SOURCE = 'Logline runtime';
const MAX_SHOWN = 200;
const EXCLUDE = '**/{node_modules,.git,out,dist,build,target,vendor,.venv,venv}/**';

export function runtimeErrorMode(config: Settings): RuntimeErrorMode {
  const value = config.get<string>('runtimeErrors', 'inline');
  return value === 'off' || value === 'problems' ? value : 'inline';
}

/**
 * Marks the lines that raised captured errors: a diagnostic in the Problems
 * panel, and in `inline` mode the error, its count, and its age after the
 * line. Quick fixes show its events or set a breakpoint on the line.
 */
export class RuntimeErrors implements vscode.CodeActionProvider, vscode.Disposable {
  readonly tracker = new RuntimeErrorTracker();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('logline-runtime');
  private readonly disposables: vscode.Disposable[] = [this.diagnostics];
  private decoration?: vscode.TextEditorDecorationType;
  private mode: RuntimeErrorMode = 'off';
  private timer?: ReturnType<typeof setTimeout>;
  private clock?: ReturnType<typeof setInterval>;
  private generation?: number;
  private shownRevision = -1;
  // Workspace files for logged paths; null when a path is not in the workspace.
  private readonly resolved = new Map<string, vscode.Uri | null>();
  private readonly resolving = new Map<string, Promise<vscode.Uri | null>>();
  // Lines edited since an error was last seen there, until it happens again.
  private readonly dismissed = new Map<string, number>();
  // What each shown diagnostic stands for, for its quick fixes.
  private readonly shown = new Map<string, { error: RuntimeError; uri: vscode.Uri; line: number }>();
  private disposed = false;

  constructor(private readonly sources: RuntimeErrorSources) {
    this.disposables.push(
      vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.commands.registerCommand(
        'logline.showRuntimeError',
        counted(sources.usage, 'logline.showRuntimeError', (key: unknown) => this.showError(key)),
      ),
      vscode.commands.registerCommand(
        'logline.breakOnRuntimeError',
        counted(sources.usage, 'logline.breakOnRuntimeError', (key: unknown) => this.breakOn(key)),
      ),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      vscode.workspace.onDidChangeTextDocument((event) => this.edited(event)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('logline.runtimeErrors')) this.applyMode();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders?.(() => this.resolved.clear()) ?? { dispose() {} },
    );
    this.applyMode();
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** Count newly captured events, coalesced to the panel refresh interval. */
  schedule(delay = this.sources.config.get('refreshIntervalMs', 500)): void {
    if (!this.enabled || this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  async refresh(now = Date.now()): Promise<void> {
    if (!this.enabled) return;
    const { tracker } = this;
    const { store } = this.sources;
    const generation = this.sources.generation();
    if (generation !== this.generation) {
      this.generation = generation;
      tracker.reset();
      this.dismissed.clear();
    }
    tracker.process(store.eventsAfter(tracker.watermark));
    tracker.evict(store.eventsAfter(0).next().value?.id ?? Infinity);
    if (tracker.revision === this.shownRevision) return;
    this.shownRevision = tracker.revision;
    await this.show(now);
  }

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== SOURCE) continue;
      const key = shownKey(document.uri, diagnostic.range.start.line);
      const entry = this.shown.get(key);
      if (!entry) continue;
      const show = new vscode.CodeAction('Show in Logs', vscode.CodeActionKind.QuickFix);
      show.command = { title: 'Show in Logs', command: 'logline.showRuntimeError', arguments: [entry.error.key] };
      show.diagnostics = [diagnostic];
      show.isPreferred = true;
      const breakpoint = new vscode.CodeAction('Break here next time', vscode.CodeActionKind.QuickFix);
      breakpoint.command = {
        title: 'Break here next time',
        command: 'logline.breakOnRuntimeError',
        arguments: [entry.error.key],
      };
      breakpoint.diagnostics = [diagnostic];
      const investigate = new vscode.CodeAction('Investigate with agent', vscode.CodeActionKind.QuickFix);
      const relative = vscode.workspace.asRelativePath?.(entry.uri) ?? entry.uri.path;
      investigate.command = {
        title: 'Investigate with agent',
        command: 'logline.investigate',
        arguments: [
          {
            message: entry.error.message,
            eventId: entry.error.lastId,
            query: entry.error.query,
            count: entry.error.count,
            location: `${relative}:${entry.line + 1}`,
            ...(entry.error.ci ? { ci: entry.error.ci } : {}),
          },
        ],
      };
      investigate.diagnostics = [diagnostic];
      actions.push(show, investigate, breakpoint);
    }
    return actions;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.clock);
    this.decoration?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private applyMode(): void {
    const mode = runtimeErrorMode(this.sources.config);
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'inline' && !this.decoration) {
      this.decoration = vscode.window.createTextEditorDecorationType({
        after: {
          color: new vscode.ThemeColor('editorError.foreground'),
          margin: '0 0 0 2em',
          fontStyle: 'italic',
        },
        overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      });
    } else if (mode !== 'inline' && this.decoration) {
      this.decoration.dispose();
      this.decoration = undefined;
    }
    clearInterval(this.clock);
    if (mode === 'off') {
      this.tracker.reset();
      this.diagnostics.clear();
      this.shown.clear();
      return;
    }
    // Ages in the inline text grow between bursts of errors.
    this.clock = setInterval(() => {
      if (this.shown.size) void this.show(Date.now());
    }, 15000);
    this.clock.unref?.();
    this.generation = undefined;
    this.shownRevision = -1;
    void this.refresh();
  }

  private async show(now: number): Promise<void> {
    const byFile = new Map<string, { uri: vscode.Uri; entries: { error: RuntimeError; line: number }[] }>();
    const taken = new Set<string>();
    for (const error of this.tracker.list(MAX_SHOWN)) {
      const place = await this.locate(error.frames, error.test);
      if (!place) continue;
      const key = shownKey(place.uri, place.line);
      // The newest error on a line speaks for it.
      if (taken.has(key) || (this.dismissed.get(key) ?? -1) >= error.lastId) continue;
      taken.add(key);
      const file = byFile.get(place.uri.toString()) ?? { uri: place.uri, entries: [] };
      file.entries.push({ error, line: place.line });
      byFile.set(place.uri.toString(), file);
    }
    if (this.disposed || !this.enabled) return;
    this.diagnostics.clear();
    this.shown.clear();
    for (const { uri, entries } of byFile.values()) {
      const diagnostics = entries.map(({ error, line }) => {
        const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        const diagnostic = new vscode.Diagnostic(range, runtimeErrorText(error, now), vscode.DiagnosticSeverity.Error);
        diagnostic.source = SOURCE;
        this.shown.set(shownKey(uri, line), { error, uri, line });
        return diagnostic;
      });
      this.diagnostics.set(uri, diagnostics);
    }
    this.decorate(now);
  }

  private decorate(now = Date.now()): void {
    if (!this.decoration) return;
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      const uri = editor.document.uri.toString();
      const options: vscode.DecorationOptions[] = [];
      for (const entry of this.shown.values()) {
        if (entry.uri.toString() !== uri || entry.line >= editor.document.lineCount) continue;
        const end = editor.document.lineAt(entry.line).range.end;
        options.push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: runtimeErrorText(entry.error, now, 90) } },
        });
      }
      editor.setDecorations(this.decoration, options);
    }
  }

  // An edit on a marked line hides its mark until the error happens again.
  private edited(event: vscode.TextDocumentChangeEvent): void {
    if (!this.shown.size || !event.contentChanges.length) return;
    let changed = false;
    for (const change of event.contentChanges) {
      for (let line = change.range.start.line; line <= change.range.end.line; line++) {
        const key = shownKey(event.document.uri, line);
        const entry = this.shown.get(key);
        if (!entry) continue;
        this.dismissed.set(key, entry.error.lastId);
        this.shown.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    const remaining = [...this.shown.values()].filter(
      (entry) => entry.uri.toString() === event.document.uri.toString(),
    );
    this.diagnostics.set(
      event.document.uri,
      (this.diagnostics.get(event.document.uri) ?? []).filter((diagnostic) =>
        remaining.some((entry) => entry.line === diagnostic.range.start.line),
      ),
    );
    this.decorate();
  }

  /** The first frame in a workspace file, as a 0-based line. */
  private async locate(
    frames: SourceLocation[],
    test?: string,
  ): Promise<{ uri: vscode.Uri; line: number } | undefined> {
    for (const frame of frames) {
      const uri = await this.resolve(frame.file);
      if (!uri) continue;
      // A failed CI test whose runner gave no source line is marked where the test is named.
      if (frame.line === 0) return { uri, line: test ? await testLine(uri, test) : 0 };
      return { uri, line: frame.line - 1 };
    }
    return undefined;
  }

  private resolve(file: string): Promise<vscode.Uri | null> {
    const known = this.resolved.get(file);
    if (known !== undefined) return Promise.resolve(known);
    let pending = this.resolving.get(file);
    if (!pending) {
      pending = findWorkspaceFile(file).then((uri) => {
        this.resolved.set(file, uri);
        this.resolving.delete(file);
        return uri;
      });
      this.resolving.set(file, pending);
    }
    return pending;
  }

  private async showError(key: unknown): Promise<void> {
    const error = typeof key === 'string' ? this.tracker.errors.get(key) : undefined;
    if (!error) return;
    await this.sources.showQuery(error.query ?? `id:${error.lastId}`);
  }

  private breakOn(key: unknown): void {
    const entry = [...this.shown.values()].find((item) => item.error.key === key);
    if (!entry) return;
    const position = new vscode.Position(entry.line, 0);
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(entry.uri, position))]);
    void vscode.window.showInformationMessage(
      'Logline added a breakpoint on the line that raised this error. Run it under the debugger to stop there.',
    );
  }
}

const shownKey = (uri: vscode.Uri, line: number) => `${uri.toString()}#${line}`;

/** The 0-based line that names a test, `test('adds items', …)`, by its own name without its suites; 0 when not found. */
export async function testLine(uri: vscode.Uri, test: string): Promise<number> {
  const name = test.split(' › ').at(-1)?.trim();
  if (!name) return 0;
  let text: string;
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return 0;
  }
  const lines = text.split(/\r?\n/);
  for (const quote of ["'", '"', '`']) {
    const needle = `${quote}${name}${quote}`;
    const index = lines.findIndex((line) => line.includes(needle));
    if (index >= 0) return index;
  }
  return 0;
}

/**
 * The workspace file a stack frame names, without asking: an absolute path
 * inside a workspace folder, a path relative to one, or the one file whose
 * path ends with it. Anything else is not marked.
 */
async function findWorkspaceFile(file: string): Promise<vscode.Uri | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const folder of folders) {
    const candidate = path.resolve(folder.uri.fsPath, file);
    const relative = path.relative(folder.uri.fsPath, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      const uri = vscode.Uri.file(candidate);
      if ((await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File) return uri;
    } catch {
      /* look it up by name */
    }
  }
  const name = normalized.split('/').at(-1);
  if (!name || !folders.length) return null;
  const escaped = name.replace(/[[\]{}*?]/g, (char) => `[${char}]`);
  const matches = await vscode.workspace.findFiles(`**/${escaped}`, EXCLUDE, 20).then(
    (found) => found,
    () => [],
  );
  // A path from another machine, such as a container's /app/src/x.ts, matches by its tail.
  const parts = normalized.split('/').filter(Boolean);
  for (let take = Math.min(parts.length, 4); take >= 1; take--) {
    const tail = '/' + parts.slice(-take).join('/');
    const found = matches.filter((uri) => uri.path.endsWith(tail));
    if (found.length === 1) return found[0];
    if (found.length > 1) return null;
  }
  return null;
}
