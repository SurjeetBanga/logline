import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  browserLogRecord,
  browserSource,
  consoleRecord,
  exceptionRecord,
  REQUEST_MODES,
  RequestTracker,
  type BrowserRecord,
  type RequestMode,
} from '../core/browser-events';
import type { Settings } from '../core/settings';
import type { SessionSummary } from '../core/types';
import type { Ingestion } from './ingestion';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';

/** A protocol message larger than this is skipped rather than held in memory. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** How long a browser has to answer a command, and to exit after being asked to close. */
const COMMAND_TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 2000;
/** How long a browser that ignored both has to die once it is killed outright; nothing waits for it longer. */
const KILL_GRACE_MS = 2000;
/** How long a starting browser has to report the tab it opened with before Logline opens one. */
const FIRST_TAB_MS = 1500;
/** How often answered requests whose body was never read are looked for. */
const SWEEP_MS = 1000;

/** A launched browser: its protocol pipe and its end. */
export interface BrowserProcess {
  readonly pid?: number;
  /** Protocol messages to the browser. */
  readonly input: Writable;
  /** Protocol messages from the browser. */
  readonly output: Readable;
  /** Called once, when the browser has exited or could not start. */
  onExit(listener: (error?: Error) => void): void;
  /** Ask the process to end, or with `force` end it without asking. */
  kill(force?: boolean): void;
}

export type SpawnBrowser = (executable: string, args: string[]) => BrowserProcess;

/** What to launch, and the profile folder that keeps the app's sign-ins between runs. */
export interface BrowserLaunch {
  executable: string;
  profileDir: string;
}

/**
 * Start a browser whose DevTools Protocol runs over two inherited pipes (file descriptors 3 and 4),
 * so no debugging port is opened that another local process could attach to.
 */
export const spawnBrowser: SpawnBrowser = (executable, args) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let ended = false;
  const listeners: ((error?: Error) => void)[] = [];
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    for (const listener of listeners) listener(error);
  };
  child.once('error', (error) => end(error));
  child.once('exit', () => end());
  return {
    pid: child.pid,
    input: child.stdio[3] as Writable,
    output: child.stdio[4] as Readable,
    onExit: (listener) => listeners.push(listener),
    kill: (force) => void child.kill(force ? 'SIGKILL' : 'SIGTERM'),
  };
};

type Json = Record<string, unknown>;
interface ProtocolEvent {
  method: string;
  params: Json;
  sessionId?: string;
}

/**
 * The DevTools Protocol over a pipe: JSON messages separated by a NUL byte. Answers are matched to
 * their commands by id; everything else is an event.
 */
export class CdpPipe {
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** Inside a message too large to keep: bytes are dropped until its end. */
  private skipping = false;
  private nextId = 1;
  private closed = false;
  private readonly waiting = new Map<
    number,
    { resolve: (result: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly onEvent: (event: ProtocolEvent) => void,
    private readonly timeoutMs = COMMAND_TIMEOUT_MS,
  ) {
    output.on('data', (chunk: Buffer) => this.read(chunk));
    // A browser that exits breaks both pipes; its exit is reported by the process, not here.
    output.on('error', () => undefined);
    input.on('error', () => undefined);
  }

  /** Send a command and wait for its answer; rejects on a protocol error, a timeout, or a closed pipe. */
  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('The browser is closed.'));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser did not answer ${method}.`));
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      } catch (error) {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Stop: commands still waiting are rejected, and later ones refused. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.chunks = [];
    this.buffered = 0;
    for (const [, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('The browser closed.'));
    }
    this.waiting.clear();
  }

  private read(chunk: Buffer): void {
    let start = 0;
    while (!this.closed && start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      if (!this.skipping) {
        if (this.buffered + piece.length > MAX_MESSAGE_BYTES) {
          this.skipping = true;
          this.chunks = [];
          this.buffered = 0;
        } else if (piece.length) {
          this.chunks.push(piece);
          this.buffered += piece.length;
        }
      }
      if (end === -1) return;
      if (!this.skipping) this.message(this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks));
      this.skipping = false;
      this.chunks = [];
      this.buffered = 0;
      start = end + 1;
    }
  }

  private message(bytes: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    const { id, method, params, result, error, sessionId } = message as Json;
    if (typeof id === 'number') {
      const waiting = this.waiting.get(id);
      if (!waiting) return;
      this.waiting.delete(id);
      clearTimeout(waiting.timer);
      if (error && typeof error === 'object')
        waiting.reject(new Error(String((error as Json).message ?? 'The browser refused the command.')));
      else waiting.resolve(result && typeof result === 'object' ? (result as Json) : {});
      return;
    }
    if (typeof method !== 'string') return;
    this.onEvent({
      method,
      params: params && typeof params === 'object' ? (params as Json) : {},
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    });
  }
}

interface Source {
  serverId: string;
  server: string;
}

interface Running {
  record: SessionSummary;
  process: BrowserProcess;
  pipe: CdpPipe;
  requests: RequestTracker;
  /** The address to show in the first tab once the browser reports it. */
  first?: string;
  /** Called when a tab has taken `first`. */
  claimed: () => void;
  /** The open tabs by protocol session, each with the source of the site it is showing. */
  tabs: Map<string, Source>;
  /** Whether Logline opened a tab because the browser had reported none yet. */
  openedOwnTab: boolean;
  exited: Promise<void>;
  stopping: boolean;
  /** The person closed the last tab; the browser is closed for them. */
  closedByUser?: boolean;
  killer?: ReturnType<typeof setTimeout>;
  sweeper?: ReturnType<typeof setInterval>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Captures a browser Logline opened: console calls, uncaught exceptions, what the browser itself
 * reports (a request blocked by CORS, a Content Security Policy), and network requests become log
 * events of a Browser source, one per site a tab shows. It only observes: beyond opening the address
 * it was asked to, it never navigates, clicks, or runs script. One browser runs at a time; opening
 * another address adds a tab.
 */
export class BrowserCapture {
  private running?: Running;
  /** Opens run one at a time, so two at once cannot each start a browser. */
  private opening: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Settings,
    private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion,
    private readonly state: RuntimeState,
    private readonly spawner: SpawnBrowser = spawnBrowser,
  ) {}

  /** The run of the browser being captured, if one is open. */
  get active(): SessionSummary | undefined {
    return this.running?.record;
  }

  /** The sites its tabs are showing, such as `localhost:5173`. */
  get sites(): string[] {
    const running = this.running;
    if (!running) return [];
    const sources = running.tabs.size ? [...running.tabs.values()] : [running.record];
    return [...new Set(sources.map((source) => source.serverId.slice('browser:'.length)))];
  }

  private mode(): RequestMode {
    const mode = this.config.get<string>('browser.requests', 'api') as RequestMode;
    return REQUEST_MODES.includes(mode) ? mode : 'api';
  }

  /**
   * Open `url` in the captured browser, starting it when none is open; returns the run's id. Rejects
   * when the browser cannot start or closes before Logline is connected to it.
   */
  open(url: string, launch: BrowserLaunch): Promise<string> {
    const next = this.opening.then(() => this.openNow(url, launch));
    this.opening = next.catch(() => undefined);
    return next;
  }

  private async openNow(url: string, launch: BrowserLaunch): Promise<string> {
    const existing = this.running;
    if (existing && !existing.stopping) {
      await existing.pipe.send('Target.createTarget', { url });
      return existing.record.id;
    }
    // A browser on its way out still holds the profile. One that will not go is not waited for.
    if (existing) await Promise.race([existing.exited, delay(CLOSE_GRACE_MS + KILL_GRACE_MS)]);
    const { serverId, server } = browserSource(url);
    const process = this.spawner(launch.executable, [
      '--remote-debugging-pipe',
      `--user-data-dir=${launch.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]);
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'),
      serverId,
      server,
      status: 'running',
      startedAt: Date.now(),
      events: 0,
      sourceKind: 'browser',
      owned: true,
      canStop: true,
      captureComplete: false,
      command: url,
      ...(process.pid !== undefined ? { pid: process.pid } : {}),
    };
    let failure: Error | undefined;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let claimed!: () => void;
    const firstClaimed = new Promise<void>((resolve) => (claimed = resolve));
    const running: Running = {
      record,
      process,
      pipe: new CdpPipe(process.input, process.output, (event) => this.event(running, event)),
      requests: new RequestTracker(() => this.mode()),
      first: url,
      claimed,
      tabs: new Map(),
      openedOwnTab: false,
      exited,
      stopping: false,
    };
    process.onExit((error) => {
      failure = error ?? new Error('The browser closed before Logline connected to it.');
      this.finish(running, error);
      exit();
    });
    running.sweeper = setInterval(() => {
      for (const [tab, unread] of running.requests.sweep()) this.ingest(running, unread, tab);
    }, SWEEP_MS);
    running.sweeper.unref?.();
    this.running = running;
    this.registry.records.set(record.id, record);
    this.state.status = `Capturing ${server}`;
    this.state.notify();
    try {
      // New tabs wait until their console and network are being read, so nothing they do first is missed.
      await running.pipe.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      // The tab the browser opened with usually is reported by now, and shows the address. A browser
      // slow to start reports it a little later; one that never does gets a tab opened.
      if (running.first) await Promise.race([firstClaimed, exited, delay(FIRST_TAB_MS)]);
      if (failure) throw failure;
      if (running.first) {
        running.first = undefined;
        running.openedOwnTab = true;
        await running.pipe.send('Target.createTarget', { url });
      }
    } catch (error) {
      const reason = failure ?? (error instanceof Error ? error : new Error(String(error)));
      if (this.running === running) this.stopRunning(running);
      throw reason;
    }
    return record.id;
  }

  private event(running: Running, { method, params, sessionId }: ProtocolEvent): void {
    if (method === 'Target.attachedToTarget') {
      void this.attached(running, params);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      if (typeof params.sessionId !== 'string') return;
      running.requests.clear(`${params.sessionId}:`);
      // Closing a browser's last window ends its process on Windows and Linux, but not on macOS, where
      // it would run on unseen. The last tab closing is the end of the capture everywhere.
      if (running.tabs.delete(params.sessionId) && !running.tabs.size && !running.stopping) {
        running.closedByUser = true;
        this.stopRunning(running);
      }
      return;
    }
    if (!sessionId || running.stopping) return;
    let record: BrowserRecord | undefined;
    if (method === 'Runtime.consoleAPICalled') record = consoleRecord(params);
    else if (method === 'Runtime.exceptionThrown') record = exceptionRecord(params);
    else if (method === 'Log.entryAdded') record = browserLogRecord(params, this.mode());
    else if (method.startsWith('Network.')) {
      // Every request names the document that made it, which says what site the tab is on now.
      if (method === 'Network.requestWillBeSent') this.visiting(running, sessionId, params.documentURL);
      record = running.requests.handle(method, params, sessionId);
    }
    if (record) this.ingest(running, record, sessionId);
  }

  /** A tab is showing `url`: its events from here on belong to that site's source. */
  private visiting(running: Running, sessionId: string, url: unknown): void {
    if (typeof url !== 'string' || !/^https?:/i.test(url) || !running.tabs.has(sessionId)) return;
    const { serverId, server } = browserSource(url);
    if (running.tabs.get(sessionId)!.serverId !== serverId) running.tabs.set(sessionId, { serverId, server });
  }

  private ingest(running: Running, record: BrowserRecord, tab: string): void {
    const source = running.tabs.get(tab) ?? running.record;
    const event = this.ingestion.accept(JSON.stringify(record), 'browser', {
      serverId: source.serverId,
      server: source.server,
      sessionId: running.record.id,
    });
    if (!event) return;
    running.record.events++;
    this.state.notify();
  }

  /** A tab, worker, or frame was attached: read a page's console and network, and let anything else go on. */
  private async attached(running: Running, params: Json): Promise<void> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const info = params.targetInfo && typeof params.targetInfo === 'object' ? (params.targetInfo as Json) : {};
    if (!sessionId) return;
    const { pipe } = running;
    const page = info.type === 'page';
    const quietly = (command: Promise<unknown>) => command.catch(() => undefined);
    // Claimed before anything is awaited, so `open` does not also open a tab for it.
    const first = page ? running.first : undefined;
    if (first) {
      running.first = undefined;
      running.claimed();
    }
    if (page) {
      // Until it loads something, a tab belongs to the site the browser was opened for.
      running.tabs.set(sessionId, { serverId: running.record.serverId, server: running.record.server });
      this.visiting(running, sessionId, first ?? info.url);
      // The blank tab of a browser that reported it only after Logline had opened one of its own.
      if (running.openedOwnTab && info.url === 'about:blank' && !info.openerId && typeof info.targetId === 'string') {
        running.openedOwnTab = false;
        running.tabs.delete(sessionId);
        await quietly(pipe.send('Target.closeTarget', { targetId: info.targetId }));
        return;
      }
      // One that cannot be read is no reason to leave the tab waiting, or the address unopened.
      await Promise.all(
        ['Runtime.enable', 'Network.enable', 'Log.enable'].map((method) => quietly(pipe.send(method, {}, sessionId))),
      );
      if (first)
        await pipe
          .send('Page.navigate', { url: first }, sessionId)
          .catch(() => quietly(pipe.send('Target.createTarget', { url: first })));
    }
    if (params.waitingForDebugger === true) await quietly(pipe.send('Runtime.runIfWaitingForDebugger', {}, sessionId));
    if (!page) await quietly(pipe.send('Target.detachFromTarget', { sessionId }));
  }

  private stopRunning(running: Running): void {
    if (running.stopping) return;
    running.stopping = true;
    running.record.status = 'stopping';
    // Asked to close first, so the profile is written; then told to end; then ended.
    running.pipe.send('Browser.close').catch(() => undefined);
    running.killer = setTimeout(() => {
      running.process.kill();
      if (running.record.status !== 'stopping') return;
      running.killer = setTimeout(() => running.process.kill(true), KILL_GRACE_MS);
      running.killer.unref?.();
    }, CLOSE_GRACE_MS);
    running.killer.unref?.();
    this.state.notify();
  }

  private finish(running: Running, error?: Error): void {
    clearTimeout(running.killer);
    clearInterval(running.sweeper);
    running.pipe.close();
    running.requests.clear();
    running.tabs.clear();
    if (this.running === running) this.running = undefined;
    const { record } = running;
    record.status = error ? 'failed' : 'exited';
    record.endedAt = Date.now();
    record.captureComplete = true;
    record.exitReason = error
      ? error.message
      : running.stopping && !running.closedByUser
        ? 'stopped'
        : 'browser closed';
    this.state.status = `${record.server} closed`;
    this.registry.pruneSessionRegistry();
    this.state.notify();
  }

  stopSessionById(id: string): void {
    if (this.running?.record.id === id) this.stopRunning(this.running);
  }

  /** Stop the browser when `serverId` is its source, or the source of a site one of its tabs shows. */
  stopServer(serverId: string): void {
    const running = this.running;
    if (!running) return;
    if (running.record.serverId === serverId || [...running.tabs.values()].some((tab) => tab.serverId === serverId))
      this.stopRunning(running);
  }

  stop(): void {
    if (this.running) this.stopRunning(this.running);
  }

  /** Close the browser and wait for it to exit, though not for one that outlives being killed. */
  async dispose(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.stopRunning(running);
    await Promise.race([running.exited, delay(CLOSE_GRACE_MS + 2 * KILL_GRACE_MS)]);
  }
}
