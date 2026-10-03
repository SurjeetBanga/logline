import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Settings } from '../core/settings';
import type { SessionSummary } from '../core/types';
import type { Ingestion } from './ingestion';
import { LineReader } from './line-reader';
import { StackJoiner } from './stack-joiner';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';
import type { Session } from './types';

export class ProcessRunner {
  readonly sessions = new Set<Session>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly config: Settings, private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion, private readonly state: RuntimeState) { }
  stop(): void { for (const session of this.sessions) this.stopSession(session); }
  stopServer(id: string): void { for (const session of this.sessions) if (session.server.id === id) this.stopSession(session); }
  async dispose(): Promise<void> {
    const sessions = [...this.sessions];
    const closed = sessions.map(session => new Promise<void>(resolve => session.child.once('close', () => resolve())));
    this.stop();
    // Keep the escalation timers alive until every child has actually closed.
    await Promise.all(closed);
    // A process can close while a descendant keeps the detached process group
    // alive. Force the original group down before clearing escalation timers.
    // Windows has no process groups: taskkill /T /F already took the whole
    // tree down, and repeating it against an exited PID can hit a reused one.
    if (process.platform !== 'win32') {
      await Promise.all(sessions.map(session => this.killProcessTree(session.child.pid, 'SIGKILL').catch(() => undefined)));
    }
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  run(
    command: string,
    cwd: string | undefined,
    server: Session['server'] = { id: 'custom', label: command },
    output?: { write: (text: string) => void; },
    env?: Record<string, string>,
    args?: string[],
    onExit?: (code: number) => void
  ): string | undefined {
    // Saved servers are single-instance; ad-hoc commands all share the 'custom'
    // id and stay independent of each other.
    if (server.id !== 'custom') {
      for (const existing of this.sessions) {
        if (existing.server.id === server.id && !existing.stopping) {
          this.state.status = `Already running: ${server.label}`;
          this.state.notify();
          onExit?.(1);
          return undefined;
        }
      }
    }
    this.state.command = args ? [command, ...args].join(' ') : command;
    this.state.status = 'Running';
    this.state.notify();
    const spawnOptions: SpawnOptions = {
      cwd, shell: server.shell ?? !args, env: { ...process.env, ...(env ?? {}) }, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    };
    const child = (args !== undefined ? spawn(command, args, spawnOptions) : spawn(command, spawnOptions)) as ChildProcessWithoutNullStreams;
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'), serverId: server.id, server: server.label,
      status: 'running', startedAt: Date.now(), pid: child.pid, events: 0,
      taskName: server.taskName, taskType: server.taskType, taskState: server.taskName ? 'running' : undefined,
      taskScope: server.taskScope, taskLabel: server.taskLabel,
      dependencies: server.dependencies, dependencyState: server.dependencyState, source: server.source,
      sourceKind: server.sourceKind ?? (server.taskName ? 'task' : 'process'), owned: true, canStop: true,
      captureComplete: false, command: args ? [command, ...args].join(' ') : command, cwd
    };
    const session: Session = { child, stopping: false, exited: false, server, record };
    this.registry.records.set(record.id, record);
    this.registry.refreshDependents(record.taskName, record.taskScope, record.taskLabel);
    this.sessions.add(session);
    const source = this.config.get<string>('source', 'both');
    // Both pipes must flow even when only one stream is retained. Otherwise a
    // full OS pipe can block the server itself while writing excluded output.
    for (const stream of ['stdout', 'stderr'] as const) {
      if (source !== 'both' && source !== stream) child[stream].resume();
    }
    const limit = this.config.get('maxLineLength', 65536);
    const joiners: StackJoiner[] = [];
    const readers = (['stdout', 'stderr'] as const).filter(stream => source === 'both' || source === stream).map(stream => {
      const ingest = (line: string, truncated: boolean) => {
        if (!this.sessions.has(session)) return;
        const event = this.ingestion.accept(line, stream, {
          serverId: server.id, server: server.label,
          sessionId: record.id, truncated, jsonOnly: server.jsonOnly, persist: true
        });
        if (!event) return;
        record.events++;
        this.state.notify();
      };
      // Each stream is joined separately: a trace never interleaves stdout and stderr.
      const joiner = this.config.get('joinStackTraces', true) ? new StackJoiner(ingest, limit) : undefined;
      if (joiner) joiners.push(joiner);
      const reader = new LineReader((line, truncated) => {
        if (!this.sessions.has(session)) return;
        output?.write(line + '\r\n');
        if (joiner) joiner.write(line, truncated); else ingest(line, truncated);
      }, limit);
      child[stream].on('data', chunk => reader.write(chunk));
      return reader;
    });
    child.on('error', error => {
      record.status = 'failed';
      record.error = error.message;
      if (record.taskName) {
        record.taskState = 'failed';
        record.exitReason = `error: ${error.message}`;
        this.registry.refreshDependents(record.taskName, record.taskScope, record.taskLabel);
      }
      if (this.sessions.has(session)) this.state.status = `Failed: ${error.message}`;
      this.state.notify();
    });
    child.on('close', (code, signal) => {
      session.exited = true;
      for (const reader of readers) reader.end();
      for (const joiner of joiners) joiner.end();
      record.captureComplete = true;
      record.endedAt = Date.now();
      record.exitCode = typeof code === 'number' ? code : undefined;
      record.signal = signal ?? undefined;
      if (record.status !== 'failed') record.status = session.stopping ? 'exited' : (code === 0 ? 'exited' : 'failed');
      if (record.taskName) {
        record.taskState = record.status;
        record.exitReason = signal ? `signal ${signal}` : `exit code ${typeof code === 'number' ? code : 'unknown'}`;
        this.registry.refreshDependents(record.taskName, record.taskScope, record.taskLabel);
      }
      if (this.sessions.delete(session)) {
        if (!this.state.status.startsWith('Failed:')) {
          this.state.status = session.stopping ? 'Stopped' : `Exited: ${signal ?? code ?? 'unknown'}`;
        }
        if (this.sessions.size && !this.state.status.startsWith('Failed:')) this.state.status = 'Running';
        this.state.notify();
      }
      this.registry.pruneSessionRegistry();
      onExit?.(typeof code === 'number' ? code : (signal ? 1 : 0));
    });
    return record.id;
  }

  stopSessionById(id: string): void {
    for (const session of this.sessions) {
      if (session.record.id === id) { this.stopSession(session); return; }
    }
  }

  stopSession(session: Session): void {
    if (!session || session.stopping) return;
    session.stopping = true;
    session.record.status = 'stopping';
    this.state.status = 'Stopping…';
    this.state.notify();
    const kill = (signal: NodeJS.Signals, force = false) => {
      // After exit, only a POSIX process group can still hold descendants; a
      // Windows PID may already belong to an unrelated process.
      if (session.exited && (!force || process.platform === 'win32')) return;
      void this.killProcessTree(session.child.pid, signal).catch(error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') { this.state.status = `Could not stop: ${(error as Error).message}`; this.state.notify(); }
      });
    };
    kill('SIGTERM');
    const timer = setTimeout(() => { kill('SIGKILL', true); this.timers.delete(timer); }, 2000);
    timer.unref();
    this.timers.add(timer);
  }

  private killProcessTree(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
    if (!pid) return Promise.resolve();
    if (process.platform === 'win32') {
      // Node signals are emulated on Windows and only reach the immediate
      // child, leaving descendants (and their ports) running. taskkill /T
      // walks the whole process tree instead.
      return new Promise(resolve => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.state.status = `Could not stop process tree: ${error.message}`;
          this.state.notify();
        }
        resolve();
      }));
    } else {
      try { process.kill(-pid, signal); }
      catch (error) {
        // The group may have exited between the child close event and the
        // escalation/disposal pass. That is a successful termination state.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(error);
      }
      return Promise.resolve();
    }
  }
}
