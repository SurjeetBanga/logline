import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Settings } from '../core/settings';
import type { SessionSummary } from '../core/types';
import type { Ingestion } from '../capture/ingestion';
import { TerminalNormalizer } from '../capture/terminal-normalizer';
import type { RuntimeState } from '../capture/runtime-state';
import type { SessionRegistry } from '../capture/session-registry';

type TerminalLike = Pick<vscode.Terminal, 'name'> & {
  shellIntegration?: vscode.TerminalShellIntegration;
  exitStatus?: { code: number | undefined };
};
type ExecutionLike = Pick<vscode.TerminalShellExecution, 'commandLine' | 'cwd' | 'read'>;
type CaptureContext = {
  record: SessionSummary;
  terminalId: string;
  accepting: boolean;
  streamDone: boolean;
  streamFailed: boolean;
  endSeen: boolean;
};

/** Captures externally owned terminal commands without ever stopping them. */
export class TerminalCapture {
  private enabled = false;
  private disposed = false;
  private readonly ignored = new Set<object>();
  private readonly terminalIds = new WeakMap<object, string>();
  private readonly executions = new WeakMap<object, CaptureContext>();
  private readonly active = new Set<CaptureContext>();
  private readonly terminals = new Map<string, { terminal: object; label: string }>();
  private readonly ignoredSourceIds = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private nextTerminal = 1;

  constructor(private readonly config: Settings, private readonly ingestion: Ingestion,
    private readonly registry: SessionRegistry, private readonly state: RuntimeState) {
    this.enabled = config.get('captureTerminals', false);
    this.state.status = this.enabled ? 'Ready for the next supported terminal command' : 'Terminal capture is off';
    const windowApi = vscode.window as unknown as Record<string, unknown>;
    for (const terminal of (vscode.window.terminals ?? [])) this.rememberTerminal(terminal as TerminalLike);
    const open = windowApi.onDidOpenTerminal as ((listener: (terminal: unknown) => void) => vscode.Disposable) | undefined;
    if (open) this.disposables.push(open(terminal => this.rememberTerminal(terminal as TerminalLike)));
    const start = windowApi.onDidStartTerminalShellExecution as ((listener: (event: unknown) => void) => vscode.Disposable) | undefined;
    if (start) this.disposables.push(start(event => this.onStart(event as { terminal: TerminalLike; execution: ExecutionLike; shellIntegration?: unknown })));
    const end = windowApi.onDidEndTerminalShellExecution as ((listener: (event: unknown) => void) => vscode.Disposable) | undefined;
    if (end) this.disposables.push(end(event => this.onEnd(event as { terminal: TerminalLike; execution: ExecutionLike; exitCode?: number })));
    const close = windowApi.onDidCloseTerminal as ((listener: (terminal: TerminalLike) => void) => vscode.Disposable) | undefined;
    if (close) this.disposables.push(close(terminal => {
      const id = this.terminalIds.get(terminal as object);
      if (id) {
        for (const context of this.active) {
          if (context.terminalId === id) this.markTerminalClosed(context, terminal.exitStatus?.code);
        }
        this.terminals.delete(id);
        this.ignoredSourceIds.delete(id);
      }
      this.ignored.delete(terminal as object);
      this.pruneStale();
      this.state.notify();
    }));
  }

  get isEnabled(): boolean { return this.enabled; }
  status(): { state: 'off' | 'waiting' | 'capturing' | 'attention'; detail: string; active: number; failed: number } {
    const failed = [...this.registry.records.values()].filter(record => record.sourceKind === 'terminal' && (record.captureStatus === 'failed' || record.captureStatus === 'unavailable')).length;
    const active = [...this.active].filter(context => context.accepting).length;
    if (!this.enabled) return { state: 'off', detail: 'Terminal capture is off', active, failed };
    if (failed) return { state: 'attention', detail: `${failed} terminal capture${failed === 1 ? '' : 's'} failed`, active, failed };
    if (active) return { state: 'capturing', detail: `Capturing ${active} terminal command${active === 1 ? '' : 's'}`, active, failed };
    return { state: 'waiting', detail: 'Ready for the next supported terminal command', active, failed };
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) {
      for (const context of this.active) this.interrupt(context, 'Capture disabled while the command was running.');
    }
    this.state.status = value ? 'Ready for the next supported terminal command' : 'Terminal capture is off';
    this.state.notify();
  }
  ignoreTerminal(terminal: object): void { this.ignored.add(terminal); }
  resetTerminalIgnore(terminal: object): void {
    this.ignored.delete(terminal);
    const id = this.terminalIds.get(terminal);
    if (id) this.ignoredSourceIds.delete(id);
  }
  availableTerminals(): { id: string; label: string; ignored: boolean }[] {
    return [...this.terminals.entries()].map(([id, value]) => ({ id, label: value.label, ignored: this.ignoredSourceIds.has(id) || this.ignored.has(value.terminal) }));
  }
  /** Remove completed terminal metadata once its final retained event is gone. */
  pruneStale(): boolean {
    let removed = false;
    for (const [id, record] of this.registry.records) {
      if (record.sourceKind !== 'terminal' || record.status === 'running' || record.status === 'stopping' || record.captureStatus === 'streaming'
        || record.captureStatus === 'failed' || record.captureStatus === 'unavailable') continue;
      if (this.ingestion.store.sessionEventCount(record.serverId, record.id) > 0) continue;
      this.registry.records.delete(id);
      removed = true;
    }
    return removed;
  }
  toggleSource(id: string): void {
    const terminal = this.terminals.get(id)?.terminal;
    const currentlyIgnored = this.ignoredSourceIds.has(id) || Boolean(terminal && this.ignored.has(terminal));
    if (currentlyIgnored) { this.ignoredSourceIds.delete(id); if (terminal) this.ignored.delete(terminal); }
    else this.ignoredSourceIds.add(id);
    for (const context of this.active) if (context.terminalId === id && !currentlyIgnored)
      this.interrupt(context, 'Terminal excluded from capture.');
    this.state.notify();
  }

  dispose(): void {
    this.disposed = true;
    for (const context of this.active) this.interrupt(context, 'Logline was disposed before the stream ended.');
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }

  private onStart(event: { terminal: TerminalLike; execution: ExecutionLike; shellIntegration?: unknown }): void {
    if (this.disposed || !this.enabled || !event?.terminal || !event.execution) return;
    const terminal = event.terminal as object;
    if (this.ignored.has(terminal)) return;
    const id = this.rememberTerminal(event.terminal);
    const command = event.execution.commandLine?.value ?? '';
    const cwd = event.execution.cwd?.fsPath;
    const label = `${event.terminal.name || 'Terminal'} · ${id}`;
    this.terminals.set(id, { terminal, label });
    if (this.ignoredSourceIds.has(id)) return;
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'), serverId: id, server: label, status: 'running', startedAt: Date.now(), events: 0,
      sourceKind: 'terminal', owned: false, captureComplete: false, captureStatus: 'streaming', command, cwd,
      taskState: 'running'
    };
    this.registry.records.set(record.id, record);
    const context: CaptureContext = { record, terminalId: id, accepting: true, streamDone: false, streamFailed: false, endSeen: false };
    this.executions.set(event.execution as object, context);
    this.active.add(context);
    this.state.status = `Capturing ${label}`;
    this.state.notify();
    // Calling read synchronously here is required by VS Code: awaiting before
    // obtaining the stream can lose the first bytes written by the command.
    let stream: AsyncIterable<string> | undefined;
    try { stream = event.execution.read(); } catch { stream = undefined; }
    if (!stream) {
      context.streamFailed = true;
      context.streamDone = true;
      record.captureStatus = 'unavailable';
      record.captureReason = 'Shell integration did not expose a readable stream.';
      record.error = record.captureReason;
      this.active.delete(context);
      this.state.notify();
      return;
    }
    const normalizer = new TerminalNormalizer(({ text, truncated }) => {
      if (!context.accepting || this.disposed || !this.enabled) return;
      const accepted = this.ingestion.accept(text, 'terminal', { serverId: id, server: label, sessionId: record.id, truncated, persist: this.config.get('persistLogs', false) });
      if (accepted) { record.events++; this.state.notify(); }
    }, this.config.get('maxLineLength', 65536));
    void this.consume(stream, normalizer, record);
  }

  private async consume(stream: AsyncIterable<string>, normalizer: TerminalNormalizer, record: SessionSummary): Promise<void> {
    const context = [...this.active].find(item => item.record === record);
    if (!context) return;
    try {
      for await (const chunk of stream) {
        if (this.disposed) break;
        // Keep draining an externally owned terminal stream after capture is
        // disabled so the command can finish without backpressure. The line
        // callback itself rejects every chunk once accepting is false.
        if (context.accepting && this.enabled) normalizer.write(String(chunk));
      }
      context.streamDone = true;
    } catch (error) {
      context.streamFailed = true;
      record.captureStatus = context.accepting ? 'failed' : 'interrupted';
      record.captureReason = context.accepting ? `Terminal output stream failed: ${error instanceof Error ? error.message : String(error)}` : record.captureReason;
      record.error = record.captureReason;
    } finally {
      normalizer.end();
      context.streamDone = true;
      if (context.streamFailed && context.accepting) record.captureStatus = 'failed';
      else if (!context.accepting || this.disposed) record.captureStatus = 'interrupted';
      else { record.captureStatus = 'complete'; record.captureComplete = true; }
      if (record.captureStatus !== 'complete') record.captureComplete = false;
      if (!context.endSeen && (record.status === 'running' || record.status === 'stopping')) {
        record.status = 'exited';
        record.endedAt = Date.now();
        record.exitReason = 'terminal output stream ended';
        record.taskState = record.status;
      }
      this.active.delete(context);
      if (context.endSeen) this.registry.pruneSessionRegistry();
      this.pruneStale();
      if (!this.registry.sessionSummaries().some(item => item.sourceKind === 'terminal' && item.status === 'running')) {
        this.state.status = record.status === 'failed' ? `Terminal command failed: ${record.exitCode ?? 'unknown'}` : 'Terminal command exited';
      }
      this.state.notify();
    }
  }

  private onEnd(event: { terminal: TerminalLike; execution: ExecutionLike; exitCode?: number }): void {
    const context = this.executions.get(event.execution as object);
    if (!context) return;
    const record = context.record;
    context.endSeen = true;
    record.status = event.exitCode === undefined ? 'exited' : event.exitCode === 0 ? 'exited' : 'failed';
    record.exitCode = event.exitCode;
    record.endedAt = Date.now();
    record.exitReason = event.exitCode === undefined ? 'exit code unknown' : `exit code ${event.exitCode}`;
    record.taskState = record.status;
    if (record.captureStatus !== 'unavailable' && context.streamFailed && context.accepting) record.captureStatus = 'failed';
    else if (!context.streamDone) record.captureStatus = context.accepting ? 'streaming' : 'interrupted';
    if (context.streamDone) this.registry.pruneSessionRegistry();
    if (context.streamDone) this.pruneStale();
    if (!this.registry.sessionSummaries().some(item => item.sourceKind === 'terminal' && item.status === 'running')) {
      this.state.status = event.exitCode === 0 ? 'Terminal command exited' : `Terminal command failed: ${event.exitCode ?? 'unknown'}`;
    }
    this.state.notify();
  }

  private markTerminalClosed(context: CaptureContext, exitCode: number | undefined): void {
    if (context.endSeen || (context.record.status !== 'running' && context.record.status !== 'stopping')) return;
    context.endSeen = true;
    const record = context.record;
    record.status = exitCode === undefined ? 'exited' : exitCode === 0 ? 'exited' : 'failed';
    record.exitCode = exitCode;
    record.endedAt = Date.now();
    record.exitReason = exitCode === undefined ? 'terminal closed' : `exit code ${exitCode}`;
    record.taskState = record.status;
  }

  private interrupt(context: CaptureContext, reason: string): void {
    if (!context.accepting) return;
    context.accepting = false;
    context.record.captureStatus = 'interrupted';
    context.record.captureComplete = false;
    context.record.captureReason = reason;
  }

  private rememberTerminal(terminal: TerminalLike): string {
    const object = terminal as object;
    const existing = this.terminalIds.get(object);
    const id = existing ?? `terminal-${randomBytes(5).toString('hex')}-${this.nextTerminal++}`;
    this.terminalIds.set(object, id);
    this.terminals.set(id, { terminal: object, label: `${terminal.name || 'Terminal'} · ${id}` });
    return id;
  }
}
