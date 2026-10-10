import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractExceptions } from '../core/exceptions';
import type { LogStore } from '../core/log-store';

export async function openSource(store: LogStore, msg: Record<string, unknown>): Promise<void> {
  if (!Number.isSafeInteger(msg.id) || !Number.isSafeInteger(msg.block) || !Number.isSafeInteger(msg.line)) return;
  const event = store.find(msg.id as number);
  if (!event) {
    vscode.window.showInformationMessage('This event has been discarded from retained history.');
    return;
  }
  const source = extractExceptions(event)[msg.block as number]?.lines[msg.line as number]?.source;
  if (source) await openSourceLocation(source, 'Choose stack frame source');
}

/** Open a logged file location, resolved only against files inside the workspace. */
export async function openSourceLocation(
  source: { file: string; line: number; column?: number },
  title = 'Choose source file',
): Promise<void> {
  try {
    const uri = await resolveSourceUri(source, title);
    if (!uri) return;
    const document = await vscode.workspace.openTextDocument(uri);
    const line = Math.min(source.line - 1, document.lineCount - 1);
    const column = Math.min((source.column ?? 1) - 1, document.lineAt(line).text.length);
    const position = new vscode.Position(line, column);
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
  } catch (error) {
    vscode.window.showInformationMessage(`Could not open source: ${(error as Error).message}`);
  }
}

/**
 * The workspace file a logged path refers to. Paths outside the workspace
 * are never opened; when several files match, the user picks one.
 */
export async function resolveSourceUri(
  source: { file: string },
  title = 'Choose source file',
): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const normalized = source.file.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates: vscode.Uri[] = [];
  // A logged path can only open source inside the current workspace.
  for (const folder of folders) {
    const candidate = path.resolve(folder.uri.fsPath, source.file);
    const relative = path.relative(folder.uri.fsPath, candidate);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) continue;
    const uri = vscode.Uri.file(candidate);
    try {
      if ((await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File) candidates.push(uri);
    } catch {
      /* try source lookup */
    }
  }
  if (!candidates.length) {
    const filename = normalized.split('/').at(-1)!;
    const escaped = filename.replace(/[\[\]{}*?]/g, (char) => `[${char}]`);
    const matches = await vscode.workspace.findFiles(`**/${escaped}`, '**/{node_modules,.git,out,dist,build}/**', 100);
    const suffix = matches.filter((uri) => uri.path.endsWith('/' + normalized));
    candidates.push(...(suffix.length ? suffix : matches));
  }
  if (!candidates.length) {
    vscode.window.showInformationMessage(`Source file not found in this workspace: ${source.file}`);
    return;
  }
  const unique = [...new Map(candidates.map((uri) => [uri.toString(), uri])).values()];
  return unique.length === 1
    ? unique[0]
    : (
        await vscode.window.showQuickPick(
          unique.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
          { title },
        )
      )?.uri;
}
