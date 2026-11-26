import * as vscode from 'vscode';
import { INSERT_EXTENSIONS, INSERT_MARKER, insertFamily, insertedLines, planInsertion } from '../core/log-insert';
import { counted, type Usage } from './usage';

const GLOB = `**/*.{${INSERT_EXTENSIONS.join(',')}}`;
const EXCLUDE = '**/{node_modules,.git,out,dist,build,target,vendor,.venv,venv,__pycache__,coverage,.next,bin,obj}/**';
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT_KEY = 'logline.hasInsertedLogs';

// A dotted name such as `order.customer.card`, or a PHP `$order`.
const WORD = /\$?[A-Za-z_][\w$]*(?:\.[A-Za-z_$][\w$]*)*/;
// Words at the cursor that are not values worth logging.
const KEYWORDS = new Set(
  (
    'const let var function return if else elif for while do switch case break continue def class import from export ' +
    'async await new this self true false null nil None True False undefined func fn pub mut val fun package public ' +
    'private protected static void int string bool try catch except finally throw raise with as in of is not and or ' +
    'yield lambda struct impl use type interface enum go defer select range end then begin unless match'
  ).split(' '),
);

/**
 * Insert Log and its cleanup: writes a log line for the expression at each
 * cursor in the style the file already logs with, marks it, and removes
 * marked lines from a file or the whole workspace.
 */
export class LogInserter implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private contextTimer?: ReturnType<typeof setTimeout>;
  private hasInserted = false;
  private contextValue?: boolean;

  constructor(private readonly usage?: Usage) {
    const register = (id: string, handler: (...args: any[]) => unknown) =>
      vscode.commands.registerCommand(id, counted(usage, id, handler));
    this.disposables.push(
      register('logline.insertLog', () => this.insert()),
      register('logline.removeInsertedLogsInFile', () => this.removeInFile()),
      register('logline.removeInsertedLogs', () => this.removeInWorkspace()),
      vscode.workspace.onDidOpenTextDocument(() => this.scheduleContext()),
      vscode.workspace.onDidCloseTextDocument(() => this.scheduleContext()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (insertFamily(event.document.uri.path)) this.scheduleContext();
      }),
    );
    this.scheduleContext();
  }

  dispose(): void {
    clearTimeout(this.contextTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  async insert(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return false;
    const { document } = editor;
    if (!insertFamily(document.uri.path)) {
      void vscode.window.showInformationMessage(
        'Logline: Insert Log writes JavaScript, TypeScript, Python, Go, Java, Kotlin, Scala, Groovy, C#, Rust, Ruby, PHP, Swift, and Dart.',
      );
      return false;
    }
    const text = document.getText();
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const insertions = editor.selections.flatMap((selection) => {
      const insertion = planInsertion({
        file: document.uri.path,
        text,
        line: selection.start.line,
        expression: expressionAt(document, selection),
      });
      return insertion ? [insertion] : [];
    });
    if (!insertions.length) return false;
    const applied = await editor.edit((builder) => {
      for (const insertion of insertions) {
        if (insertion.line >= document.lineCount) {
          builder.insert(document.lineAt(document.lineCount - 1).range.end, eol + insertion.text);
        } else builder.insert(new vscode.Position(insertion.line, 0), insertion.text + eol);
      }
    });
    if (applied) this.setContext(true);
    return applied;
  }

  async removeInFile(): Promise<number> {
    const editor = vscode.window.activeTextEditor;
    const lines = editor ? insertedLines(editor.document.getText()) : [];
    if (!editor || !lines.length) {
      void vscode.window.showInformationMessage('Logline: This file has no inserted logs.');
      return 0;
    }
    const applied = await editor.edit((builder) => {
      for (const line of lines) builder.delete(editor.document.lineAt(line).rangeIncludingLineBreak);
    });
    this.refreshContext(false);
    return applied ? lines.length : 0;
  }

  /** Remove every inserted line in the workspace, after confirming; returns how many were removed. */
  async removeInWorkspace(): Promise<number> {
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Logline: Finding inserted logs' },
      () => findInserted(),
    );
    const total = found.reduce((sum, file) => sum + file.lines.length, 0);
    if (!total) {
      this.setContext(false);
      void vscode.window.showInformationMessage('Logline: No inserted logs in this workspace.');
      return 0;
    }
    const files = found.length === 1 ? vscode.workspace.asRelativePath(found[0].uri) : `${found.length} files`;
    const answer = await vscode.window.showWarningMessage(
      `Remove ${total} inserted log ${total === 1 ? 'line' : 'lines'} from ${files}?`,
      { modal: true, detail: `Only lines ending in the ${INSERT_MARKER} marker comment are removed.` },
      'Remove',
    );
    if (answer !== 'Remove') return 0;
    const edit = new vscode.WorkspaceEdit();
    const clean: vscode.Uri[] = [];
    for (const file of found) {
      const document = await vscode.workspace.openTextDocument(file.uri);
      if (!document.isDirty) clean.push(file.uri);
      // Lines are found again in the document, which may differ from the file on disk.
      for (const line of insertedLines(document.getText())) {
        edit.delete(file.uri, document.lineAt(line).rangeIncludingLineBreak);
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) return 0;
    // Files that had no unsaved changes are saved, so removing leaves nothing to save by hand.
    for (const uri of clean) {
      const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString());
      await document?.save();
    }
    this.refreshContext(false);
    return total;
  }

  private scheduleContext(): void {
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => this.refreshContext(true), 300);
    this.contextTimer.unref?.();
  }

  /**
   * Whether Source Control offers removal: an open file has inserted lines,
   * or, with `keep`, this window inserted some that may sit in files since closed.
   */
  private refreshContext(keep: boolean): void {
    const open = vscode.workspace.textDocuments.some(
      (document) => insertFamily(document.uri.path) !== undefined && insertedLines(document.getText()).length > 0,
    );
    this.setContext(open || (keep && this.hasInserted));
  }

  private setContext(value: boolean): void {
    this.hasInserted = value;
    if (value === this.contextValue) return;
    this.contextValue = value;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, value);
  }
}

/** The selected text when it is on one line, otherwise the name at the cursor, if it is not a keyword. */
export function expressionAt(document: vscode.TextDocument, selection: vscode.Selection): string {
  if (!selection.isEmpty && selection.start.line === selection.end.line) {
    return document.getText(selection).trim();
  }
  const range = document.getWordRangeAtPosition(selection.active, WORD);
  const word = range ? document.getText(range) : '';
  return KEYWORDS.has(word) ? '' : word;
}

async function findInserted(): Promise<{ uri: vscode.Uri; lines: number[] }[]> {
  const found: { uri: vscode.Uri; lines: number[] }[] = [];
  const open = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  const uris = await vscode.workspace.findFiles(GLOB, EXCLUDE, MAX_FILES);
  for (const uri of uris) {
    let text = open.get(uri.toString())?.getText();
    if (text === undefined) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
    }
    const lines = insertedLines(text);
    if (lines.length) found.push({ uri, lines });
  }
  return found;
}
