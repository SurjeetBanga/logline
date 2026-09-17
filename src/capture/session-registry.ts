import type { LogStore } from '../core/log-store';
import type { ServerConfig, SessionSummary } from '../core/types';

export interface ServerSummary {
  id: string;
  label: string;
  status: 'idle' | 'running' | 'stopping' | 'exited' | 'failed';
  activeSessions: number;
  pid?: number;
  lastSession?: string;
  taskName?: string;
  taskType?: string;
  dependencies?: string[];
  dependencyState?: string;
  exitReason?: string;
}

export class SessionRegistry {
  readonly records = new Map<string, SessionSummary>();
  clearCompleted(): void {
    for (const [id, record] of this.records) if (record.status !== 'running' && record.status !== 'stopping') this.records.delete(id);
  }
  dependencyState(deps: string[], scope?: string): string {
    if (!deps.length) return 'none';
    const records = [...this.records.values()];
    const pending = deps.some(name => {
      const match = records.reduce<SessionSummary | undefined>((latest, record) => {
        if (record.taskScope !== scope || (record.taskName !== name && record.taskLabel !== name)) return latest;
        return !latest || record.startedAt >= latest.startedAt ? record : latest;
      }, undefined);
      return !match || match.taskState === 'running';
    });
    return pending ? 'pending' : 'ready';
  }

  refreshDependents(taskName: string | undefined, scope?: string, taskLabel?: string): void {
    if (!taskName) return;
    for (const record of this.records.values()) {
      if (record.taskState === 'running' && record.taskScope === scope
        && (record.dependencies?.includes(taskName) || (taskLabel !== undefined && record.dependencies?.includes(taskLabel)))) {
        record.dependencyState = this.dependencyState(record.dependencies!, scope);
      }
    }
  }

  pruneSessionRegistry(): void {
    const completed = [...this.records.values()]
      .filter(record => record.status === 'exited' || record.status === 'failed')
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (this.records.size > 100 && completed.length) {
      this.records.delete(completed.shift()!.id);
    }
  }

  sessionSummaries(): Pick<SessionSummary, 'id' | 'server' | 'serverId' | 'status' | 'startedAt' | 'endedAt' | 'taskName' | 'taskType' | 'dependencies' | 'dependencyState' | 'exitReason' | 'sourceKind' | 'owned' | 'canStop' | 'captureComplete' | 'captureStatus' | 'captureReason' | 'command' | 'cwd'>[] {
    return [...this.records.values()].map(record => ({
      id: record.id, server: record.server, serverId: record.serverId,
      startedAt: record.startedAt, endedAt: record.endedAt, status: record.status,
      taskName: record.taskName, taskType: record.taskType, dependencies: record.dependencies,
      dependencyState: record.dependencyState, exitReason: record.exitReason, sourceKind: record.sourceKind,
      owned: record.owned, captureComplete: record.captureComplete, captureStatus: record.captureStatus,
      captureReason: record.captureReason, command: record.command, cwd: record.cwd, canStop: record.canStop
    }));
  }

  serverSummaries(configured: ServerConfig[], store: Pick<LogStore, 'serverIds' | 'serverLabel'>): ServerSummary[] {
    const byId = new Map<string, SessionSummary[]>();
    for (const record of this.records.values()) {
      const records = byId.get(record.serverId) ?? [];
      records.push(record);
      byId.set(record.serverId, records);
    }
    const summaries: ServerSummary[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const records = byId.get(id) ?? [];
      const active = records.filter(record => record.status === 'running' || record.status === 'stopping');
      const last = records.reduce((latest, record) =>
        !latest || (record.endedAt ?? record.startedAt) > (latest.endedAt ?? latest.startedAt) ? record : latest,
        undefined as SessionSummary | undefined);
      const status = active.some(record => record.status === 'stopping') ? 'stopping'
        : active.length ? 'running' : last?.status ?? 'idle';
      const detail = active.at(-1) ?? last;
      summaries.push({
        id, label, status, activeSessions: active.length,
        pid: active.find(record => record.pid !== undefined)?.pid, lastSession: last?.id,
        taskName: detail?.taskName, taskType: detail?.taskType, dependencies: detail?.dependencies,
        dependencyState: detail?.dependencyState, exitReason: detail?.exitReason
      });
    };
    for (const server of configured) add(server.id, server.label);
    for (const record of this.records.values()) add(record.serverId, record.server);
    for (const id of store.serverIds()) add(id, store.serverLabel(id) ?? id);
    return summaries;
  }
}
