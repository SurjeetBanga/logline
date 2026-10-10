import { stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { parseDiffRanges, WHOLE_FILE, type ChangedLines, type LineRanges } from '../core/changed-lines';

// The parts of the built-in git extension's API (`vscode.git`, version 1) that this reads.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly commit?: string };
    readonly indexChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
    readonly untrackedChanges?: readonly GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
  diffWith(ref: string, path: string): Promise<string>;
}
interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

// Status values from the git extension's `Status` enum.
const INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9;
const NEW_FILE = new Set([INDEX_ADDED, UNTRACKED, INTENT_TO_ADD]);
const GONE = new Set([INDEX_DELETED, DELETED, IGNORED]);
// Diffing is one git process per file; past this many changed files the
// working tree is a branch switch or a mass edit, not a change being tested.
const MAX_FILES = 300;
const SETTLE_MS = 750;

/**
 * Keeps `ChangedLines` matched to the working tree: what each repository's
 * files changed since its HEAD commit. Files are diffed when they first show
 * up as changed and again when they change on disk, whether saved in the
 * editor or written by an agent or a formatter; a new HEAD diffs everything again.
 */
export class GitChanges implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repositories = new Map<GitRepository, { head?: string; listener: vscode.Disposable }>();
  private readonly ranges = new Map<string, LineRanges>();
  /** Each diffed file's modification time when it was diffed. */
  private readonly modified = new Map<string, number | undefined>();
  private readonly stale = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private disposed = false;
  private changedFiles = 0;

  constructor(
    private readonly changes: ChangedLines,
    private readonly onChange: () => void,
  ) {
    void this.start();
  }

  /** Whether the workspace has a git repository, and how many files changed in it. */
  status(): { files: number } | undefined {
    return this.repositories.size ? { files: this.changedFiles } : undefined;
  }

  private async start(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) return;
    let api: GitApi;
    try {
      api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    } catch {
      return;
    }
    if (this.disposed) return;
    this.disposables.push(
      api.onDidOpenRepository((repository) => this.add(repository)),
      api.onDidCloseRepository((repository) => this.remove(repository)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file' || !this.ranges.has(document.uri.fsPath)) return;
        this.stale.add(document.uri.fsPath);
        this.schedule();
      }),
    );
    for (const repository of api.repositories) this.add(repository);
  }

  private add(repository: GitRepository): void {
    if (this.repositories.has(repository)) return;
    this.repositories.set(repository, { listener: repository.state.onDidChange(() => this.schedule()) });
    this.schedule();
  }

  private remove(repository: GitRepository): void {
    const record = this.repositories.get(repository);
    if (!record) return;
    record.listener.dispose();
    this.repositories.delete(repository);
    if (!this.repositories.size) this.onChange();
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update();
    }, SETTLE_MS);
    this.timer.unref?.();
  }

  private async update(): Promise<void> {
    // One pass at a time; a change during a pass schedules the next.
    if (this.running) {
      await this.running;
      this.schedule();
      return;
    }
    this.running = this.collect().finally(() => {
      this.running = undefined;
    });
    await this.running;
  }

  private async collect(): Promise<void> {
    const before = JSON.stringify([this.status(), this.changes.version]);
    const wanted = new Map<string, { repository: GitRepository; whole: boolean }>();
    for (const [repository, record] of this.repositories) {
      const head = repository.state.HEAD?.commit;
      if (head !== record.head) {
        // A commit, checkout or reset moves what every file is compared with.
        for (const file of this.ranges.keys()) if (isInside(file, repository.rootUri.fsPath)) this.stale.add(file);
        record.head = head;
      }
      const { indexChanges, workingTreeChanges, untrackedChanges = [] } = repository.state;
      for (const change of [...indexChanges, ...workingTreeChanges, ...untrackedChanges]) {
        if (change.uri.scheme !== 'file' || GONE.has(change.status)) continue;
        const file = change.uri.fsPath;
        const whole = !head || NEW_FILE.has(change.status) || wanted.get(file)?.whole === true;
        wanted.set(file, { repository, whole });
      }
    }
    this.changedFiles = wanted.size;
    for (const file of [...this.ranges.keys()])
      if (!wanted.has(file)) {
        this.ranges.delete(file);
        this.modified.delete(file);
      }
    for (const [file, { repository, whole }] of [...wanted].slice(0, MAX_FILES)) {
      if (this.disposed) return;
      // Agents and command-line tools write files without a save event, so a new modification time also means a new diff.
      const mtime = (await stat(file).catch(() => undefined))?.mtimeMs;
      if (this.ranges.has(file) && !this.stale.has(file) && this.modified.get(file) === mtime) continue;
      this.stale.delete(file);
      this.modified.set(file, mtime);
      if (whole) {
        this.ranges.set(file, WHOLE_FILE);
        continue;
      }
      try {
        this.ranges.set(file, parseDiffRanges(await repository.diffWith('HEAD', file)));
      } catch {
        this.ranges.delete(file);
      }
    }
    this.changes.set(this.ranges);
    if (JSON.stringify([this.status(), this.changes.version]) !== before) this.onChange();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const { listener } of this.repositories.values()) listener.dispose();
    this.repositories.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function isInside(file: string, root: string): boolean {
  return (
    file === root ||
    file.startsWith(root.endsWith('/') || root.endsWith('\\') ? root : root + (root.includes('\\') ? '\\' : '/'))
  );
}
