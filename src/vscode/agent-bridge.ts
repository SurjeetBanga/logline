import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { agentLabel, agentsDirectory, BRIDGE_VERSION, isAlive, MAX_BRIDGE_REQUEST_BYTES, mcpScriptPath, type BridgeRequest, type BridgeWindow } from '../protocol/agent-bridge';

export interface AgentBridgeOptions {
  /** Run a Logline tool and return its bounded JSON text. */
  run(tool: string, input: unknown, token: { isCancellationRequested: boolean }): Promise<string>;
  folders(): string[];
  name(): string;
  /** Called when a client calls for the first time in a while, so the panel can show it. */
  onClient?(): void;
  /** The current sharing grant; agents are shown as readers only of the grant they called under. */
  grant?(): string | undefined;
  directory?: string;
  pid?: number;
}

const RECENT_MS = 10 * 60 * 1000;

/**
 * Lets MCP clients such as Claude Code and Codex call the same read-only
 * Logline tools as Copilot. What they can read is still decided by Share
 * with agent; the bridge only carries calls from this user's processes.
 */
export class AgentBridge {
  private server?: Server;
  private starting?: Promise<void>;
  private file?: string;
  private port = 0;
  private readonly token = randomBytes(32).toString('hex');
  private readonly clients = new Map<string, { seen: number; grant?: string }>();
  private readonly directory: string;
  private readonly pid: number;

  constructor(private readonly options: AgentBridgeOptions) {
    this.directory = options.directory ?? agentsDirectory();
    this.pid = options.pid ?? process.pid;
  }

  get running(): boolean { return Boolean(this.server); }

  /** Start listening; overlapping calls, such as quick setting toggles, share one listener. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return this.starting ??= this.listen().finally(() => { this.starting = undefined; });
  }

  private async listen(): Promise<void> {
    const server = createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.unref?.();
    this.server = server;
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.removeStale();
    this.publish();
  }

  /** Rewrite the discovery file, for example after workspace folders change. */
  publish(): void {
    if (!this.server) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const window: BridgeWindow = { version: BRIDGE_VERSION, pid: this.pid, port: this.port, token: this.token, folders: this.options.folders(), name: this.options.name() };
    this.file = join(this.directory, `${this.pid}.json`);
    writeFileSync(this.file, JSON.stringify(window), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    if (this.file) { try { unlinkSync(this.file); } catch { /* already gone */ } this.file = undefined; }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** Agents that called in the last ten minutes, by friendly name. */
  recentClients(now = Date.now()): string[] {
    const grant = this.options.grant?.();
    return [...this.clients]
      .filter(([, client]) => now - client.seen < RECENT_MS && (!this.options.grant || (grant !== undefined && client.grant === grant)))
      .map(([name]) => name).sort();
  }

  private accept(socket: Socket): void {
    const cancellation = { isCancellationRequested: false };
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.setNoDelay?.(true);
    // A connection that never sends its request is dropped; the call itself may take longer.
    socket.setTimeout(30_000, () => { if (!handled) socket.destroy(); });
    socket.on('close', () => { cancellation.isCancellationRequested = true; });
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) {
        if (buffer.length > MAX_BRIDGE_REQUEST_BYTES) socket.destroy();
        return;
      }
      handled = true;
      socket.setTimeout(0);
      if (end > MAX_BRIDGE_REQUEST_BYTES) { socket.destroy(); return; }
      void this.handle(buffer.subarray(0, end).toString('utf8'), socket, cancellation);
    });
  }

  private async handle(line: string, socket: Socket, cancellation: { isCancellationRequested: boolean }): Promise<void> {
    const reply = (value: object) => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
    let request: Partial<BridgeRequest>;
    try { request = JSON.parse(line) as Partial<BridgeRequest>; }
    catch { reply({ error: 'The request was not valid JSON.' }); return; }
    if (!this.authorized(request.token)) { reply({ error: 'This Logline window did not accept the token. Restart the agent so it reads the current window.' }); return; }
    if (typeof request.tool !== 'string') { reply({ error: 'The request named no tool.' }); return; }
    let text: string;
    try { text = await this.options.run(request.tool, request.input, cancellation); }
    catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }); return; }
    // Only a call that returned logs makes an agent a reader of this grant.
    if (typeof request.client === 'string' && request.client && !refused(text)) {
      const label = agentLabel(request.client);
      const previous = this.clients.get(label);
      const grant = this.options.grant?.();
      this.clients.set(label, { seen: Date.now(), grant });
      if (!previous || Date.now() - previous.seen >= RECENT_MS || previous.grant !== grant) this.options.onClient?.();
    }
    reply({ text });
  }

  private authorized(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const given = Buffer.from(token), expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Discovery files of windows that closed without cleaning up. */
  private removeStale(): void {
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json') || name === `${this.pid}.json`) continue;
      const file = join(this.directory, name);
      try {
        const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
        if (typeof pid === 'number' && isAlive(pid)) continue;
      } catch { /* unreadable files are stale too */ }
      try { unlinkSync(file); } catch { /* another window removed it */ }
    }
  }
}

/**
 * Keep the MCP server script at a path that survives extension updates, so
 * agent configurations do not point into a versioned extension folder.
 */
export function installMcpScript(source: string, target = mcpScriptPath()): void {
  const script = readFileSync(source, 'utf8');
  try { if (readFileSync(target, 'utf8') === script) return; } catch { /* not installed yet */ }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, script, { mode: 0o644 });
}

function refused(text: string): boolean {
  try { return Boolean((JSON.parse(text) as { error?: unknown }).error); } catch { return false; }
}
