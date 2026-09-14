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
import { exportQuery, serializeExport, type ExportFormat, type ExportRequest } from '../transfer/log-export';
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

  async saveExport(content: string, fileFormat: ExportFormat | 'md', defaultName: string): Promise<boolean> {
    const filters: { [name: string]: string[]; } = fileFormat === 'md' ? { Markdown: ['md'] }
      : fileFormat === 'csv' ? { CSV: ['csv'] } : fileFormat === 'json' ? { JSON: ['json'] } : { 'JSON Lines': ['jsonl'] };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const uri = await vscode.window.showSaveDialog({
      ...(folder ? { defaultUri: vscode.Uri.file(path.join(folder, defaultName)) } : {}),
      filters,
      saveLabel: 'Export'
    });
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

  queryExportEvents(request: ExportRequest = {}): LogEvent[] {
    return this.store.all({ query: request.query, serverId: request.serverId, levels: request.levels });
  }

  collectExportEvents(request: ExportRequest = {}): LogEvent[] {
    return this.queryExportEvents(request).map(event => redactEvent(event, this.redactionOptions()));
  }

  async exportLogs(request: ExportRequest = {}): Promise<void> {
    const format = await this.chooseExportFormat();
    if (!format) return;
    if (format === 'md') return this.exportForAI(request);
    const events = this.collectExportEvents(request);
    await this.saveExport(serializeExport(events, format), format, `logline-export.${format}`);
  }

  async exportForAI(request: ExportRequest = {}): Promise<void> {
    const limit = 1000;
    const events = this.queryExportEvents(request);
    const selected = events.slice(-limit).map(event => redactEvent(event, this.redactionOptions()));
    const omitted = events.length - selected.length;
    const lines = selected.map(event => JSON.stringify(event)).join('\n');
    const content = [
      '# Logline incident context', '',
      `Events: ${events.length}${omitted > 0 ? ` (latest ${limit} included)` : ''}`,
      `Query: ${exportQuery(request) || '(none)'}`,
      '', '```jsonl', lines, '```', ''
    ].join('\n');
    await this.saveExport(content, 'md', 'logline-ai-context.md');
  }

  async copyFiltered(request: ExportRequest = {}): Promise<void> {
    const limit = 1000;
    const events = this.collectExportEvents(request);
    const selected = events.slice(-limit);
    await vscode.env.clipboard.writeText(serializeExport(selected, 'jsonl'));
    const suffix = events.length > limit ? ` (latest ${limit.toLocaleString()} of ${events.length.toLocaleString()})` : '';
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
