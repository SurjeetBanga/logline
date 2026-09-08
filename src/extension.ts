import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir, stat, rename, appendFile } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseLogLine } from './log-event';
import { LogStore, LineReader } from './log-store';
import { formatDetails } from './format-details';
import { extractExceptions } from './exceptions';
import { nextServerId, resolveAutoStartServers, resolveRunTarget, resolveCwd, slugify } from './server-config';
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
  /** Run the command through the user's shell. Defaults to argv mode when args are present. */
  shell?: boolean;
  /** Drop non-JSON output for this task only. */
  jsonOnly?: boolean;
  /** Stable id used to group this task's events in the Logs selector. */
  taskId?: string;
  taskType?: string;
  detail?: string;
  isBackground?: boolean;
  problemMatcher?: string | string[];
  presentation?: Record<string, unknown>;
  runOptions?: Record<string, unknown>;
  group?: string;
  dependsOn?: string | string[];
  dependsOrder?: 'sequence' | 'parallel';
}

// A saved ServerConfig satisfies this structurally; ad-hoc/task-originated
// sessions use a bare id+label instead, since they have no saved settings.
interface SessionServer {
  id: string;
  label: string;
  jsonOnly?: boolean;
  shell?: boolean;
  taskName?: string;
  taskType?: string;
  dependencies?: string[];
  dependencyState?: string;
  source?: string;
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

interface SavedSearch {
  id: string;
  name: string;
  query: string;
  levels?: string[];
  serverId?: string;
  createdAt: number;
  lastUsedAt: number;
}

interface ServerSummary {
  id: string;
  label: string;
  status: 'idle' | 'running' | 'stopping' | 'exited' | 'failed';
  activeSessions: number;
  pid?: number;
  lastSession?: string;
  taskName?: string;
  taskType?: string;
  dependencies?: string[];
  dependencyState?: string;
  exitReason?: string;
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
  const baseColumns = ['id', 'timestamp', 'timestampMs', 'level', 'message', 'stream', 'server', 'serverId', 'sessionId', 'raw'];
  // Field columns are always prefixed, even when a field's name doesn't collide
  // with a base column, so a header never ambiguously refers to either source
  // depending on which events happen to be in the export.
  const fieldKeys = [...new Set(events.flatMap(event => Object.keys(event.fields ?? {})))].sort();
  const columns = [...baseColumns, ...fieldKeys.map(key => `field:${key}`)];
  const rows = [columns.join(',')];
  for (const event of events) {
    rows.push(columns.map(column => column.startsWith('field:')
      ? csvCell(event.fields?.[column.slice('field:'.length)])
      : csvCell(event[column as keyof LogEvent])).join(','));
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

type ExecutableTask = vscode.Task & { definition: vscode.TaskDefinition & {
  dependsOn?: string | string[];
  dependsOrder?: 'sequence' | 'parallel';
  jsonOnly?: boolean;
}; };

function taskDefinitionLabel(task: vscode.Task): string {
  const definition = task.definition as Record<string, unknown>;
  return task.name || (typeof definition.label === 'string' ? definition.label : undefined)
    || (typeof definition.task === 'string' ? definition.task : undefined) || 'VS Code task';
}

function shellValue(value: string | vscode.ShellQuotedString): string {
  return typeof value === 'string' ? value : value.value;
}

function quoteShell(value: string): string {
  // A generated command line is only used for ShellExecution tasks. Double
  // quoting keeps spaces and quotes intact on the shells supported by VS Code.
  return /^[A-Za-z0-9_./:=+@%-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Convert a resolved VS Code shell/process task into a Logline task definition. */
export function taskToLoglineDefinition(task: vscode.Task): LoglineTaskDefinition | undefined {
  const execution = task.execution;
  if (!execution || !('process' in execution || 'command' in execution || 'commandLine' in execution)) return undefined;
  const definition = task.definition as ExecutableTask['definition'];
  const label = taskDefinitionLabel(task);
  const options = (execution as vscode.ProcessExecution | vscode.ShellExecution).options;
  const base = {
    type: 'logline' as const,
    label: `Logline: ${label}`,
    taskName: label,
    taskId: `task:${slugify(label)}`,
    taskType: String(definition.type),
    detail: task.detail,
    isBackground: task.isBackground || undefined,
    problemMatcher: (task.problemMatchers ?? []).length ? [...(task.problemMatchers ?? [])] : undefined,
    presentation: Object.keys(task.presentationOptions ?? {}).length ? { ...task.presentationOptions } : undefined,
    runOptions: Object.keys(task.runOptions ?? {}).length ? { ...task.runOptions } : undefined,
    group: task.group?.id,
    options: options ? { cwd: options.cwd, env: options.env } : undefined,
    jsonOnly: definition.jsonOnly === true,
    dependsOn: definition.dependsOn,
    dependsOrder: definition.dependsOrder
  };
  if ('process' in execution) {
    return { ...base, command: execution.process, args: [...execution.args], shell: false };
  }
  const shell = execution as vscode.ShellExecution;
  if (shell.commandLine !== undefined) return { ...base, command: shell.commandLine, shell: true };
  const command = shellValue(shell.command);
  const args = shell.args.map(shellValue);
  return { ...base, command: [command, ...args].map(quoteShell).join(' '), shell: true };
}

function dependencyNames(task: vscode.Task): string[] {
  const value = (task.definition as Record<string, unknown>).dependsOn;
  return dependencyNamesFromValue(value);
}

function dependencyNamesFromValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? [value] : [];
}

function makeLoglineTask(definition: LoglineTaskDefinition, folder: vscode.WorkspaceFolder): vscode.Task {
  const task = new vscode.Task(definition, folder, definition.label || definition.command, 'logline',
    new vscode.CustomExecution(resolved => Promise.resolve(new LogPseudoTerminal(provider!, resolved as LoglineTaskDefinition, folder))));
  task.detail = definition.detail;
  task.isBackground = definition.isBackground === true;
  if (definition.problemMatcher !== undefined) {
    task.problemMatchers = Array.isArray(definition.problemMatcher) ? definition.problemMatcher.map(String) : [String(definition.problemMatcher)];
  }
  if (definition.presentation && typeof definition.presentation === 'object') task.presentationOptions = definition.presentation as vscode.TaskPresentationOptions;
  if (definition.runOptions && typeof definition.runOptions === 'object') task.runOptions = definition.runOptions as vscode.RunOptions;
  if (definition.group) {
    const groups = [vscode.TaskGroup.Clean, vscode.TaskGroup.Build, vscode.TaskGroup.Rebuild, vscode.TaskGroup.Test];
    task.group = groups.find(group => group?.id === definition.group);
  }
  return task;
}

export function appendTasksToJsonc(text: string, additions: unknown[]): string | undefined {
  let open = -1;
  // Find the real property token first. A regex can accidentally match a
  // commented example such as // "tasks": [], which would edit the comment.
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '/' && next === '/') { i = text.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (char === '/' && next === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
    if (char !== '"') continue;
    const start = i++;
    let escaped = false;
    for (; i < text.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (text[i] === '\\') { escaped = true; continue; }
      if (text[i] === '"') break;
    }
    if (text.slice(start + 1, i) !== 'tasks') continue;
    let value = i + 1;
    while (/\s/.test(text[value] ?? '')) value++;
    if (text[value] !== ':') continue;
    value++;
    while (/\s/.test(text[value] ?? '')) value++;
    if (text[value] === '[') { open = value; break; }
  }
  if (open < 0) return undefined;
  let depth = 0;
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') { quote = true; continue; }
    if (char === '/' && next === '/') { lineComment = true; i++; continue; }
    if (char === '/' && next === '*') { blockComment = true; i++; continue; }
    if (char === '[') depth++;
    if (char === ']' && --depth === 0) {
      const contents = text.slice(open + 1, i);
      const trailing = /,\s*(?:(?:\/\/[^\n]*)|(?:\/\*[\s\S]*?\*\/))*\s*$/.test(contents);
      const hasValue = contents.replace(/(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s)/g, '').length > 0;
      const serialized = JSON.stringify(additions, null, 2).slice(1, -1);
      const insertion = `${hasValue && !trailing ? ',' : ''}${serialized}`;
      return text.slice(0, i) + insertion + text.slice(i);
    }
  }
  return undefined;
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
    vscode.commands.registerCommand('logline.convertTask', () => provider!.convertTask()),
    // Keep a task-oriented alias for command palettes and keybindings.
    vscode.commands.registerCommand('logline.captureTask', () => provider!.convertTask()),
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
        return definitions.filter(task => task.type === 'logline' && task.command).map(task => makeLoglineTask(task, folder));
      },
      resolveTask: task => {
        const definition = task.definition as LoglineTaskDefinition;
        if (definition?.type !== 'logline' || !definition.command) return undefined;
        const folder = vscode.workspace.workspaceFolders?.[0];
        return makeLoglineTask(definition, folder!);
      }
    }),
    // VS Code exposes task lifecycle and process events, but deliberately does
    // not expose a stream of output for ordinary tasks. These events still give
    // Logline a searchable task timeline and process exit metadata. Converted
    // logline tasks use CustomExecution and are captured line-for-line below.
    vscode.tasks.onDidStartTask(event => provider!.captureTaskStart(event.execution)),
    vscode.tasks.onDidStartTaskProcess(event => provider!.captureTaskProcessStart(event.execution, event.processId)),
    vscode.tasks.onDidEndTaskProcess(event => provider!.captureTaskProcessEnd(event.execution, event.exitCode)),
    vscode.tasks.onDidEndTask(event => provider!.captureTaskEnd(event.execution)),
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
  taskExecutions = new Map<vscode.TaskExecution, SessionSummary>();
  timers = new Set<ReturnType<typeof setTimeout>>();
  generation = 0;
  views = new Set<vscode.Webview>();
  pendingWrites: string[] = [];
  persistTimer: ReturnType<typeof setTimeout> | undefined;
  persistedBytes: number | undefined;
  persistChain: Promise<void> | undefined;
  notifyTimer: ReturnType<typeof setTimeout> | undefined;
  notifyPending = false;
  savedSearchCache?: SavedSearch[];

  private stateGet<T>(key: string, fallback: T): T {
    try { return this.context.globalState.get<T>(key, fallback); } catch { return fallback; }
  }

  private stateUpdate(key: string, value: unknown): void {
    try { void this.context.globalState.update(key, value); } catch { /* tests and restricted hosts may have no state store */ }
  }

  savedSearches(): SavedSearch[] {
    if (this.savedSearchCache) return this.savedSearchCache;
    const value = this.stateGet<unknown>('logline.savedSearches', []);
    this.savedSearchCache = Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && typeof (item as SavedSearch).id === 'string') as SavedSearch[] : [];
    return this.savedSearchCache;
  }

  saveSearch(name: string | undefined, query: string, levels?: string[], serverId?: string): SavedSearch | undefined {
    query = query.trim().slice(0, 256);
    if (!query && !serverId) return undefined;
    const now = Date.now();
    const search: SavedSearch = { id: randomBytes(8).toString('hex'), name: (name?.trim() || query || serverId || 'Search').slice(0, 80), query, levels, serverId, createdAt: now, lastUsedAt: now };
    this.savedSearchCache = [search, ...this.savedSearches().filter(item => item.query !== query || item.serverId !== serverId)].slice(0, 50);
    this.stateUpdate('logline.savedSearches', this.savedSearchCache);
    return search;
  }

  deleteSavedSearch(id: string): void { this.savedSearchCache = this.savedSearches().filter(item => item.id !== id); this.stateUpdate('logline.savedSearches', this.savedSearchCache); }

  // A dependency is 'ready' once every task sharing its name has left the
  // 'running' state (or hasn't been observed yet, in which case it can't be
  // ready either) - it does not distinguish a successful exit from a failure.
  dependencyState(deps: string[]): string {
    if (!deps.length) return 'none';
    const records = [...this.sessionRegistry.values()];
    const pending = deps.some(name => {
      const match = records.find(record => record.taskName === name);
      return !match || match.taskState === 'running';
    });
    return pending ? 'pending' : 'ready';
  }

  // Called whenever a tracked task leaves the 'running' state, so sibling
  // tasks that depend on it stop showing a stale 'pending'/'ready' status.
  refreshDependents(taskName: string | undefined): void {
    if (!taskName) return;
    for (const record of this.sessionRegistry.values()) {
      if (record.taskState === 'running' && record.dependencies?.includes(taskName)) {
        record.dependencyState = this.dependencyState(record.dependencies);
      }
    }
  }

  private taskSummary(execution: vscode.TaskExecution): SessionSummary {
    this.taskExecutions ??= new Map();
    this.sessionRegistry ??= new Map();
    this.sequence ??= 0;
    this.generation ??= 0;
    const existing = this.taskExecutions.get(execution);
    if (existing) return existing;
    const task = execution.task;
    const taskName = taskDefinitionLabel(task);
    const definition = task.definition as Record<string, unknown>;
    const deps = dependencyNames(task);
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'),
      serverId: `task:${slugify(taskName)}`,
      server: taskName,
      status: 'running',
      startedAt: Date.now(),
      events: 0,
      taskName,
      taskType: String(definition.type),
      taskState: 'running',
      dependencies: deps,
      dependencyState: this.dependencyState(deps),
      source: task.source
    };
    this.taskExecutions.set(execution, record);
    this.sessionRegistry.set(record.id, record);
    // Keep the command useful in the header when the task is the most recent
    // thing the user started.
    this.command = taskName;
    return record;
  }

  private taskLifecycleEvent(record: SessionSummary, message: string, level: string, extra: Record<string, unknown> = {}): void {
    const event = parseLogLine(JSON.stringify({ level, message, taskName: record.taskName, taskType: record.taskType,
      dependencies: record.dependencies, taskState: record.taskState, dependencyState: record.dependencyState,
      exitReason: record.exitReason, ...extra }), 'task', ++this.sequence, new Date());
    event.serverId = record.serverId;
    event.server = record.server;
    event.sessionId = record.id;
    event.taskName = record.taskName;
    event.taskType = record.taskType;
    event.dependencies = record.dependencies;
    event.taskState = record.taskState;
    event.dependencyState = record.dependencyState;
    event.exitReason = record.exitReason;
    const extraFields = Object.fromEntries(Object.entries(extra).filter(([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'));
    event.fields = { ...(event.fields ?? {}), ...extraFields, taskName: record.taskName ?? '', taskType: record.taskType ?? '',
      dependencies: record.dependencies?.join(', ') ?? '', taskState: record.taskState ?? '', dependencyState: record.dependencyState ?? '',
      ...(record.exitReason ? { exitReason: record.exitReason } : {}) };
    record.events++;
    this.persist(event.raw ?? message);
    this.store.add(event);
    this.generation++;
    this.notifyViews();
  }

  captureTaskStart(execution: vscode.TaskExecution): void {
    // A Logline CustomExecution is already represented by the real process
    // session created in run(); recording it again would duplicate the task.
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.taskState = 'running';
    this.status = `Running task: ${record.taskName}`;
    this.taskLifecycleEvent(record, `Task started: ${record.taskName}`, 'info');
  }

  captureTaskProcessStart(execution: vscode.TaskExecution, processId: number): void {
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.pid = processId;
    record.taskState = 'running';
    this.taskLifecycleEvent(record, `Task process started: ${record.taskName}`, 'debug', { processId });
  }

  captureTaskProcessEnd(execution: vscode.TaskExecution, exitCode: number | undefined): void {
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.exitCode = exitCode;
    record.exitReason = exitCode === undefined ? 'terminated' : `exit code ${exitCode}`;
    record.taskState = exitCode === undefined || exitCode !== 0 ? 'failed' : 'exited';
    if (record.taskState === 'failed') record.status = 'failed';
    this.refreshDependents(record.taskName);
    this.taskLifecycleEvent(record, `Task process ended: ${record.taskName} (${record.exitReason})`, record.status === 'failed' ? 'error' : 'info', { exitCode });
    this.pruneSessionRegistry();
  }

  captureTaskEnd(execution: vscode.TaskExecution): void {
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.endedAt = Date.now();
    if (record.status !== 'failed') record.status = record.exitCode === undefined || record.exitCode === 0 ? 'exited' : 'failed';
    record.taskState = record.status;
    record.exitReason ??= record.status === 'exited' ? 'completed' : 'failed';
    this.refreshDependents(record.taskName);
    this.taskLifecycleEvent(record, `Task ended: ${record.taskName} (${record.exitReason})`, record.status === 'failed' ? 'error' : 'info');
    this.taskExecutions.delete(execution);
    if (!this.taskExecutions.size && !(this.sessions?.size ?? 0)) {
      this.status = `Task ${record.status}: ${record.taskName} (${record.exitReason})`;
      this.notifyViews();
    }
    this.pruneSessionRegistry();
  }

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
    if (!this.views) this.views = new Set();
    if (this.notifyTimer) { this.notifyPending = true; return; }
    for (const webview of this.views) webview.postMessage({ type: 'update' });
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.notifyPending) { this.notifyPending = false; this.notifyViews(); }
    }, this.config?.get('refreshIntervalMs', 500) ?? 500);
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
  // syntax (&&, pipes, quoting) directly into them. A task can explicitly set
  // shell:false when it has a single process command with no args.
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
  ): string | undefined {
    // Saved servers are single-instance; ad-hoc commands all share the 'custom'
    // id and stay independent of each other.
    if (server.id !== 'custom') {
      for (const existing of this.sessions) {
        if (existing.server.id === server.id && !existing.stopping) {
          this.status = `Already running: ${server.label}`;
          this.notifyViews();
          onExit?.(1);
          return undefined;
        }
      }
    }
    this.generation++;
    this.command = args ? [command, ...args].join(' ') : command;
    this.status = 'Running';
    this.notifyViews();
    const spawnOptions: SpawnOptions = {
      cwd, shell: server.shell ?? !args, env: { ...process.env, ...(env ?? {}) }, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    };
    const child = (args !== undefined ? spawn(command, args, spawnOptions) : spawn(command, spawnOptions)) as ChildProcessWithoutNullStreams;
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'), serverId: server.id, server: server.label,
      status: 'running', startedAt: Date.now(), pid: child.pid, events: 0,
      taskName: server.taskName, taskType: server.taskType, taskState: server.taskName ? 'running' : undefined,
      dependencies: server.dependencies, dependencyState: server.dependencyState, source: server.source
    };
    const session: Session = { child, stopping: false, exited: false, server, record };
    this.sessionRegistry.set(record.id, record);
    this.sessions.add(session);
    const source = this.config.get<string>('source', 'both');
    const readers = (['stdout', 'stderr'] as const).filter(stream => source === 'both' || source === stream).map(stream => {
      const reader = new LineReader((line, truncated) => {
        if (!this.sessions.has(session)) return;
        output?.write(line + '\r\n');
        const event: LogEvent = parseLogLine(line, stream, ++this.sequence, new Date());
        // Some saved servers (e.g. a Gradle bootRun task) interleave build-tool
        // noise with the application's structured JSON on the same stream.
        if (server.jsonOnly && !event.isJson) return;
        this.persist(line);
        event.serverId = server.id;
        event.server = server.label;
        event.sessionId = record.id;
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
      if (record.taskName) {
        record.taskState = 'failed';
        record.exitReason = `error: ${error.message}`;
        this.refreshDependents(record.taskName);
      }
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
      if (record.taskName) {
        record.taskState = record.status;
        record.exitReason = signal ? `signal ${signal}` : `exit code ${typeof code === 'number' ? code : 'unknown'}`;
        this.refreshDependents(record.taskName);
      }
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
    return record.id;
  }

  // Stops the one session started by a specific run() call, unlike
  // stopServer() which stops every session currently sharing a serverId -
  // safe to call even after that serverId has been reused by a later run.
  stopSessionById(id: string): void {
    for (const session of this.sessions) {
      if (session.record.id === id) { this.stopSession(session); return; }
    }
  }

  pruneSessionRegistry(): void {
    const completed = [...this.sessionRegistry.values()]
      .filter(record => record.status === 'exited' || record.status === 'failed')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (this.sessionRegistry.size > 100 && completed.length) {
      this.sessionRegistry.delete(completed.shift()!.id);
    }
  }

  // The webview only needs status and compact task metadata to show active
  // counts and explain the selected task, so avoid cloning full records.
  sessionSummaries(): Pick<SessionSummary, 'id' | 'server' | 'serverId' | 'status' | 'startedAt' | 'endedAt' | 'taskName' | 'taskType' | 'dependencies' | 'dependencyState' | 'exitReason'>[] {
    return [...this.sessionRegistry.values()].map(record => ({ id: record.id, server: record.server, serverId: record.serverId,
      startedAt: record.startedAt, endedAt: record.endedAt, status: record.status,
      taskName: record.taskName, taskType: record.taskType, dependencies: record.dependencies,
      dependencyState: record.dependencyState, exitReason: record.exitReason }));
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
      const active = records.filter(record => record.status === 'running' || record.status === 'stopping');
      const last = records.reduce((latest, record) =>
        !latest || (record.endedAt ?? record.startedAt) > (latest.endedAt ?? latest.startedAt) ? record : latest,
        undefined as SessionSummary | undefined);
      const status = active.some(record => record.status === 'stopping') ? 'stopping'
        : active.length ? 'running' : last?.status ?? 'idle';
      const detail = active.at(-1) ?? last;
      summaries.push({ id, label, status, activeSessions: active.length,
        pid: active.find(record => record.pid !== undefined)?.pid, lastSession: last?.id,
        taskName: detail?.taskName, taskType: detail?.taskType, dependencies: detail?.dependencies,
        dependencyState: detail?.dependencyState, exitReason: detail?.exitReason });
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

  async chooseExportFormat(): Promise<ExportFormat | 'md' | undefined> {
    const choice = await vscode.window.showQuickPick([
      { label: 'JSON Lines', description: 'One redacted event per line', format: 'jsonl' as const },
      { label: 'JSON', description: 'A redacted JSON array', format: 'json' as const },
      { label: 'CSV', description: 'Rows with common fields as columns', format: 'csv' as const },
      { label: 'AI context (Markdown)', description: 'Up to 2,000 filtered events for AI tools', format: 'md' as const }
    ], { title: 'Export retained logs' });
    return choice?.format;
  }

  async saveExport(content: string, fileFormat: ExportFormat | 'md', defaultName: string): Promise<boolean> {
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
    const limit = 2000;
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
      filters: { Logs: ['jsonl', 'ndjson', 'json', 'log', 'txt'] }, openLabel: 'Import logs'
    });
    if (!uris?.length) return;
    let imported = 0;
    for (const uri of uris) {
      let text: string;
      try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { continue; }
      // Keep surrounding context from crossing between independently imported files.
      const sessionId = randomBytes(8).toString('hex');
      for (const record of parseImportRecords(text)) {
        const line = typeof record === 'string' ? record : JSON.stringify(record);
        const event = parseLogLine(line, 'import', ++this.sequence, new Date());
        event.serverId = 'imported';
        event.server = 'Imported';
        event.sessionId = sessionId;
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
    if (!this.config?.get('persistLogs', false)) return;
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
    for (const execution of this.taskExecutions?.keys() ?? []) {
      try { execution.terminate(); } catch { /* task may have ended between the snapshot and terminate */ }
    }
  }

  stopServer(serverId: string): void {
    for (const session of this.sessions) {
      if (session.server.id === serverId) this.stopSession(session);
    }
    for (const [execution, record] of this.taskExecutions?.entries() ?? []) {
      if (record.serverId !== serverId) continue;
      try { execution.terminate(); } catch { /* task may have ended already */ }
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
    if (msg.type === 'context' && Number.isSafeInteger(msg.id)) {
      view.webview.postMessage({ type: 'context', id: msg.id, ...this.store.context(msg.id as number) });
    }
    if (msg.type === 'openSource') void this.openSource(msg);
    if (msg.type === 'snapshot') {
      const options = {
        query: typeof msg.query === 'string' ? msg.query : '',
        serverId: typeof msg.serverId === 'string' ? msg.serverId : undefined,
        levels: Array.isArray(msg.levels) ? msg.levels.filter((level): level is string => typeof level === 'string') : undefined,
        page: msg.page as number | undefined,
        before: Number.isFinite(msg.before) ? msg.before as number : Infinity,
        sort: typeof msg.sort === 'string' && msg.sort ? msg.sort : undefined,
        sortDirection: msg.sortDirection === 'desc' ? 'desc' as const : 'asc' as const
      };
      const columns = this.config.get<string[]>('columns', []);
      const pageResult = msg.statsOnly ? undefined : this.store.page(options);
      const result = pageResult ?? this.store.stats();
      const events = pageResult?.events;
      view.webview.postMessage({ type: 'snapshot',
        ...result, ...(events ? { events } : {}),
        columns: columns.length ? columns : this.store.columns(),
        fields: this.store.fieldNames(),
        status: this.status, command: this.command, running: this.sessions.size > 0 || (this.taskExecutions?.size ?? 0) > 0,
        servers: this.serverSummaries(), sessions: this.sessionSummaries(),
        searches: { saved: this.savedSearches() },
        newest: this.sequence, generation: this.generation,
        timezone: this.config.get('timezone', 'local')
      });
    }
    if (msg.type === 'saveSearch') {
      const search = this.saveSearch(typeof msg.name === 'string' ? msg.name : undefined, typeof msg.query === 'string' ? msg.query : '',
        Array.isArray(msg.levels) ? msg.levels.filter((level): level is string => typeof level === 'string') : undefined,
        typeof msg.serverId === 'string' ? msg.serverId : undefined);
      view.webview.postMessage({ type: 'searches', searches: { saved: this.savedSearches() }, saved: search });
    }
    if (msg.type === 'deleteSavedSearch' && typeof msg.id === 'string') {
      this.deleteSavedSearch(msg.id);
      view.webview.postMessage({ type: 'searches', searches: { saved: this.savedSearches() } });
    }
    if (msg.type === 'autocomplete') {
      const result = this.store.fieldSuggestions(typeof msg.input === 'string' ? msg.input : '', typeof msg.serverId === 'string' ? msg.serverId : undefined);
      view.webview.postMessage({ type: 'autocomplete', ...result });
    }
    if (msg.type === 'facets') {
      const field = typeof msg.field === 'string' ? msg.field : '';
      const values = this.store.facets(field, { query: typeof msg.query === 'string' ? msg.query : '', serverId: typeof msg.serverId === 'string' ? msg.serverId : undefined });
      view.webview.postMessage({ type: 'facets', field, values });
    }
    if (msg.type === 'analysis') {
      const options = { query: typeof msg.query === 'string' ? msg.query : '', serverId: typeof msg.serverId === 'string' ? msg.serverId : undefined,
        levels: Array.isArray(msg.levels) ? msg.levels.filter((level): level is string => typeof level === 'string') : undefined,
        sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
        from: Number.isFinite(msg.from) ? msg.from as number : undefined, to: Number.isFinite(msg.to) ? msg.to as number : undefined };
      view.webview.postMessage({ type: 'analysis', analysis: this.store.analysis(options) });
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
    if (msg.type === 'exportContext' && Array.isArray(msg.ids)) {
      const ids = msg.ids.filter((id): id is number => Number.isSafeInteger(id));
      void this.exportContext(ids);
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
      if (msg.type === 'details') view.webview.postMessage({ type: 'details', id: msg.id, text,
        target: msg.target === 'context' ? 'context' : 'main', exceptions: event ? extractExceptions(event) : [] });
    }
    if (msg.type === 'clear') {
      this.store.clear();
      // Clear also removes completed/failed session entries from the selector;
      // configured servers remain available as idle entries.
      this.sessionRegistry = new Map([...this.sessionRegistry].filter(([, record]) => record.status === 'running' || record.status === 'stopping'));
      this.generation++;
      this.notifyViews();
    }
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

  async openSource(msg: Record<string, unknown>): Promise<void> {
    if (!Number.isSafeInteger(msg.id) || !Number.isSafeInteger(msg.block) || !Number.isSafeInteger(msg.line)) return;
    const event = this.store.find(msg.id as number);
    if (!event) { vscode.window.showInformationMessage('This event has been discarded from retained history.'); return; }
    const source = extractExceptions(event)[msg.block as number]?.lines[msg.line as number]?.source;
    if (!source) return;
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const normalized = source.file.replace(/\\/g, '/').replace(/^\.\//, '');
      const candidates: vscode.Uri[] = [];
      // A logged path can only open source inside the current workspace.
      for (const folder of folders) {
        const candidate = path.resolve(folder.uri.fsPath, source.file);
        const relative = path.relative(folder.uri.fsPath, candidate);
        if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) continue;
        const uri = vscode.Uri.file(candidate);
        try { if ((await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File) candidates.push(uri); } catch { /* try source lookup */ }
      }
      if (!candidates.length) {
        const filename = normalized.split('/').at(-1)!;
        const escaped = filename.replace(/[\[\]{}*?]/g, char => `[${char}]`);
        const matches = await vscode.workspace.findFiles(`**/${escaped}`, '**/{node_modules,.git,out,dist,build}/**', 100);
        const suffix = matches.filter(uri => uri.path.endsWith('/' + normalized));
        candidates.push(...(suffix.length ? suffix : matches));
      }
      if (!candidates.length) {
        vscode.window.showInformationMessage(`Source file not found in this workspace: ${source.file}`);
        return;
      }
      const unique = [...new Map(candidates.map(uri => [uri.toString(), uri])).values()];
      const uri = unique.length === 1 ? unique[0] : (await vscode.window.showQuickPick(
        unique.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), { title: 'Choose stack frame source' }))?.uri;
      if (!uri) return;
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.min(source.line - 1, document.lineCount - 1);
      const column = Math.min(source.column - 1, document.lineAt(line).text.length);
      const position = new vscode.Position(line, column);
      await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
    } catch (error) {
      vscode.window.showInformationMessage(`Could not open stack frame: ${(error as Error).message}`);
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

  /**
   * Persist a Logline CustomExecution copy of an existing task. VS Code will
   * resolve ${env:...}, ${config:...}, ${input:...}, and other task variables
   * before the custom terminal is opened, so the copied task keeps the same
   * variable behavior as the original.
   */
  async convertTask(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('Trust this workspace before converting a task.');
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { vscode.window.showInformationMessage('Open a workspace before converting a task.'); return; }
    interface ParsedTasksFile { file: string; document: { version?: string; tasks?: unknown[] }; sourceText?: string; }
    // Keyed by folder URI rather than the WorkspaceFolder object itself, since
    // a Task's `.scope` folder instance isn't guaranteed to be reference-equal
    // to the entries in vscode.workspace.workspaceFolders.
    const parsedByFolder = new Map<string, ParsedTasksFile>();
    // Merge dependsOn refs from every folder's tasks.json, since a picked
    // task's dependency can be declared in a different folder than its own.
    const rawDependencyByRef = new Map<string, string[]>();
    for (const workspaceFolder of folders) {
      const file = path.join(workspaceFolder.uri.fsPath, '.vscode', 'tasks.json');
      let document: { version?: string; tasks?: unknown[] } = { version: '2.0.0', tasks: [] };
      let sourceText: string | undefined;
      try {
        sourceText = readFileSync(file, 'utf8');
        document = parseJsonc(sourceText) as { version?: string; tasks?: unknown[] };
        if (!document || typeof document !== 'object') document = { version: '2.0.0', tasks: [] };
        if (!Array.isArray(document.tasks)) document.tasks = [];
      } catch { /* create tasks.json when this folder has no task file yet */ }
      parsedByFolder.set(workspaceFolder.uri.toString(), { file, document, sourceText });
      for (const raw of document.tasks ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        const value = raw as Record<string, unknown>;
        const deps = dependencyNamesFromValue(value.dependsOn);
        if (!deps.length) continue;
        for (const key of ['label', 'task', 'script']) if (typeof value[key] === 'string') rawDependencyByRef.set(value[key] as string, deps);
      }
    }
    let tasks: vscode.Task[];
    try { tasks = await vscode.tasks.fetchTasks(); }
    catch (error) {
      vscode.window.showErrorMessage(`Could not read VS Code tasks: ${(error as Error).message}`);
      return;
    }
    const candidates = tasks.filter(task => task.definition?.type !== 'logline' && taskToLoglineDefinition(task));
    if (!candidates.length) { vscode.window.showInformationMessage('No shell, process, node-terminal, or launch pre-task was found.'); return; }
    const picked = await vscode.window.showQuickPick(candidates.map(task => ({
      label: taskDefinitionLabel(task), description: `${task.source} · ${task.definition.type}`, task
    })), { title: 'Convert VS Code task to Logline' });
    if (!picked) return;
    const scopeFolder = typeof picked.task.scope === 'object' ? picked.task.scope : undefined;
    const targetFolder = (scopeFolder && folders.find(f => f.uri.toString() === scopeFolder.uri.toString())) ?? folders[0];
    const { file, document, sourceText } = parsedByFolder.get(targetFolder.uri.toString())!;
    const byName = new Map<string, vscode.Task>();
    const ambiguousNames = new Set<string>();
    // A name shared by two different tasks can't be resolved unambiguously,
    // so drop it entirely rather than let whichever task registered last win.
    const registerName = (key: string, task: vscode.Task) => {
      const existing = byName.get(key);
      if (existing && existing !== task) { ambiguousNames.add(key); return; }
      byName.set(key, task);
    };
    for (const task of tasks) {
      registerName(task.name, task);
      const definition = task.definition as Record<string, unknown>;
      for (const key of ['label', 'task', 'script']) if (typeof definition[key] === 'string') registerName(definition[key] as string, task);
    }
    for (const key of ambiguousNames) byName.delete(key);
    const generated: LoglineTaskDefinition[] = [];
    const generatedByLabel = new Map<string, LoglineTaskDefinition>();
    const convert = (task: vscode.Task): LoglineTaskDefinition | undefined => {
      const label = `Logline: ${taskDefinitionLabel(task)}`;
      const existing = generatedByLabel.get(label);
      if (existing) return existing;
      const definition = taskToLoglineDefinition(task);
      if (!definition) return undefined;
      // Mark before traversing dependencies so a malformed dependency cycle is
      // emitted once and cannot recurse forever.
      generatedByLabel.set(label, definition);
      generated.push(definition);
      const dependencies = dependencyNames(task).length ? dependencyNames(task) : (rawDependencyByRef.get(task.name) ?? []);
      if (dependencies.length) {
        definition.dependsOn = dependencies.map(name => {
          const dependency = byName.get(name);
          const converted = dependency ? convert(dependency) : undefined;
          return converted?.label ?? name;
        });
        if (definition.dependsOn.length === 1) definition.dependsOn = definition.dependsOn[0];
      }
      return definition;
    };
    convert(picked.task);
    const existingLabels = new Set(document.tasks!.map(task => {
      const value = task as Record<string, unknown>;
      return typeof value.label === 'string' ? value.label : undefined;
    }).filter((value): value is string => Boolean(value)));
    const additions = generated.filter(task => !existingLabels.has(task.label!));
    if (!additions.length) {
      vscode.window.showInformationMessage(`Logline task already exists for ${taskDefinitionLabel(picked.task)}.`);
      return;
    }
    document.version ??= '2.0.0';
    document.tasks!.push(...additions);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const preserved = sourceText && appendTasksToJsonc(sourceText, additions);
      writeFileSync(file, preserved ?? (JSON.stringify(document, null, 2) + '\n'), 'utf8');
    } catch (error) {
      vscode.window.showErrorMessage(`Could not write ${path.relative(targetFolder.uri.fsPath, file)}: ${(error as Error).message}`);
      return;
    }
    vscode.window.showInformationMessage(`Converted ${taskDefinitionLabel(picked.task)} to ${additions.length} Logline task${additions.length === 1 ? '' : 's'}.`);
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
  sessionId: string | undefined;
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
    const cwd = this.task.options?.cwd ? String(this.task.options.cwd)
      .replace(/\$\{workspaceFolder\}/g, this.folder?.uri.fsPath ?? '')
      .replace(/\$\{workspaceFolderBasename\}/g, path.basename(this.folder?.uri.fsPath ?? '')) : this.folder?.uri.fsPath;
    const label = this.task.taskName ?? this.task.label ?? this.task.command;
    const dependencies = this.task.dependsOn
      ? (Array.isArray(this.task.dependsOn) ? this.task.dependsOn : [this.task.dependsOn]) : [];
    const dependencyState = this.provider.dependencyState(dependencies);
    const server: SessionServer = { id: this.task.taskId ?? `task:${slugify(label)}`, label,
      jsonOnly: this.task.jsonOnly, shell: this.task.shell, taskName: label, taskType: this.task.taskType ?? 'logline',
      dependencies, dependencyState, source: 'logline' };
    this.sessionId = this.provider.run(String(this.task.command), cwd, server,
      { write: text => this.writeEmitter.fire(text) }, this.task.options?.env, args.length ? args : undefined,
      code => this.closeEmitter.fire(code));
  }
  close(): void {
    // Target the specific session this open() started, not every session
    // sharing this task's serverId - a later re-run of the same task must
    // not be torn down by a stale close() from this earlier run.
    if (this.sessionId) this.provider.stopSessionById(this.sessionId);
  }
  handleInput(): void {}
}

export function deactivate(): Promise<void> | undefined { return provider?.dispose(); }
