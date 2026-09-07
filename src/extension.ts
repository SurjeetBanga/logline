import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, stat, rename, appendFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseLogLine } from './log-event';
import { LogStore, LineReader } from './log-store';
import { formatDetails } from './format-details';
import { nextServerId, resolveAutoStartServers, resolveRunTarget, resolveCwd } from './server-config';
import { parseJsonc } from './jsonc';
import { redactEvent, type RedactionOptions } from './redaction';
import type { LogEvent, ServerConfig, SessionStatus, SessionSummary } from './types';

const PERSIST_FLUSH_MS = 250;
const PERSIST_MAX_BUFFER = 2000;

let provider: LogsProvider | undefined;

interface LoglineTaskDefinition extends vscode.TaskDefinition {
  label?: string;
  command: string;
  args?: unknown[];
  options?: { cwd?: string; env?: Record<string, string> };
}

// A saved ServerConfig satisfies this structurally; ad-hoc/task-originated
// sessions use a bare id+label instead, since they have no saved settings.
interface SessionServer {
  id: string;
  label: string;
  jsonOnly?: boolean;
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  exited: boolean;
  server: SessionServer;
  record: SessionSummary;
}

type ExportFormat = 'jsonl' | 'json' | 'csv';

interface ExportRequest {
  query?: string;
  levels?: string[];
  serverId?: string;
}

interface ServerSummary {
  id: string;
  label: string;
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed';
  activeSessions: number;
  pid?: number;
  lastSession?: string;
}

function exportQuery(request: ExportRequest = {}): string {
  const server = request.serverId ? `serverId:${request.serverId}` : '';
  return [server, request.query?.trim() ?? ''].filter(Boolean).join(' ');
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeExport(events: LogEvent[], format: ExportFormat): string {
  if (format === 'json') return JSON.stringify(events, null, 2) + '\n';
  if (format === 'jsonl') return events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
  const fields = [...new Set(events.flatMap(event => Object.keys(event.fields ?? {})))].sort();
  const columns = ['id', 'timestamp', 'timestampMs', 'level', 'message', 'stream', 'server', 'serverId', 'sessionId', 'raw', ...fields];
  const rows = [columns.join(',')];
  for (const event of events) {
    rows.push(columns.map(column => column in event
      ? csvCell(event[column as keyof LogEvent])
      : csvCell(event.fields?.[column])).join(','));
  }
  return rows.join('\n') + '\n';
}

function parseImportRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return line; }
    });
  }
}

export function activate(context: vscode.ExtensionContext): { provider: LogsProvider } {
  provider = new LogsProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('logline.logs', provider),
    vscode.commands.registerCommand('logline.runCommand', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before running a server command.');
        return;
      }
      const command = await vscode.window.showInputBox({
        title: 'Run server in Logs', prompt: 'Server command',
        placeHolder: 'npm run dev', ignoreFocusOut: true
      });
      if (!command?.trim()) return;
      let folder = vscode.workspace.workspaceFolders?.[0];
      if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
        folder = await vscode.window.showWorkspaceFolderPick();
        if (!folder) return;
      }
      provider!.run(command.trim(), folder?.uri.fsPath, { id: 'custom', label: command.trim() });
      await vscode.commands.executeCommand('logline.logs.focus');
    }),
    vscode.commands.registerCommand('logline.stopCommand', () => provider!.stop()),
    vscode.commands.registerCommand('logline.export', () => provider!.exportLogs()),
    vscode.commands.registerCommand('logline.import', () => provider!.importLogs()),
    vscode.commands.registerCommand('logline.exportForAI', () => provider!.exportForAI()),
    vscode.commands.registerCommand('logline.showLogs', () =>
      vscode.commands.executeCommand('logline.logs.focus')),
    vscode.tasks.registerTaskProvider('logline', {
      provideTasks: () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return [];
        let definitions: LoglineTaskDefinition[] = [];
        try {
          const file = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
          const parsed = parseJsonc(readFileSync(file, 'utf8')) as { tasks?: LoglineTaskDefinition[] };
          definitions = parsed.tasks ?? [];
        } catch { return []; }
        return definitions.filter(task => task.type === 'logline' && task.command).map(task =>
          new vscode.Task(task, folder, task.label || task.command, 'logline', new vscode.CustomExecution(() =>
            Promise.resolve(new LogPseudoTerminal(provider!, task, folder)))));
      },
      resolveTask: task => {
        const definition = task.definition as LoglineTaskDefinition;
        if (definition?.type !== 'logline' || !definition.command) return undefined;
        const folder = vscode.workspace.workspaceFolders?.[0];
        return new vscode.Task(definition, folder!, definition.label || definition.command, 'logline',
          new vscode.CustomExecution(() => Promise.resolve(new LogPseudoTerminal(provider!, definition, folder))));
      }
    }),
    provider
  );
  startAutoServers();
  return { provider };
}

function startAutoServers(): void {
  const config = vscode.workspace.getConfiguration('logline');
  const { blocked, servers } = resolveAutoStartServers(config.get<ServerConfig[]>('servers', []), vscode.workspace.isTrusted);
  if (blocked) {
    vscode.window.showWarningMessage('Trust this workspace to auto-start saved servers.');
    return;
  }
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  for (const server of servers) provider!.run(server.command, resolveCwd(server.cwd, workspaceCwd), server, undefined, server.env);
}

export class LogsProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  context: vscode.ExtensionContext;
  config: vscode.WorkspaceConfiguration;
  store: LogStore;
  sequence = 0;
  status = 'Ready — run a server command to begin';
  command = '';
  sessions = new Set<Session>();
  sessionRegistry = new Map<string, SessionSummary>();
  timers = new Set<ReturnType<typeof setTimeout>>();
  generation = 0;
  views = new Set<vscode.Webview>();
  pendingWrites: string[] = [];
  persistTimer: ReturnType<typeof setTimeout> | undefined;
  persistedBytes: number | undefined;
  persistChain: Promise<void> | undefined;
  notifyTimer: ReturnType<typeof setTimeout> | undefined;
  notifyPending = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.config = vscode.workspace.getConfiguration('logline');
    this.store = new LogStore(this.config.get('maxEvents', 50000), this.config.get('maxMemoryMb', 100) * 1024 * 1024);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('logline')) return;
      this.config = vscode.workspace.getConfiguration('logline');
      if (event.affectsConfiguration('logline.maxEvents')
        || event.affectsConfiguration('logline.maxMemoryMb')) this.resizeStore();
      if (event.affectsConfiguration('logline.persistLogs')
        || event.affectsConfiguration('logline.maxDiskMb')) this.persistedBytes = undefined;
      if (!event.affectsConfiguration('logline.servers')) return;
      for (const webview of this.views) webview.postMessage({ type: 'serversChanged' });
    }));
  }

  // Views pull a snapshot only when told something changed, instead of
  // polling on a fixed interval. Calls here are cheap and frequent (once per
  // incoming log line); the timer coalesces them into at most one push per
  // refreshIntervalMs, whether the change came from one line or a flood.
  notifyViews(): void {
    if (this.notifyTimer) { this.notifyPending = true; return; }
    for (const webview of this.views) webview.postMessage({ type: 'update' });
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.notifyPending) { this.notifyPending = false; this.notifyViews(); }
    }, this.config.get('refreshIntervalMs', 500));
    this.notifyTimer.unref?.();
  }

  // Apply new retention limits live; the newest events that still fit are kept.
  resizeStore(): void {
    const maxRows = this.config.get('maxEvents', 50000);
    const maxBytes = this.config.get('maxMemoryMb', 100) * 1024 * 1024;
    if (maxRows === this.store.maxRows && maxBytes === this.store.maxBytes) return;
    this.store.resize(maxRows, maxBytes);
    this.generation++;
    this.notifyViews();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.add(view.webview);
    view.onDidDispose(() => this.views.delete(view.webview));
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.onDidReceiveMessage(message => this.handleMessage(view, message));
    const replacements: Record<string, string> = {
      '{{CSP_SOURCE}}': view.webview.cspSource,
      '{{NONCE}}': randomBytes(16).toString('hex'),
      '{{STYLE_URI}}': String(view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'))),
      '{{SCRIPT_URI}}': String(view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')))
    };
    view.webview.html = readFileSync(vscode.Uri.joinPath(media, 'viewer.html').fsPath, 'utf8')
      .replace(/\{\{[A-Z_]+\}\}/g, key => replacements[key] ?? '');
    // Hiding or disposing the view does not stop the server or retain a UI queue.
  }

  // `args`, when given, is a real argv array for the command (e.g. from a
  // tasks.json entry with a separate `args` list). It is run with shell:false
  // so each element reaches the process as one literal argument no matter
  // what it contains — spawn's shell:true does NOT escape an args array (it
  // only concatenates, the same bug as joining the string by hand), so that
  // combination would silently reintroduce the exact quoting problem this is
  // meant to fix. Without `args`, `command` is treated as a full shell command
  // line, which ad-hoc and saved-server commands need since users type shell
  // syntax (&&, pipes, quoting) directly into them.
  // `onExit`, when given, is called once with the process's exit code — used
  // by task terminals, which must signal VS Code's task system when they're
  // done or the task shows as running forever even after the process exits.
  run(
    command: string,
    cwd: string | undefined,
    server: Session['server'] = { id: 'custom', label: command },
    output?: { write: (text: string) => void },
    env?: Record<string, string>,
    args?: string[],
    onExit?: (code: number) => void
  ): void {
    // Saved servers are single-instance; ad-hoc commands all share the 'custom'
    // id and stay independent of each other.
    if (server.id !== 'custom') {
      for (const existing of this.sessions) {
        if (existing.server.id === server.id && !existing.stopping) {
          this.status = `Already running: ${server.label}`;
          this.notifyViews();
          onExit?.(1);
          return;
        }
      }
    }
    this.generation++;
    this.command = args ? [command, ...args].join(' ') : command;
    this.status = 'Running';
    this.notifyViews();
    const spawnOptions: SpawnOptions = {
      cwd, shell: !args, env: { ...process.env, ...(env ?? {}) }, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    };
    const child = (args ? spawn(command, args, spawnOptions) : spawn(command, spawnOptions)) as ChildProcessWithoutNullStreams;
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'), serverId: server.id, server: server.label,
      status: 'running', startedAt: Date.now(), pid: child.pid, events: 0
    };
    const session: Session = { child, stopping: false, exited: false, server, record };
    this.sessionRegistry.set(record.id, record);
    this.sessions.add(session);
    const source = this.config.get<string>('source', 'both');
    const readers = (['stdout', 'stderr'] as const).filter(stream => source === 'both' || source === stream).map(stream => {
      const reader = new LineReader((line, truncated) => {
        if (!this.sessions.has(session)) return;
        output?.write(line + '\r\n');
        this.persist(line);
        const event: LogEvent = parseLogLine(line, stream, ++this.sequence, new Date());
        // Some saved servers (e.g. a Gradle bootRun task) interleave build-tool
        // noise with the application's structured JSON on the same stream.
        if (server.jsonOnly && !event.isJson) return;
        event.serverId = server.id;
        event.server = server.label;
        event.sessionId = record.id;
        event.fields = { ...event.fields, server: server.label, serverId: server.id };
        event.truncated = truncated;
        if (truncated) event.isJson = false;
        record.events++;
        this.store.add(event);
        this.notifyViews();
      }, this.config.get('maxLineLength', 65536));
      child[stream].on('data', chunk => reader.write(chunk));
      return reader;
    });
    child.on('error', error => {
      record.status = 'failed';
      record.error = error.message;
      if (this.sessions.has(session)) this.status = `Failed: ${error.message}`;
      this.notifyViews();
    });
    child.on('close', (code, signal) => {
      session.exited = true;
      for (const reader of readers) reader.end();
      record.endedAt = Date.now();
      record.exitCode = typeof code === 'number' ? code : undefined;
      record.signal = signal ?? undefined;
      if (record.status !== 'failed') record.status = session.stopping ? 'exited' : (code === 0 ? 'exited' : 'failed');
      if (this.sessions.delete(session)) {
        if (!this.status.startsWith('Failed:')) {
          this.status = session.stopping ? 'Stopped' : `Exited: ${signal ?? code ?? 'unknown'}`;
        }
        if (this.sessions.size && !this.status.startsWith('Failed:')) this.status = 'Running';
        this.notifyViews();
      }
      this.pruneSessionRegistry();
      onExit?.(typeof code === 'number' ? code : (signal ? 1 : 0));
    });
  }

  pruneSessionRegistry(): void {
    const completed = [...this.sessionRegistry.values()]
      .filter(record => record.status === 'exited' || record.status === 'failed')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (this.sessionRegistry.size > 100 && completed.length) {
      this.sessionRegistry.delete(completed.shift()!.id);
    }
  }

  sessionSummaries(): SessionSummary[] {
    return [...this.sessionRegistry.values()].map(record => ({ ...record }));
  }

  serverSummaries(): ServerSummary[] {
    const configured = this.config.get<ServerConfig[]>('servers', []);
    const byId = new Map<string, SessionSummary[]>();
    for (const record of this.sessionRegistry.values()) {
      const records = byId.get(record.serverId) ?? [];
      records.push(record);
      byId.set(record.serverId, records);
    }
    const summaries: ServerSummary[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const records = byId.get(id) ?? [];
      const active = records.filter(record => record.status === 'starting' || record.status === 'running' || record.status === 'stopping');
      const last = records[records.length - 1];
      const status = active.some(record => record.status === 'stopping') ? 'stopping'
        : active.some(record => record.status === 'starting') ? 'starting'
          : active.length ? 'running' : last?.status ?? 'idle';
      summaries.push({ id, label, status, activeSessions: active.length,
        pid: active.find(record => record.pid !== undefined)?.pid, lastSession: last?.id });
    };
    for (const server of configured) add(server.id, server.label);
    for (const record of this.sessionRegistry.values()) add(record.serverId, record.server);
    for (const id of this.store.serverIds()) add(id, this.store.serverLabel(id) ?? id);
    return summaries;
  }

  redactionOptions(): RedactionOptions {
    return {
      enabled: this.config.get('redactExports', true),
      fields: this.config.get<string[]>('redactionFields', []),
      replacement: this.config.get('redactionReplacement', '[REDACTED]')
    };
  }

  async chooseExportFormat(): Promise<ExportFormat | undefined> {
    const choice = await vscode.window.showQuickPick([
      { label: 'JSON Lines', description: 'One redacted event per line', format: 'jsonl' as const },
      { label: 'JSON', description: 'A redacted JSON array', format: 'json' as const },
      { label: 'CSV', description: 'Rows with common fields as columns', format: 'csv' as const }
    ], { title: 'Export retained logs' });
    return choice?.format;
  }

  async saveExport(content: string, format: ExportFormat, defaultName: string, fileFormat: ExportFormat | 'md' = format): Promise<boolean> {
    const filters: { [name: string]: string[] } = fileFormat === 'md' ? { Markdown: ['md'] }
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

  collectExportEvents(request: ExportRequest = {}): LogEvent[] {
    const events = this.store.all({ query: request.query, serverId: request.serverId, levels: request.levels });
    return events.map(event => redactEvent(event, this.redactionOptions()));
  }

  async exportLogs(request: ExportRequest = {}): Promise<void> {
    const format = await this.chooseExportFormat();
    if (!format) return;
    const events = this.collectExportEvents(request);
    await this.saveExport(serializeExport(events, format), format, `logline-export.${format}`);
  }

  async exportForAI(request: ExportRequest = {}): Promise<void> {
    const events = this.collectExportEvents(request);
    const limit = 2000;
    const selected = events.slice(-limit);
    const omitted = events.length - selected.length;
    const lines = selected.map(event => JSON.stringify(event)).join('\n');
    const content = [
      '# Logline incident context', '',
      `Events: ${events.length}${omitted > 0 ? ` (latest ${limit} included)` : ''}`,
      `Query: ${exportQuery(request) || '(none)'}`,
      '', '```jsonl', lines, '```', ''
    ].join('\n');
    await this.saveExport(content, 'jsonl', 'logline-ai-context.md', 'md');
  }

  async importLogs(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
      filters: { Logs: ['jsonl', 'ndjson', 'json', 'log', 'txt'] }, openLabel: 'Import logs'
    });
    if (!uris?.length) return;
    let imported = 0;
    for (const uri of uris) {
      let text: string;
      try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { continue; }
      for (const record of parseImportRecords(text)) {
        const line = typeof record === 'string' ? record : JSON.stringify(record);
        const event = parseLogLine(line, 'import', ++this.sequence, new Date());
        event.serverId = 'imported';
        event.server = 'Imported';
        event.fields = { ...event.fields, server: 'Imported', serverId: 'imported' };
        this.store.add(event);
        imported++;
      }
    }
    if (imported) {
      this.generation++;
      this.status = `Imported ${imported.toLocaleString()} events`;
      this.notifyViews();
    }
    vscode.window.showInformationMessage(`Imported ${imported.toLocaleString()} log events.`);
  }

  // Buffer disk writes so a chatty server cannot stall the extension host on
  // one syscall per line.
  persist(line: string): void {
    if (!this.config.get('persistLogs', false)) return;
    this.pendingWrites.push(line);
    if (this.pendingWrites.length >= PERSIST_MAX_BUFFER) { this.flushPersist(); return; }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushPersist(), PERSIST_FLUSH_MS);
    this.persistTimer.unref?.();
  }

  // Writes happen off the extension host's main flow of control (fs/promises)
  // so a chatty server persisting logs cannot stall the UI. The chain still
  // serializes writes so batches land in order and none are dropped.
  flushPersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.pendingWrites.length) return;
    const batch = this.pendingWrites.join('\n') + '\n';
    this.pendingWrites.length = 0;
    this.persistChain = (this.persistChain ?? Promise.resolve()).then(() => this.writeBatch(batch));
  }

  async writeBatch(batch: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return;
    const file = path.join(folder, '.logline', 'latest.log');
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const max = this.config.get('maxDiskMb', 1000) * 1024 * 1024;
      // Roll to latest.log.1 rather than discarding history outright.
      if (this.persistedBytes === undefined) {
        this.persistedBytes = (await stat(file).catch(() => undefined))?.size ?? 0;
      }
      const size = Buffer.byteLength(batch);
      if (this.persistedBytes > 0 && this.persistedBytes + size > max) {
        await rename(file, file + '.1');
        this.persistedBytes = 0;
      }
      await appendFile(file, batch, 'utf8');
      this.persistedBytes += size;
    } catch { /* persistence must not interrupt ingestion */ }
  }

  stop(): void {
    for (const session of this.sessions) this.stopSession(session);
  }

  stopServer(serverId: string): void {
    for (const session of this.sessions) {
      if (session.server.id === serverId) this.stopSession(session);
    }
  }

  stopSession(session: Session): void {
    if (!session || session.stopping) return;
    session.stopping = true;
    session.record.status = 'stopping';
    this.status = 'Stopping…';
    this.notifyViews();
    const kill = (signal: NodeJS.Signals) => {
      if (session.exited) return;
      try {
        if (!session.child.pid) return;
        if (process.platform === 'win32') {
          // Node signals are emulated on Windows and only reach the immediate
          // child, leaving any Gradle/Java descendants (and the ports they
          // hold) running. taskkill /T walks the whole process tree instead.
          execFile('taskkill', ['/PID', String(session.child.pid), '/T', '/F'], () => {});
        } else {
          process.kill(-session.child.pid, signal);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') { this.status = `Could not stop: ${(error as Error).message}`; this.notifyViews(); }
      }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => { kill('SIGKILL'); this.timers.delete(timer); }, 2000);
    timer.unref();
    this.timers.add(timer);
  }

  handleMessage(view: vscode.WebviewView, message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'snapshot') {
      const options = {
        query: typeof msg.query === 'string' ? msg.query : '',
        serverId: typeof msg.serverId === 'string' ? msg.serverId : undefined,
        levels: Array.isArray(msg.levels) ? msg.levels.filter((level): level is string => typeof level === 'string') : undefined,
        page: msg.page as number | undefined,
        before: Number.isFinite(msg.before) ? msg.before as number : Infinity
      };
      const columns = this.config.get<string[]>('columns', []);
      view.webview.postMessage({ type: 'snapshot',
        ...(msg.statsOnly ? this.store.stats() : this.store.page(options)),
        columns: columns.length ? columns : this.store.columns(),
        status: this.status, command: this.command, running: this.sessions.size > 0,
        servers: this.serverSummaries(), sessions: this.sessionSummaries(),
        newest: this.sequence, generation: this.generation,
        timezone: this.config.get('timezone', 'local')
      });
    }
    if (msg.type === 'export' || msg.type === 'exportForAI') {
      const request: ExportRequest = {
        query: typeof msg.query === 'string' ? msg.query : '',
        serverId: typeof msg.serverId === 'string' ? msg.serverId : undefined,
        levels: Array.isArray(msg.levels) ? msg.levels.filter((level): level is string => typeof level === 'string') : undefined
      };
      if (msg.type === 'export') void this.exportLogs(request);
      else void this.exportForAI(request);
    }
    if (msg.type === 'import') void this.importLogs();
    if (msg.type === 'details' || msg.type === 'copy') {
      const event = this.store.find(msg.id as number);
      let text = event?.raw ?? 'This event has been discarded from the retained history.';
      if (event?.isJson && event.raw !== undefined) {
        const indentation = vscode.workspace.getConfiguration('logline').get<number>('indentation', 2);
        text = formatDetails(event.raw, indentation);
      }
      if (event?.truncated) {
        const limit = this.config.get('maxLineLength', 65536);
        text += `\n[Truncated: line exceeded ${limit.toLocaleString()} characters]`;
      }
      if (msg.type === 'copy' && event) vscode.env.clipboard.writeText(text);
      if (msg.type === 'details') view.webview.postMessage({ type: 'details', id: msg.id, text });
    }
    if (msg.type === 'clear') { this.store.clear(); this.generation++; this.notifyViews(); }
    if (msg.type === 'stop') {
      if (msg.serverId) this.stopServer(msg.serverId as string);
      else this.stop();
    }
    if (msg.type === 'config') vscode.commands.executeCommand('workbench.action.openSettings', '@ext:surjeetbanga.logline');
    if (msg.type === 'manageServers') this.manageServers();
    if (msg.type === 'run') {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before running a server command.');
        return;
      }
      const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const target = resolveRunTarget(this.config.get<ServerConfig[]>('servers', []), msg.serverId as string, workspaceCwd);
      if (target) this.run(target.command, target.cwd, target.server, undefined, target.env);
      else vscode.commands.executeCommand('logline.runCommand');
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearTimeout(this.notifyTimer);
    this.flushPersist();
    await this.persistChain;
  }

  async manageServers(): Promise<void> {
    const config = vscode.workspace.getConfiguration('logline');
    const servers = [...config.get<ServerConfig[]>('servers', [])];
    const choice = await vscode.window.showQuickPick(['Add server', ...servers.map(server => `Edit: ${server.label}`), 'Delete server'], { title: 'Manage Logline servers' });
    if (!choice) return;
    if (choice === 'Add server') {
      const label = await vscode.window.showInputBox({ prompt: 'Server name' });
      const command = label && await vscode.window.showInputBox({ prompt: 'Command', placeHolder: 'mvn spring-boot:run' });
      if (!label || !command) return;
      servers.push({ id: nextServerId(servers, label), label, command });
    } else if (choice.startsWith('Edit: ')) {
      const index = servers.findIndex(server => `Edit: ${server.label}` === choice);
      const server = servers[index];
      const label = await vscode.window.showInputBox({ prompt: 'Server name', value: server.label });
      const command = label && await vscode.window.showInputBox({ prompt: 'Command', value: server.command });
      if (!label || !command) return;
      servers[index] = { ...server, label, command };
    } else {
      const selected = await vscode.window.showQuickPick(servers.map(server => server.label), { title: 'Delete server' });
      if (!selected) return;
      await config.update('servers', servers.filter(server => server.label !== selected), vscode.ConfigurationTarget.Workspace);
      return;
    }
    await config.update('servers', servers, vscode.ConfigurationTarget.Workspace);
  }
}

class LogPseudoTerminal implements vscode.Pseudoterminal {
  provider: LogsProvider;
  task: LoglineTaskDefinition;
  folder: vscode.WorkspaceFolder | undefined;
  writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite = this.writeEmitter.event;
  closeEmitter = new vscode.EventEmitter<number>();
  onDidClose = this.closeEmitter.event;

  constructor(provider: LogsProvider, task: LoglineTaskDefinition, folder: vscode.WorkspaceFolder | undefined) {
    this.provider = provider; this.task = task; this.folder = folder;
  }
  open(): void {
    // Args are passed straight through to spawn rather than joined into the
    // command string, so an argument containing a space or quote still works.
    const args = (this.task.args ?? []).map(value => String(value));
    const cwd = this.task.options?.cwd ? String(this.task.options.cwd).replace('${workspaceFolder}', this.folder?.uri.fsPath ?? '') : this.folder?.uri.fsPath;
    this.provider.run(String(this.task.command), cwd, { id: this.task.label ?? this.task.command, label: this.task.label ?? this.task.command },
      { write: text => this.writeEmitter.fire(text) }, this.task.options?.env, args.length ? args : undefined,
      code => this.closeEmitter.fire(code));
  }
  close(): void {}
  handleInput(): void {}
}

export function deactivate(): Promise<void> | undefined { return provider?.dispose(); }
