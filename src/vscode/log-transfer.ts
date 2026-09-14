import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import * as vscode from 'vscode';
import type { Ingestion } from '../capture/ingestion';
import type { RuntimeState } from '../capture/runtime-state';
import type { LogStore } from '../core/log-store';
import { redactEvent, type RedactionOptions } from '../core/redaction';
import type { Settings } from '../core/settings';
import type { LogEvent } from '../core/types';
import { exportChunks, exportQuery, serializeExport, type ExportFormat, type ExportRequest } from '../transfer/log-export';
import { writeExportFile } from '../storage/export-file';
import { importRecords } from '../transfer/log-import';

export class LogTransfer {
  constructor(private readonly store: LogStore, private readonly config: Settings,
    private readonly ingestion: Ingestion, private readonly state: RuntimeState) { }
  redactionOptions(): RedactionOptions {
    return {
      enabled: this.config.get('redactExports', true),
      fields: this.config.get<string[]>('redactionFields', []),
      replacement: this.config.get('redactionReplacement', '[REDACTED]')
    };
  }

  async chooseExportFormat(): Promise<ExportFormat | 'md' | undefined> {
    const choice = await vscode.window.showQuickPick([
      { label: 'JSON Lines', description: 'One redacted event per line', format: 'jsonl' as const },
      { label: 'JSON', description: 'A redacted JSON array', format: 'json' as const },
      { label: 'CSV', description: 'Rows with common fields as columns', format: 'csv' as const },
      { label: 'AI context (Markdown)', description: 'Up to 1,000 filtered events for AI tools', format: 'md' as const }
    ], { title: 'Export retained logs' });
    return choice?.format;
  }

  private async chooseDestination(fileFormat: ExportFormat | 'md', defaultName: string): Promise<vscode.Uri | undefined> {
    const filters: { [name: string]: string[]; } = fileFormat === 'md' ? { Markdown: ['md'] }
      : fileFormat === 'csv' ? { CSV: ['csv'] } : fileFormat === 'json' ? { JSON: ['json'] } : { 'JSON Lines': ['jsonl'] };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return vscode.window.showSaveDialog({
      ...(folder ? { defaultUri: vscode.Uri.file(path.join(folder, defaultName)) } : {}),
      filters,
      saveLabel: 'Export'
    });
  }

  async saveExport(content: string, fileFormat: ExportFormat | 'md', defaultName: string): Promise<boolean> {
    const uri = await this.chooseDestination(fileFormat, defaultName);
    if (!uri) return false;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    } catch (error) {
      vscode.window.showErrorMessage(`Could not export logs: ${(error as Error).message}`);
      return false;
    }
    vscode.window.showInformationMessage(`Exported logs to ${path.basename(uri.fsPath)}.`);
    return true;
  }

  private latestExportEvents(request: ExportRequest): { events: LogEvent[]; matched: number; } {
    // Reuse indexed/cached paging, then fetch full records only for that page.
    // Clipboard and AI exports must not clone or redact all retained history.
    const page = this.store.page(request);
    const options = this.redactionOptions();
    return { matched: page.matched, events: page.events.map(row => redactEvent(this.store.find(row.id)!, options)) };
  }

  async exportLogs(request: ExportRequest = {}): Promise<void> {
    const format = await this.chooseExportFormat();
    if (!format) return;
    if (format === 'md') return this.exportForAI(request);
    const uri = await this.chooseDestination(format, `logline-export.${format}`);
    if (!uri) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting logs', cancellable: true }, async (_progress, token) => {
      try {
        if (token.isCancellationRequested) return;
        const events = this.store.exportEvents(request);
        await writeExportFile(uri.scheme === 'file' ? uri.fsPath : undefined,
          exportChunks(events, format, this.redactionOptions(), () => token.isCancellationRequested),
          () => token.isCancellationRequested, bytes => vscode.workspace.fs.writeFile(uri, bytes));
        void vscode.window.showInformationMessage(`Exported ${events.length.toLocaleString()} logs to ${path.basename(uri.fsPath)}.`);
      } catch (error) {
        if (!token.isCancellationRequested) void vscode.window.showErrorMessage(`Could not export logs: ${(error as Error).message}`);
      }
    });
  }

  async exportForAI(request: ExportRequest = {}): Promise<void> {
    const limit = 1000;
    const { events: selected, matched } = this.latestExportEvents(request);
    const omitted = matched - selected.length;
    const lines = selected.map(event => JSON.stringify(event)).join('\n');
    const content = [
      '# Logline incident context', '',
      `Events: ${matched}${omitted > 0 ? ` (latest ${limit} included)` : ''}`,
      `Query: ${exportQuery(request) || '(none)'}`,
      '', '```jsonl', lines, '```', ''
    ].join('\n');
    await this.saveExport(content, 'md', 'logline-ai-context.md');
  }

  async copyFiltered(request: ExportRequest = {}): Promise<void> {
    const limit = 1000;
    const { events: selected, matched } = this.latestExportEvents(request);
    await vscode.env.clipboard.writeText(serializeExport(selected, 'jsonl'));
    const suffix = matched > limit ? ` (latest ${limit.toLocaleString()} of ${matched.toLocaleString()})` : '';
    void vscode.window.showInformationMessage(`Copied ${selected.length.toLocaleString()} filtered log rows${suffix}.`);
  }

  async exportContext(ids: number[]): Promise<void> {
    const events = ids.map(id => this.store.find(id)).filter((event): event is LogEvent => event !== undefined)
      .map(event => redactEvent(event, this.redactionOptions()));
    const format = await this.chooseExportFormat();
    if (!format) return;
    if (format === 'md') {
      const content = ['# Logline context', '', `Events: ${events.length}`, '', '```jsonl', events.map(event => JSON.stringify(event)).join('\n'), '```', ''].join('\n');
      await this.saveExport(content, 'md', 'logline-context.md');
      return;
    }
    await this.saveExport(serializeExport(events, format), format, `logline-context.${format}`);
  }

  async importLogs(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
      filters: { Logs: ['jsonl', 'ndjson', 'json', 'log', 'txt', 'csv'], CSV: ['csv'], 'Plain text': ['txt', 'log'] },
      openLabel: 'Import logs'
    });
    if (!uris?.length) return;
    let imported = 0;
    for (const uri of uris) {
      // Keep surrounding context from crossing between independently imported files.
      const sessionId = randomBytes(8).toString('hex');
      try {
        // Native files stream in bounded chunks. Other VS Code filesystem
        // providers expose only readFile, so release their buffer after this file.
        const chunks = uri.scheme === 'file' ? createReadStream(uri.fsPath, { highWaterMark: 64 * 1024 })
          : this.importFileChunks(await vscode.workspace.fs.readFile(uri));
        const format = path.extname(uri.path).slice(1).toLowerCase();
        const limit = this.config.get('maxLineLength', 65536);
        for await (const record of importRecords(chunks, format, limit)) {
          this.ingestion.accept(record.raw, 'import', { serverId: 'imported', server: 'Imported', sessionId, truncated: record.truncated });
          imported++;
          if (imported % 500 === 0) { this.state.notify(); await yieldToHost(); }
        }
      } catch (error) {
        void vscode.window.showWarningMessage(`Could not finish importing ${path.basename(uri.path)}: ${(error as Error).message}`);
      }
    }
    if (imported) {
      this.state.generation++;
      this.state.status = `Imported ${imported.toLocaleString()} events`;
      this.state.notify();
    }
    vscode.window.showInformationMessage(`Imported ${imported.toLocaleString()} log events.`);
  }

  private async *importFileChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024);
  }
}
