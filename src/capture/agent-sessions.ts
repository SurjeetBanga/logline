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
}

interface Followed {
  agent: AgentName;
  tail: JsonlTail;
  parser: AgentSessionParser;
  record: SessionSummary;
  /** In the registry: it has logged something. */
  listed: boolean;
  modifiedAt: number;
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
 * this machine, only while `logline.agentSessions.enabled` is on.
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
    let budget = AGENT_POLL_BYTES;
    let changed = false;
    for (const [file, followed] of this.followed) {
      if (budget <= 0) break;
      const before = followed.record.events;
      const read = await followed.tail.read(budget, (line) => this.line(file, followed, line));
      budget -= read;
      // What was there when the file was first read is old: only what is appended later is activity.
      if (read && followed.tail.offset > read) followed.modifiedAt = now;
      const settled = this.settle(followed, now);
      changed = changed || settled || followed.record.events !== before;
    }
    if (changed) this.state.notify();
  }

  private line(file: string, followed: Followed, line: string): void {
    if (this.ignored.has(file)) return;
    const records = followed.parser.line(line);
    const { cwd } = followed.parser.info;
    if (cwd && !this.folders().some((folder) => within(cwd, folder))) {
      this.ignore(file);
      return;
    }
    if (!records.length) return;
    const { record } = followed;
    const label = followed.parser.label;
    if (label) record.command = label;
    if (cwd) record.cwd = cwd;
    record.detail = sessionDetail(followed.parser.info, followed.baseline);
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
    const counts = noCounts();
    for (const followed of this.followed.values()) counts[followed.agent]++;
    for (const { agent, file, modifiedAt, exact } of found) {
      if (this.removed.has(agent) || counts[agent] >= AGENT_MAX_SESSIONS) continue;
      counts[agent]++;
      this.follow(agent, file, modifiedAt, exact);
    }
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
    const parser = new AgentSessionParser(agent);
    // A Copilot Chat session does not name its folder: it is this workspace's, which has one unless it is multi-root.
    const folders = this.folders();
    if (agent === 'copilot' && exact && folders.length === 1) parser.info.cwd = folders[0];
    this.followed.set(file, {
      agent,
      tail: new JsonlTail(file),
      parser,
      record,
      listed: false,
      modifiedAt,
    });
  }

  private ignore(file: string): void {
    this.ignored.add(file);
    const followed = this.followed.get(file);
    this.followed.delete(file);
    if (followed?.listed && !followed.record.events) this.registry.records.delete(followed.record.id);
  }

  private forgetAll(): void {
    for (const followed of this.followed.values()) {
      followed.record.status = 'exited';
      followed.record.captureComplete = true;
    }
    this.followed.clear();
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
    for (const followed of this.followed.values()) {
      const { toolCalls, failedCalls, tokens } = followed.parser.info;
      followed.baseline = { toolCalls, failedCalls, tokens: { ...tokens } };
      followed.record.events = 0;
      if (followed.listed) followed.record.detail = sessionDetail(followed.parser.info, followed.baseline);
    }
  }

  /** The transcript a run was read from, while it is followed. */
  transcriptOf(sessionId: string): string | undefined {
    for (const [file, followed] of this.followed) if (followed.record.id === sessionId) return file;
    return undefined;
  }

  /**
   * A removed source stays removed: its sessions, and any it starts later, are
   * not read until it is restored, and the rail offers it again.
   */
  stopServer(serverId: string): void {
    const agent = AGENT_NAMES.find((name) => agentSource(name).serverId === serverId);
    let sessions = 0;
    for (const [file, followed] of this.followed)
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
    for (const [file, followed] of this.followed) if (followed.record.id === id) this.ignore(file);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.followed.clear();
  }
}

/** `42 tools · 3 failed · 186k tok`: a session's run, under its name, counting what it did after `since`. */
export function sessionDetail(info: AgentCounts, since?: AgentCounts): string {
  const toolCalls = info.toolCalls - (since?.toolCalls ?? 0);
  const failedCalls = info.failedCalls - (since?.failedCalls ?? 0);
  const sum = ({ tokens }: AgentCounts) => tokens.input + tokens.output + tokens.cached;
  const total = Math.max(0, sum(info) - (since ? sum(since) : 0));
  return [
    `${toolCalls} tool${toolCalls === 1 ? '' : 's'}`,
    failedCalls ? `${failedCalls} failed` : '',
    total ? `${shortCount(total)} tok` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
