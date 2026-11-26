import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionParser, agentSource, claudeProjectDir, within, type AgentName } from '../core/agent-session';
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

export interface AgentSessionsOptions {
  claudeDir?: string;
  codexDir?: string;
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
}

/**
 * Agent sessions as logs: each Claude Code or Codex session that worked in an
 * open folder is a run, under one source per agent, with a log line for each
 * prompt, tool call, and reply. It reads the transcripts the agents keep on
 * this machine, only while `logline.agentSessions.enabled` is on.
 */
export class AgentSessionCapture {
  /** The open workspace folders; sessions in other folders are left alone. */
  folders: () => string[] = () => [];
  private readonly followed = new Map<string, Followed>();
  /** Session files that belong to another folder, or whose source was removed. */
  private readonly ignored = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanned = -Infinity;
  private polling?: Promise<void>;
  private readonly claudeDir: string;
  private readonly codexDir: string;

  constructor(
    private readonly config: Settings,
    private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion,
    private readonly state: RuntimeState,
    private readonly options: AgentSessionsOptions = {},
  ) {
    this.claudeDir = options.claudeDir ?? join(homedir(), '.claude');
    this.codexDir = options.codexDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.timer = setInterval(() => void this.poll(), AGENT_POLL_MS);
    this.timer.unref?.();
  }

  get enabled(): boolean {
    return this.config.get('agentSessions.enabled', false);
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
    if (!this.enabled) {
      if (this.followed.size) this.forgetAll();
      return;
    }
    const now = this.now();
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
    if (followed.parser.info.startedAt !== undefined) record.startedAt = followed.parser.info.startedAt;
    if (!followed.listed) {
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

  private async scan(now: number): Promise<void> {
    const folders = this.folders();
    const found: { agent: AgentName; file: string; modifiedAt: number }[] = [];
    const add = async (agent: AgentName, file: string) => {
      if (this.ignored.has(file) || this.followed.has(file)) return;
      try {
        const { mtimeMs } = await fs.stat(file);
        if (now - mtimeMs <= AGENT_RECENT_MS) found.push({ agent, file, modifiedAt: mtimeMs });
      } catch {
        /* gone */
      }
    };
    // Claude Code files sessions by folder; a session begun in a subfolder has the folder's name as its prefix.
    const projects = join(this.claudeDir, 'projects');
    const names = folders.map(claudeProjectDir);
    for (const project of await listFolder(projects)) {
      if (!names.some((name) => project === name || project.startsWith(`${name}-`))) continue;
      for (const name of await listFolder(join(projects, project)))
        if (name.endsWith('.jsonl')) await add('claude-code', join(projects, project, name));
    }
    // Codex files sessions by the day they began: sessions/2026/11/15/rollout-….jsonl.
    const sessions = join(this.codexDir, 'sessions');
    for (const year of (await listFolder(sessions)).sort().reverse().slice(0, 2))
      for (const month of (await listFolder(join(sessions, year))).sort().reverse().slice(0, 2))
        for (const day of (await listFolder(join(sessions, year, month))).sort().reverse().slice(0, 2))
          for (const name of await listFolder(join(sessions, year, month, day)))
            if (name.endsWith('.jsonl')) await add('codex', join(sessions, year, month, day, name));
    found.sort((a, b) => b.modifiedAt - a.modifiedAt);
    const counts: Record<AgentName, number> = { 'claude-code': 0, codex: 0 };
    for (const followed of this.followed.values()) counts[followed.agent]++;
    for (const { agent, file, modifiedAt } of found) {
      if (counts[agent] >= AGENT_MAX_SESSIONS) continue;
      counts[agent]++;
      this.follow(agent, file, modifiedAt);
    }
  }

  private follow(agent: AgentName, file: string, modifiedAt: number): void {
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
      parser: new AgentSessionParser(agent),
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
    this.scanned = -Infinity;
    this.state.notify();
  }

  /** A removed source stays removed: its sessions are no longer read. */
  stopServer(serverId: string): void {
    for (const [file, followed] of this.followed) if (followed.record.serverId === serverId) this.ignore(file);
  }

  stopSessionById(id: string): void {
    for (const [file, followed] of this.followed) if (followed.record.id === id) this.ignore(file);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.followed.clear();
  }
}
