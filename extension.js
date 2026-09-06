const vscode = require('vscode');
const { spawn } = require('node:child_process');
const { readFileSync, appendFileSync, statSync, renameSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseLogLine } = require('./log-event');
const { LogStore, LineReader } = require('./log-store');
const { formatDetails } = require('./format-details');
const { nextServerId, resolveAutoStartServers, resolveRunTarget, resolveCwd } = require('./server-config');

const PERSIST_FLUSH_MS = 250;
const PERSIST_MAX_BUFFER = 2000;

let provider;

function activate(context) {
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
      if (vscode.workspace.workspaceFolders?.length > 1) {
        folder = await vscode.window.showWorkspaceFolderPick();
        if (!folder) return;
      }
      provider.run(command.trim(), folder?.uri.fsPath, { id: 'custom', label: command.trim() });
      await vscode.commands.executeCommand('logline.logs.focus');
    }),
    vscode.commands.registerCommand('logline.stopCommand', () => provider.stop()),
    vscode.commands.registerCommand('logline.showLogs', () =>
      vscode.commands.executeCommand('logline.logs.focus')),
    vscode.tasks.registerTaskProvider('logline', {
      provideTasks: () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return [];
        let definitions = [];
        try {
          const file = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
          definitions = JSON.parse(readFileSync(file, 'utf8')).tasks ?? [];
        } catch { return []; }
        return definitions.filter(task => task.type === 'logline' && task.command).map(task =>
          new vscode.Task(task, folder, task.label || task.command, 'logline', new vscode.CustomExecution(() =>
            new LogPseudoTerminal(provider, task, folder))));
      },
      resolveTask: task => {
        const definition = task.definition;
        if (definition?.type !== 'logline' || !definition.command) return undefined;
        const folder = vscode.workspace.workspaceFolders?.[0];
        return new vscode.Task(definition, folder, definition.label || definition.command, 'logline',
          new vscode.CustomExecution(() => new LogPseudoTerminal(provider, definition, folder)));
      }
    }),
    provider
  );
  startAutoServers();
  return { provider };
}

function startAutoServers() {
  const config = vscode.workspace.getConfiguration('logline');
  const { blocked, servers } = resolveAutoStartServers(config.get('servers', []), vscode.workspace.isTrusted);
  if (blocked) {
    vscode.window.showWarningMessage('Trust this workspace to auto-start saved servers.');
    return;
  }
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  for (const server of servers) provider.run(server.command, resolveCwd(server.cwd, workspaceCwd), server, undefined, server.env);
}

class LogsProvider {
  constructor(context) {
    this.context = context;
    this.config = vscode.workspace.getConfiguration('logline');
    this.store = new LogStore(this.config.get('maxEvents', 100000), this.config.get('maxMemoryMb', 100) * 1024 * 1024);
    this.sequence = 0;
    this.status = 'Ready — run a server command to begin';
    this.command = '';
    this.sessions = new Set();
    this.timers = new Set();
    this.generation = 0;
    this.views = new Set();
    this.pendingWrites = [];
    this.persistTimer = undefined;
    this.persistedBytes = undefined;
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

  // Apply new retention limits live; the newest events that still fit are kept.
  resizeStore() {
    const maxRows = this.config.get('maxEvents', 100000);
    const maxBytes = this.config.get('maxMemoryMb', 100) * 1024 * 1024;
    if (maxRows === this.store.maxRows && maxBytes === this.store.maxBytes) return;
    this.store.resize(maxRows, maxBytes);
    this.generation++;
  }

  resolveWebviewView(view) {
    this.views.add(view.webview);
    view.onDidDispose(() => this.views.delete(view.webview));
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.onDidReceiveMessage(message => this.handleMessage(view, message));
    const replacements = {
      '{{CSP_SOURCE}}': view.webview.cspSource,
      '{{NONCE}}': randomBytes(16).toString('hex'),
      '{{STYLE_URI}}': String(view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css'))),
      '{{SCRIPT_URI}}': String(view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')))
    };
    view.webview.html = readFileSync(vscode.Uri.joinPath(media, 'viewer.html').fsPath, 'utf8')
      .replace(/\{\{[A-Z_]+\}\}/g, key => replacements[key] ?? '');
    // Hiding or disposing the view does not stop the server or retain a UI queue.
  }

  run(command, cwd, server = { id: 'custom', label: command }, output, env) {
    // Saved servers are single-instance; ad-hoc commands all share the 'custom'
    // id and stay independent of each other.
    if (server.id !== 'custom') {
      for (const existing of this.sessions) {
        if (existing.server.id === server.id && !existing.stopping) {
          this.status = `Already running: ${server.label}`;
          return;
        }
      }
    }
    this.generation++;
    this.command = command;
    this.status = 'Running';
    const child = spawn(command, {
      cwd, shell: true, env: { ...process.env, ...(env ?? {}) }, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const session = { child, stopping: false, exited: false, server };
    this.sessions.add(session);
    const source = this.config.get('source', 'both');
    const readers = ['stdout', 'stderr'].filter(stream => source === 'both' || source === stream).map(stream => {
      const reader = new LineReader((line, truncated) => {
        if (!this.sessions.has(session)) return;
        output?.write(line + '\r\n');
        this.persist(line);
        const event = parseLogLine(line, stream, ++this.sequence, new Date());
        event.serverId = server.id;
        event.server = server.label;
        event.fields.server = server.label;
        event.fields.serverId = server.id;
        event.truncated = truncated;
        if (truncated) event.isJson = false;
        this.store.add(event);
      }, this.config.get('maxLineLength', 65536));
      child[stream].on('data', chunk => reader.write(chunk));
      return reader;
    });
    child.on('error', error => {
      if (this.sessions.has(session)) this.status = `Failed: ${error.message}`;
    });
    child.on('close', (code, signal) => {
      session.exited = true;
      for (const reader of readers) reader.end();
      if (!this.sessions.delete(session)) return;
      if (!this.status.startsWith('Failed:')) {
        this.status = session.stopping ? 'Stopped' : `Exited: ${signal ?? code ?? 'unknown'}`;
      }
      if (this.sessions.size && !this.status.startsWith('Failed:')) this.status = 'Running';
    });
  }

  // Buffer disk writes so a chatty server cannot stall the extension host on
  // one syscall per line.
  persist(line) {
    if (!this.config.get('persistLogs', false)) return;
    this.pendingWrites.push(line);
    if (this.pendingWrites.length >= PERSIST_MAX_BUFFER) { this.flushPersist(); return; }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushPersist(), PERSIST_FLUSH_MS);
    this.persistTimer.unref?.();
  }

  flushPersist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.pendingWrites.length) return;
    const batch = this.pendingWrites.join('\n') + '\n';
    this.pendingWrites.length = 0;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return;
    const file = path.join(folder, '.logline', 'latest.log');
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const max = this.config.get('maxDiskMb', 1000) * 1024 * 1024;
      // Roll to latest.log.1 rather than discarding history outright.
      if (this.persistedBytes === undefined) {
        this.persistedBytes = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      }
      const size = Buffer.byteLength(batch);
      if (this.persistedBytes > 0 && this.persistedBytes + size > max) {
        renameSync(file, file + '.1');
        this.persistedBytes = 0;
      }
      appendFileSync(file, batch, 'utf8');
      this.persistedBytes += size;
    } catch { /* persistence must not interrupt ingestion */ }
  }

  stop() {
    for (const session of this.sessions) this.stopSession(session);
  }

  stopServer(serverId) {
    for (const session of this.sessions) {
      if (session.server.id === serverId) this.stopSession(session);
    }
  }

  stopSession(session) {
    if (!session || session.stopping) return;
    session.stopping = true;
    this.status = 'Stopping…';
    const kill = signal => {
      if (session.exited) return;
      try {
        if (process.platform !== 'win32' && session.child.pid) process.kill(-session.child.pid, signal);
        else session.child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') this.status = `Could not stop: ${error.message}`;
      }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => { kill('SIGKILL'); this.timers.delete(timer); }, 2000);
    timer.unref();
    this.timers.add(timer);
  }

  handleMessage(view, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'snapshot') {
      const options = {
        query: typeof message.query === 'string' ? message.query : '',
        level: typeof message.level === 'string' ? message.level : 'trace',
        page: message.page,
        before: Number.isFinite(message.before) ? message.before : Infinity
      };
      view.webview.postMessage({ type: 'snapshot',
        ...(message.statsOnly ? this.store.stats() : this.store.page(options)),
        columns: this.config.get('columns', []).length ? this.config.get('columns', []) : this.store.columns(),
        status: this.status, command: this.command, running: this.sessions.size > 0,
        servers: this.config.get('servers', []).map(server => ({ id: server.id, label: server.label })),
        newest: this.sequence, generation: this.generation,
        timezone: this.config.get('timezone', 'local'),
        refreshIntervalMs: this.config.get('refreshIntervalMs', 250)
      });
    }
    if (message.type === 'details' || message.type === 'copy') {
      const event = this.store.find(message.id);
      let text = event?.raw ?? 'This event has been discarded from the retained history.';
      if (event?.isJson) {
        const indentation = vscode.workspace.getConfiguration('logline').get('indentation', 2);
        text = formatDetails(event.raw, indentation);
      }
      if (event?.truncated) {
        const limit = this.config.get('maxLineLength', 65536);
        text += `\n[Truncated: line exceeded ${limit.toLocaleString()} characters]`;
      }
      if (message.type === 'copy' && event) vscode.env.clipboard.writeText(text);
      if (message.type === 'details') view.webview.postMessage({ type: 'details', id: message.id, text });
    }
    if (message.type === 'clear') { this.store.clear(); this.generation++; }
    if (message.type === 'stop') {
      if (message.serverId) this.stopServer(message.serverId);
      else this.stop();
    }
    if (message.type === 'config') vscode.commands.executeCommand('workbench.action.openSettings', '@ext:surjeetbanga.logline');
    if (message.type === 'manageServers') this.manageServers();
    if (message.type === 'run') {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Trust this workspace before running a server command.');
        return;
      }
      const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const target = resolveRunTarget(this.config.get('servers', []), message.serverId, workspaceCwd);
      if (target) this.run(target.command, target.cwd, target.server, undefined, target.env);
      else vscode.commands.executeCommand('logline.runCommand');
    }
  }

  dispose() {
    this.stop();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.flushPersist();
  }

  async manageServers() {
    const config = vscode.workspace.getConfiguration('logline');
    const servers = [...config.get('servers', [])];
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

class LogPseudoTerminal {
  constructor(provider, task, folder) {
    this.provider = provider; this.task = task; this.folder = folder;
    this.writeEmitter = new vscode.EventEmitter(); this.onDidWrite = this.writeEmitter.event;
    this.closeEmitter = new vscode.EventEmitter(); this.onDidClose = this.closeEmitter.event;
  }
  open() {
    const command = [this.task.command, ...(this.task.args ?? [])].map(value => String(value)).join(' ');
    const cwd = this.task.options?.cwd ? String(this.task.options.cwd).replace('${workspaceFolder}', this.folder?.uri.fsPath ?? '') : this.folder?.uri.fsPath;
    this.provider.run(command, cwd, { id: this.task.label, label: this.task.label }, text => this.writeEmitter.fire(text), this.task.options?.env);
  }
  close() {}
  handleInput() {}
}

function deactivate() { provider?.dispose(); }
module.exports = { activate, deactivate };
