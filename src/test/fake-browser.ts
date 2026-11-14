import { PassThrough } from 'node:stream';
import type { BrowserProcess, SpawnBrowser } from '../capture/browser-capture';

type Json = Record<string, unknown>;

export interface SentCommand {
  id: number;
  method: string;
  params: Json;
  sessionId?: string;
}

/**
 * A browser for tests: the two ends of a DevTools Protocol pipe, with every command answered `{}`
 * unless `answer` says otherwise. `emit` sends an event as a browser would.
 */
export class FakeBrowser implements BrowserProcess {
  readonly pid = 4242;
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly commands: SentCommand[] = [];
  /** The arguments it was launched with. */
  args: string[] = [];
  executable = '';
  killed = false;
  /** Killed outright, after ignoring a request to end. */
  forced = false;
  /** Whether it ends when asked to; one that does not ends only when forced. */
  obeysKill = true;
  exited = false;
  /** Return a result, `{ error }` to refuse, or `'silent'` to never answer. */
  answer: (command: SentCommand) => Json | 'silent' | undefined = () => undefined;
  private readonly listeners: ((error?: Error) => void)[] = [];
  private pending = '';

  constructor() {
    this.input.on('data', (chunk: Buffer) => {
      this.pending += chunk.toString('utf8');
      for (let end = this.pending.indexOf('\0'); end !== -1; end = this.pending.indexOf('\0')) {
        const command = JSON.parse(this.pending.slice(0, end)) as SentCommand;
        this.pending = this.pending.slice(end + 1);
        this.commands.push(command);
        const answer = this.answer(command);
        if (answer === 'silent') continue;
        if (command.method === 'Browser.close') {
          this.exit();
          continue;
        }
        this.write(answer?.error ? { id: command.id, error: answer.error } : { id: command.id, result: answer ?? {} });
      }
    });
  }

  write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\0`);
  }

  emit(method: string, params: Json = {}, sessionId?: string): void {
    this.write({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  /** Report a tab, as a browser does for the one it opens with and for each new one. */
  attachPage(sessionId: string, waitingForDebugger = false): void {
    this.emit('Target.attachedToTarget', {
      sessionId,
      targetInfo: { type: 'page', targetId: sessionId },
      waitingForDebugger,
    });
  }

  methods(): string[] {
    return this.commands.map((command) => command.method);
  }

  onExit(listener: (error?: Error) => void): void {
    this.listeners.push(listener);
  }

  exit(error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.listeners) listener(error);
  }

  kill(force = false): void {
    this.killed = true;
    if (force) this.forced = true;
    if (force || this.obeysKill) this.exit();
  }
}

/** A spawner that hands out fake browsers and remembers them, newest last. */
export function fakeSpawner(prepare: (browser: FakeBrowser) => void = () => undefined): {
  spawn: SpawnBrowser;
  browsers: FakeBrowser[];
} {
  const browsers: FakeBrowser[] = [];
  return {
    browsers,
    spawn: (executable, args) => {
      const browser = new FakeBrowser();
      browser.executable = executable;
      browser.args = args;
      prepare(browser);
      browsers.push(browser);
      return browser;
    },
  };
}
