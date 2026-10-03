import { randomBytes } from 'node:crypto';
import type { Settings } from '../core/settings';
import type { LogEvent, SessionSummary } from '../core/types';
import type { Ingestion } from './ingestion';
import { LineReader } from './line-reader';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';
import { StackJoiner } from './stack-joiner';

type Location = NonNullable<LogEvent['location']>;

/** The parts of a VS Code debug session that capture needs, kept free of the editor API. */
export interface DebugSessionInfo {
  id: string;
  /** The launch configuration name of the top-level session; restarts share it. */
  name: string;
  type: string;
  command?: string;
  cwd?: string;
  /** `integratedTerminal` output is already visible to terminal capture. */
  console?: string;
  stop?: () => void;
}

/** The body of a Debug Adapter Protocol `output` event. */
export interface DapOutputBody {
  category?: string;
  output?: string;
  source?: { path?: string; name?: string };
  line?: number;
  column?: number;
}

interface Stream {
  reader: LineReader;
  joiner?: StackJoiner<Location>;
  /** Location for the next completed line: where its first chunk was output. */
  location?: Location;
  /** Location of the output event being read, for the lines that start in it. */
  current?: Location;
}

interface Capture {
  info: DebugSessionInfo;
  serverId: string;
  label: string;
  record?: SessionSummary;
  streams: Map<string, Stream>;
  exitCode?: number;
  ended: boolean;
}

// DAP output categories. `console` (also the default when an adapter omits
// the category) is what the Debug Console shows as adapter messages.
const STREAMS: Record<string, string> = { stdout: 'stdout', stderr: 'stderr', important: 'stderr', console: 'console' };

/**
 * Captures program output from debug sessions. Debug adapters report output
 * as Debug Adapter Protocol events in arbitrary chunks, so each category is
 * framed into lines and stack traces are joined like any other capture.
 * VS Code owns the session; Logline only observes it and can ask to stop it.
 */
export class DebugCapture {
  private readonly captures = new Map<string, Capture>();

  constructor(private readonly config: Settings, private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion, private readonly state: RuntimeState,
    private readonly terminalCaptureEnabled: () => boolean = () => false) { }

  get active(): number { return [...this.captures.values()].filter(capture => capture.record && !capture.ended).length; }

  start(info: DebugSessionInfo): void {
    if (this.captures.has(info.id) || !this.config.get('captureDebugSessions', true)) return;
    // With a terminal console, program output also reaches the terminal,
    // where terminal capture would record every line a second time.
    if (info.console === 'integratedTerminal' && this.terminalCaptureEnabled()) return;
    this.captures.set(info.id, { info, serverId: `debug:${info.name}`, label: `Debug · ${info.name}`, streams: new Map(), ended: false });
  }

  output(sessionId: string, body: DapOutputBody | undefined): void {
    const capture = this.captures.get(sessionId);
    if (!capture || capture.ended || typeof body?.output !== 'string' || !body.output) return;
    const name = STREAMS[body.category ?? 'console'];
    if (!name) return;
    if (!capture.record) this.createRecord(capture);
    const stream = this.stream(capture, name);
    // Each output event is one logging call, so its lines share its location;
    // a line continued from an earlier event keeps where it started.
    stream.current = locationOf(body);
    if (!stream.reader.pending && !stream.reader.truncated) stream.location = stream.current;
    stream.reader.consume(body.output);
  }

  exited(sessionId: string, exitCode: unknown): void {
    const capture = this.captures.get(sessionId);
    if (capture && typeof exitCode === 'number' && Number.isFinite(exitCode)) capture.exitCode = exitCode;
  }

  end(sessionId: string): void {
    const capture = this.captures.get(sessionId);
    if (!capture) return;
    // A final line without a newline is complete once the session ends.
    for (const stream of capture.streams.values()) { stream.reader.end(); stream.joiner?.end(); }
    capture.ended = true;
    this.captures.delete(sessionId);
    const record = capture.record;
    if (!record) return;
    record.endedAt = Date.now();
    record.captureComplete = true;
    record.exitCode = capture.exitCode;
    record.status = capture.exitCode !== undefined && capture.exitCode !== 0 && record.status !== 'stopping' ? 'failed' : 'exited';
    record.exitReason = capture.exitCode === undefined ? 'debug session ended' : `exit code ${capture.exitCode}`;
    this.state.status = this.active ? 'Running' : `Debug session ended: ${capture.info.name}`;
    this.registry.pruneSessionRegistry();
    this.state.notify();
  }

  stopSessionById(id: string): void {
    for (const capture of this.captures.values()) if (capture.record?.id === id) this.requestStop(capture);
  }

  stopServer(serverId: string): void {
    for (const capture of this.captures.values()) if (capture.serverId === serverId) this.requestStop(capture);
  }

  dispose(): void { for (const id of [...this.captures.keys()]) this.end(id); }

  private requestStop(capture: Capture): void {
    if (!capture.record || capture.record.status !== 'running' || !capture.info.stop) return;
    capture.record.status = 'stopping';
    this.state.status = 'Stopping…';
    this.state.notify();
    capture.info.stop();
  }

  private stream(capture: Capture, name: string): Stream {
    let stream = capture.streams.get(name);
    if (stream) return stream;
    const limit = this.config.get('maxLineLength', 65536);
    const ingest = (line: string, truncated: boolean, location?: Location) => {
      const record = capture.record!;
      const event = this.ingestion.accept(line, name, {
        serverId: capture.serverId, server: capture.label, sessionId: record.id, truncated, persist: true, location
      });
      if (!event) return;
      record.events++;
      this.state.notify();
    };
    const joiner = this.config.get('joinStackTraces', true) ? new StackJoiner<Location>(ingest, limit) : undefined;
    const created: Stream = {
      joiner,
      reader: new LineReader((line, truncated) => {
        const location = created.location;
        created.location = created.current;
        if (joiner) joiner.write(line, truncated, location); else ingest(line, truncated, location);
      }, limit)
    };
    capture.streams.set(name, created);
    return created;
  }

  // Created on the first output, so sessions that never print anything (such
  // as a js-debug parent session) leave no empty run behind.
  private createRecord(capture: Capture): SessionSummary {
    const { info } = capture;
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'), serverId: capture.serverId, server: capture.label, status: 'running',
      startedAt: Date.now(), events: 0, sourceKind: 'debug', owned: false, canStop: Boolean(info.stop), captureComplete: false,
      command: info.command || `${info.name} (${info.type})`, cwd: info.cwd
    };
    capture.record = record;
    this.registry.records.set(record.id, record);
    this.state.status = `Capturing debug session: ${info.name}`;
    return record;
  }
}

// Adapters report either a local path or a file URL; anything else (such as
// a sourceReference into adapter memory) cannot be opened in the editor.
export function locationOf(body: DapOutputBody): Location | undefined {
  let file = body.source?.path;
  const line = body.line;
  if (!file || typeof file !== 'string' || !Number.isSafeInteger(line) || line! < 1) return undefined;
  if (file.startsWith('file://')) {
    try { file = decodeURIComponent(new URL(file).pathname).replace(/^\/([A-Za-z]:\/)/, '$1'); } catch { return undefined; }
  } else if (/^[a-z][a-z\d+.-]+:/i.test(file) && !/^[A-Za-z]:[\\/]/.test(file)) return undefined;
  if (/[\x00-\x1f]/.test(file)) return undefined;
  const column = Number.isSafeInteger(body.column) && body.column! >= 1 ? body.column : undefined;
  return { file, line: line!, ...(column ? { column } : {}) };
}
