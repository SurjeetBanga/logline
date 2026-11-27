import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_NAMES,
  AgentSessionParser,
  agentSource,
  claudeProjectDir,
  within,
  type AgentName,
  type AgentSessionInfo,
  type AgentTokens,
} from '../core/agent-session';
import { shortCount } from '../core/codex-usage';
import type { Settings } from '../core/settings';
import type { SessionSummary } from '../core/types';
import type { Ingestion } from './ingestion';
import { JsonlTail, listFolder } from './jsonl-tail';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';

/** How often session files are read for what was appended. */
export const AGENT_POLL_MS = 2000;
/** How often the folders are listed for new sessions. */
export const AGENT_SCAN_MS = 10_000;
/** Sessions written to within this long are shown when capture starts. */
export const AGENT_RECENT_MS = 24 * 3600_000;
/** A session whose file has not grown for this long has ended. */
export const AGENT_IDLE_MS = 10 * 60_000;
/** The newest sessions of each agent that are followed. */
export const AGENT_MAX_SESSIONS = 20;
/** The most one poll reads, so a long session read for the first time does not hold up the others. */
export const AGENT_POLL_BYTES = 32 * 1024 * 1024;
/** Ended sessions that gave way to newer ones, kept so they go on from where they were read if they resume. */
const AGENT_MAX_PARKED = 200;
/** While agent sessions are off, how often the folders are listed for sessions worth offering. */
export const AGENT_HINT_SCAN_MS = 3 * 60_000;
/** How much of a session file's start is read for the folder it worked in. */
const AGENT_CWD_BYTES = 1024 * 1024;

/** Sessions an agent wrote in an open folder in the last day, offered while agent sessions are off. */
export interface AgentHint {
  agent: AgentName;
  label: string;
  sessions: number;
}

export interface AgentSessionsOptions {
  claudeDir?: string;
  codexDir?: string;
  copilotDir?: string;
  now?: () => number;
  /** The most one poll reads; for tests. */
  pollBytes?: number;
}

interface Followed {
  agent: AgentName;
  tail: JsonlTail;
  parser: AgentSessionParser;
  record: SessionSummary;
  /** In the registry: it has logged something. */
  listed: boolean;
  modifiedAt: number;
  /** Found in a folder that holds only this workspace's sessions. */
  exact: boolean;
  /** The file has been read to its end once: what is appended after that is activity. */
  caughtUp: boolean;
  /** When it gave way to a newer session; it is followed again once its file changes after this. */
  parkedAt?: number;
  /** What the session had done when the logs were last cleared, left out of its run's detail. */
  baseline?: AgentCounts;
}

/** What a run's detail counts. */
export type AgentCounts = Pick<AgentSessionInfo, 'toolCalls' | 'failedCalls' | 'tokens'>;

/** No sessions yet for any agent. */
const noCounts = (): Record<AgentName, number> =>
  Object.fromEntries(AGENT_NAMES.map((agent) => [agent, 0])) as Record<AgentName, number>;

/**
 * Agent sessions as logs: each Claude Code, Codex, or Copilot session that worked in an
 * open folder is a run, under one source per agent, with a log line for each
 * prompt, tool call, and reply. It reads the transcripts the agents keep on
 * this machine while `logline.agentSessions.enabled` is on; while it is off, it
 * reads only the start of a session file that does not say which folder it
 * worked in, to offer the agents that worked here.
 */
export class AgentSessionCapture {
  /** The open workspace folders; sessions in other folders are left alone. */
  folders: () => string[] = () => [];
  /**
   * The folder where VS Code keeps this workspace's Copilot Chat sessions;
   * every session in it worked in this workspace.
   */
  chatSessions: () => string | undefined = () => undefined;
  private readonly followed = new Map<string, Followed>();
  /** Ended sessions that gave way to newer ones once an agent had its most; they resume where they were read. */
  private readonly parked = new Map<string, Followed>();
  /** Session files that belong to another folder, or whose source was removed. */
  private readonly ignored = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanned = -Infinity;
  private hintScanned = -Infinity;
  private found: AgentHint[] = [];
  /** The folder each session file worked in, read once from its start. */
  private readonly cwds = new Map<string, string | undefined>();
  /** Agents whose source was removed, with how many sessions it had: not read until restored. */
  private readonly removed = new Map<AgentName, number>();
  /** The session files a removed source had, read again once it is restored. */
  private readonly removedFiles = new Map<string, AgentName>();
  private polling?: Promise<void>;
  private readonly claudeDir: string;
  private readonly codexDir: string;
  private readonly copilotDir: string;

  constructor(
    private readonly config: Settings,
    private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion,
    private readonly state: RuntimeState,
    private readonly options: AgentSessionsOptions = {},
  ) {
    this.claudeDir = options.claudeDir ?? join(homedir(), '.claude');
    this.codexDir = options.codexDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.copilotDir = options.copilotDir ?? join(homedir(), '.copilot');
    this.timer = setInterval(() => void this.poll(), AGENT_POLL_MS);
    this.timer.unref?.();
  }

  get enabled(): boolean {
    return this.config.get('agentSessions.enabled', false);
  }

  /**
   * Agents the rail can offer: while agent sessions are off, those with
   * sessions in an open folder; while on, those whose source was removed.
   */
  get hints(): readonly AgentHint[] {
    if (!this.enabled) return this.found;
    return [...this.removed].map(([agent, sessions]) => ({ agent, label: agentSource(agent).server, sessions }));
  }

  /** Agents whose source was removed while agent sessions are on. */
  get removedAgents(): AgentName[] {
    return [...this.removed.keys()];
  }

  /** Read a removed agent's sessions again, or every removed agent's. True when one was removed. */
  restore(agent?: AgentName): boolean {
    const agents = agent ? [agent] : this.removedAgents;
    let restored = false;
    for (const name of agents) {
      if (!this.removed.delete(name)) continue;
      restored = true;
      for (const [file, owner] of this.removedFiles)
        if (owner === name) {
          this.removedFiles.delete(file);
          this.ignored.delete(file);
        }
    }
    if (restored) {
      this.scanned = -Infinity;
      this.state.notify();
    }
    return restored;
  }

  /** Sessions being followed. */
  get active(): number {
    return this.followed.size;
  }

  /** Read what the agents appended; a poll still under way is waited for, not repeated. */
  poll(): Promise<void> {
    this.polling ??= this.read().finally(() => (this.polling = undefined));
    return this.polling;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async read(): Promise<void> {
    const now = this.now();
    if (!this.enabled) {
      if (this.followed.size || this.removed.size) this.forgetAll();
      if (now - this.hintScanned >= AGENT_HINT_SCAN_MS) {
        this.hintScanned = now;
        await this.findHints(now);
      }
      return;
    }
    // Turned off later, the hints are found afresh rather than shown from before.
    this.hintScanned = -Infinity;
    if (now - this.scanned >= AGENT_SCAN_MS) {
      this.scanned = now;
      await this.scan(now);
    }
    let budget = this.options.pollBytes ?? AGENT_POLL_BYTES;
    let changed = false;
    for (const [file, followed] of this.followed) {
      if (budget <= 0) break;
      const before = followed.record.events;
      const caughtUp = followed.caughtUp;
      const read = await followed.tail.read(budget, (line) => this.line(file, followed, line));
      budget -= read;
      // What was there until the file was first read to its end is old, however many polls that took: only
      // what is appended later is activity.
      if (read && caughtUp) followed.modifiedAt = now;
      if (followed.tail.offset >= followed.tail.size) followed.caughtUp = true;
      const settled = this.settle(followed, now);
      changed = changed || settled || followed.record.events !== before;
    }
    if (changed) this.state.notify();
  }

  private line(file: string, followed: Followed, line: string): void {
    // A session reloaded while it was being read is read afresh; what the old read finds is dropped.
    if (this.ignored.has(file) || this.followed.get(file) !== followed) return;
    const records = followed.parser.line(line);
    const { cwd } = followed.parser.info;
    if (cwd && !this.folders().some((folder) => within(cwd, folder))) {
      this.ignore(file);
      return;
    }
    // A session found outside this folder's own files shows nothing until it says which folder it worked in, so
    // another project's prompts and commands are never shown, or shared, here.
    if (!records.length || (!cwd && !followed.exact)) return;
    const { record } = followed;
    const label = followed.parser.label;
    if (label) record.command = label;
    if (cwd) record.cwd = cwd;
    Object.assign(record, sessionDetail(followed.parser.info, followed.baseline));
    if (followed.parser.info.startedAt !== undefined) record.startedAt = followed.parser.info.startedAt;
    // A run a clear or pruning removed comes back when its session logs again.
    if (!this.registry.records.has(record.id)) {
      followed.listed = true;
      this.registry.records.set(record.id, record);
    }
    for (const step of records) {
      const event = this.ingestion.accept(JSON.stringify(step), 'agent', {
        serverId: record.serverId,
        server: record.server,
        sessionId: record.id,
      });
      if (event) record.events++;
    }
  }

  /** A session that stopped growing has ended; one that grows again is running again. */
  private settle(followed: Followed, now: number): boolean {
    const idle = now - followed.modifiedAt >= AGENT_IDLE_MS;
    const status = idle ? 'exited' : 'running';
    if (followed.record.status === status) return false;
    followed.record.status = status;
    if (idle) followed.record.endedAt = followed.parser.info.lastAt ?? followed.modifiedAt;
    else delete followed.record.endedAt;
    return followed.listed;
  }

  /** Session files written to in the last day that may have worked in an open folder, newest first. */
  private async recent(now: number): Promise<{ agent: AgentName; file: string; modifiedAt: number; exact: boolean }[]> {
    const folders = this.folders();
    const found: { agent: AgentName; file: string; modifiedAt: number; exact: boolean }[] = [];
    const add = async (agent: AgentName, file: string, exact = false) => {
      if (this.ignored.has(file) || this.followed.has(file)) return;
      try {
        const { mtimeMs } = await fs.stat(file);
        // A session that gave way to newer ones is found again only once it changes.
        const parkedAt = this.parked.get(file)?.parkedAt;
        if (parkedAt !== undefined && mtimeMs <= parkedAt) return;
        if (now - mtimeMs <= AGENT_RECENT_MS) found.push({ agent, file, modifiedAt: mtimeMs, exact });
      } catch {
        /* gone */
      }
    };
    // Claude Code files sessions by folder; a session begun in a subfolder has the folder's name as its prefix.
    const projects = join(this.claudeDir, 'projects');
    const names = folders.map(claudeProjectDir);
    for (const project of await listFolder(projects)) {
      const exact = names.includes(project);
      if (!exact && !names.some((name) => project.startsWith(`${name}-`))) continue;
      for (const name of await listFolder(join(projects, project)))
        if (name.endsWith('.jsonl')) await add('claude-code', join(projects, project, name), exact);
    }
    // Codex files sessions by the day they began: sessions/2026/11/15/rollout-….jsonl.
    const sessions = join(this.codexDir, 'sessions');
    for (const year of (await listFolder(sessions)).sort().reverse().slice(0, 2))
      for (const month of (await listFolder(join(sessions, year))).sort().reverse().slice(0, 2))
        for (const day of (await listFolder(join(sessions, year, month))).sort().reverse().slice(0, 2))
          for (const name of await listFolder(join(sessions, year, month, day)))
            if (name.endsWith('.jsonl')) await add('codex', join(sessions, year, month, day, name));
    // Copilot CLI keeps a folder per session: session-state/<id>/events.jsonl.
    const state = join(this.copilotDir, 'session-state');
    for (const id of await listFolder(state)) await add('copilot', join(state, id, 'events.jsonl'));
    // Copilot Chat keeps this workspace's sessions in its storage: chatSessions/<id>.jsonl.
    const chat = this.chatSessions();
    if (chat)
      for (const name of await listFolder(chat))
        if (name.endsWith('.jsonl')) await add('copilot', join(chat, name), true);
    return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /**
   * Count each agent's sessions in an open folder without following them. A
   * Claude Code session filed under the folder's own name worked there; any
   * other has the folder it worked in read from the start of its file, once.
   */
  private async findHints(now: number): Promise<void> {
    const folders = this.folders();
    const counts = noCounts();
    const recent = await this.recent(now);
    const files = new Set(recent.map(({ file }) => file));
    for (const file of this.cwds.keys()) if (!files.has(file)) this.cwds.delete(file);
    for (const { agent, file, exact } of recent) {
      if (counts[agent] >= AGENT_MAX_SESSIONS) continue;
      const cwd = exact ? undefined : await this.cwdOf(agent, file);
      if (exact || (cwd && folders.some((folder) => within(cwd, folder)))) counts[agent]++;
    }
    const next = AGENT_NAMES.filter((agent) => counts[agent] > 0).map((agent) => ({
      agent,
      label: agentSource(agent).server,
      sessions: counts[agent],
    }));
    if (JSON.stringify(next) === JSON.stringify(this.found)) return;
    this.found = next;
    this.state.notify();
  }

  private async cwdOf(agent: AgentName, file: string): Promise<string | undefined> {
    if (this.cwds.has(file)) return this.cwds.get(file);
    const parser = new AgentSessionParser(agent);
    await new JsonlTail(file).read(AGENT_CWD_BYTES, (line) => {
      if (!parser.info.cwd) parser.line(line);
    });
    this.cwds.set(file, parser.info.cwd);
    return parser.info.cwd;
  }

  private async scan(now: number): Promise<void> {
    const found = await this.recent(now);
    for (const { agent, file, modifiedAt, exact } of found) {
      if (this.removed.has(agent) || !this.makeRoom(agent, modifiedAt, now)) continue;
      const parked = this.parked.get(file);
      if (!parked) this.follow(agent, file, modifiedAt, exact);
      else {
        // It resumed: it goes on from where it was read.
        this.parked.delete(file);
        delete parked.parkedAt;
        this.followed.set(file, parked);
      }
    }
  }

  /**
   * Whether a session written to at `modifiedAt` can be followed: the agent has fewer than its most, or the
   * longest-ended of its sessions is older and gives way to it.
   */
  private makeRoom(agent: AgentName, modifiedAt: number, now: number): boolean {
    let count = 0;
    let oldest: [string, Followed] | undefined;
    for (const entry of this.followed) {
      if (entry[1].agent !== agent) continue;
      count++;
      if (entry[1].record.status === 'exited' && (!oldest || entry[1].modifiedAt < oldest[1].modifiedAt))
        oldest = entry;
    }
    if (count < AGENT_MAX_SESSIONS) return true;
    if (!oldest || oldest[1].modifiedAt >= modifiedAt) return false;
    const [file, followed] = oldest;
    this.followed.delete(file);
    followed.parkedAt = now;
    this.parked.set(file, followed);
    // The longest-parked is let go for good, so it is not read again from its start and logged twice.
    if (this.parked.size > AGENT_MAX_PARKED) {
      const first = this.parked.keys().next().value!;
      this.parked.delete(first);
      this.ignored.add(first);
    }
    return true;
  }

  private follow(agent: AgentName, file: string, modifiedAt: number, exact = false): void {
    const { serverId, server } = agentSource(agent);
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'),
      serverId,
      server,
      status: 'running',
      startedAt: modifiedAt,
      events: 0,
      sourceKind: 'agent',
      owned: false,
      canStop: false,
      captureComplete: false,
    };
    this.followed.set(file, {
      agent,
      tail: new JsonlTail(file),
      parser: this.parser(agent, exact),
      record,
      listed: false,
      modifiedAt,
      exact,
      caughtUp: false,
    });
  }

  private parser(agent: AgentName, exact: boolean): AgentSessionParser {
    const parser = new AgentSessionParser(agent);
    // A Copilot Chat session does not name its folder: it is this workspace's, which has one unless it is multi-root.
    const folders = this.folders();
    if (agent === 'copilot' && exact && folders.length === 1) parser.info.cwd = folders[0];
    return parser;
  }

  private ignore(file: string): void {
    this.ignored.add(file);
    const followed = this.followed.get(file) ?? this.parked.get(file);
    this.followed.delete(file);
    this.parked.delete(file);
    if (followed?.listed && !followed.record.events) this.registry.records.delete(followed.record.id);
  }

  private forgetAll(): void {
    for (const followed of this.sessions()) {
      followed.record.status = 'exited';
      followed.record.captureComplete = true;
    }
    this.followed.clear();
    this.parked.clear();
    this.ignored.clear();
    this.removed.clear();
    this.removedFiles.clear();
    this.scanned = -Infinity;
    this.state.notify();
  }

  /**
   * The logs were cleared: each session goes on from where it was read to, so
   * what was cleared does not come back, and its run counts only what is shown
   * from now on.
   */
  cleared(): void {
    for (const followed of this.sessions()) {
      const { toolCalls, failedCalls, tokens } = followed.parser.info;
      followed.baseline = { toolCalls, failedCalls, tokens: { ...tokens } };
      followed.record.events = 0;
      if (followed.listed) Object.assign(followed.record, sessionDetail(followed.parser.info, followed.baseline));
    }
  }

  /**
   * Read sessions again from their start, such as after a clear: one run's, one
   * agent's by its source, or, with neither, every session's, with removed
   * agents restored. Returns the runs read again; the caller drops their logs.
   */
  reload(target: { serverId?: string; sessionId?: string } = {}): string[] {
    const { serverId, sessionId } = target;
    if (!serverId && !sessionId) this.restore();
    const runs: string[] = [];
    for (const [file, followed] of [...this.followed, ...this.parked]) {
      const { record } = followed;
      if (sessionId ? record.id !== sessionId : serverId && record.serverId !== serverId) continue;
      runs.push(record.id);
      record.events = 0;
      // A parked session is followed again, so its logs come back.
      this.parked.delete(file);
      this.followed.set(file, {
        ...followed,
        tail: new JsonlTail(file),
        parser: this.parser(followed.agent, followed.exact),
        baseline: undefined,
        caughtUp: false,
        parkedAt: undefined,
      });
    }
    // Sessions begun since the last scan are found now, not ten seconds later.
    if (!sessionId) this.scanned = -Infinity;
    return runs;
  }

  /** The transcript a run was read from, while it is followed. */
  transcriptOf(sessionId: string): string | undefined {
    for (const [file, followed] of [...this.followed, ...this.parked])
      if (followed.record.id === sessionId) return file;
    return undefined;
  }

  /**
   * A removed source stays removed: its sessions, and any it starts later, are
   * not read until it is restored, and the rail offers it again.
   */
  stopServer(serverId: string): void {
    const agent = AGENT_NAMES.find((name) => agentSource(name).serverId === serverId);
    let sessions = 0;
    for (const [file, followed] of [...this.followed, ...this.parked])
      if (followed.record.serverId === serverId) {
        if (followed.listed) sessions++;
        if (agent) this.removedFiles.set(file, agent);
        this.ignore(file);
        // Its logs went with the source; restored, the session is read again from its start.
        this.registry.records.delete(followed.record.id);
      }
    if (agent && sessions) {
      this.removed.set(agent, (this.removed.get(agent) ?? 0) + sessions);
      this.state.notify();
    }
  }

  stopSessionById(id: string): void {
    for (const [file, followed] of [...this.followed, ...this.parked]) if (followed.record.id === id) this.ignore(file);
  }

  /** Every session read, followed or parked. */
  private sessions(): Followed[] {
    return [...this.followed.values(), ...this.parked.values()];
  }

  dispose(): void {
    clearInterval(this.timer);
    this.followed.clear();
    this.parked.clear();
  }
}

/** `2h 14m`, `12m`, `40s`: how long a session ran, short enough for the rail. */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
}

/**
 * A session's run: `detail` goes under its name, such as `2h 14m · 42 tools · 3 failed`,
 * and `tooltip` holds what that line leaves out, its tokens and model, as `Label\tvalue`
 * lines the tooltip sets out as a table. Counts are of what
 * it did after `since`; the duration is the whole session's, from the start time beside it.
 */
export function sessionDetail(
  info: AgentCounts & Partial<Pick<AgentSessionInfo, 'startedAt' | 'lastAt' | 'model'>>,
  since?: AgentCounts,
): { detail: string; tooltip: string } {
  const toolCalls = info.toolCalls - (since?.toolCalls ?? 0);
  const failedCalls = info.failedCalls - (since?.failedCalls ?? 0);
  const tokens = (key: keyof AgentTokens) => Math.max(0, info.tokens[key] - (since?.tokens[key] ?? 0));
  const { startedAt, lastAt } = info;
  const detail = [
    startedAt !== undefined && lastAt !== undefined && lastAt > startedAt ? shortDuration(lastAt - startedAt) : '',
    toolCalls ? `${toolCalls} tool${toolCalls === 1 ? '' : 's'}` : '',
    failedCalls ? `${failedCalls} failed` : '',
  ];
  // Cache reads dwarf the rest in a long session, so the tokens are given apart, not summed.
  const spent = [
    tokens('input') ? `${shortCount(tokens('input'))} in` : '',
    tokens('output') ? `${shortCount(tokens('output'))} out` : '',
    tokens('cached') ? `${shortCount(tokens('cached'))} cached` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const tooltip = [spent && `Tokens\t${spent}`, info.model && `Model\t${info.model}`];
  return { detail: detail.filter(Boolean).join(' · '), tooltip: tooltip.filter(Boolean).join('\n') };
}
