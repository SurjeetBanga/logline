import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import type { Ingestion } from '../../capture/ingestion';
import type { RuntimeState } from '../../capture/runtime-state';
import type { SessionRegistry } from '../../capture/session-registry';
import { slugify } from '../../core/server-config';
import type { SessionSummary } from '../../core/types';
import { dependencyNames, taskDefinitionLabel } from './definition';

export class TaskLifecycle {
  readonly executions = new Map<vscode.TaskExecution, SessionSummary>();
  constructor(private readonly registry: SessionRegistry, private readonly ingestion: Ingestion,
    private readonly state: RuntimeState, private readonly hasProcesses: () => boolean) { }
  stop(serverId?: string): void {
    for (const [execution, record] of this.executions) {
      if (serverId && record.serverId !== serverId) continue;
      try { execution.terminate(); } catch { /* task may already have ended */ }
    }
  }
  private taskSummary(execution: vscode.TaskExecution): SessionSummary {
    const existing = this.executions.get(execution);
    if (existing) return existing;
    const task = execution.task;
    const taskName = taskDefinitionLabel(task);
    const definition = task.definition as Record<string, unknown>;
    const deps = dependencyNames(task);
    const record: SessionSummary = {
      id: randomBytes(8).toString('hex'),
      serverId: `task:${slugify(taskName)}`,
      server: taskName,
      status: 'running',
      startedAt: Date.now(),
      events: 0,
      taskName,
      taskType: String(definition.type),
      taskState: 'running',
      dependencies: deps,
      dependencyState: this.registry.dependencyState(deps),
      source: task.source
    };
    this.executions.set(execution, record);
    this.registry.records.set(record.id, record);
    // Keep the command useful in the header when the task is the most recent
    // thing the user started.
    this.state.command = taskName;
    return record;
  }

  private taskLifecycleEvent(record: SessionSummary, message: string, level: string, extra: Record<string, unknown> = {}): void {
    const event = this.ingestion.create(JSON.stringify({
      level, message, taskName: record.taskName, taskType: record.taskType,
      dependencies: record.dependencies, taskState: record.taskState, dependencyState: record.dependencyState,
      exitReason: record.exitReason, ...extra
    }), 'task');
    event.serverId = record.serverId;
    event.server = record.server;
    event.sessionId = record.id;
    event.taskName = record.taskName;
    event.taskType = record.taskType;
    event.dependencies = record.dependencies;
    event.taskState = record.taskState;
    event.dependencyState = record.dependencyState;
    event.exitReason = record.exitReason;
    const extraFields = Object.fromEntries(Object.entries(extra).filter(([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'));
    event.fields = {
      ...(event.fields ?? {}), ...extraFields, taskName: record.taskName ?? '', taskType: record.taskType ?? '',
      dependencies: record.dependencies?.join(', ') ?? '', taskState: record.taskState ?? '', dependencyState: record.dependencyState ?? '',
      ...(record.exitReason ? { exitReason: record.exitReason } : {})
    };
    record.events++;
    this.ingestion.commit(event, true);
    this.state.generation++;
    this.state.notify();
  }

  captureTaskStart(execution: vscode.TaskExecution): void {
    // A Logline CustomExecution is already represented by the real process
    // session created in run(); recording it again would duplicate the task.
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.taskState = 'running';
    this.state.status = `Running task: ${record.taskName}`;
    this.taskLifecycleEvent(record, `Task started: ${record.taskName}`, 'info');
  }

  captureTaskProcessStart(execution: vscode.TaskExecution, processId: number): void {
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.pid = processId;
    record.taskState = 'running';
    this.taskLifecycleEvent(record, `Task process started: ${record.taskName}`, 'debug', { processId });
  }

  captureTaskProcessEnd(execution: vscode.TaskExecution, exitCode: number | undefined): void {
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.exitCode = exitCode;
    record.exitReason = exitCode === undefined ? 'terminated' : `exit code ${exitCode}`;
    record.taskState = exitCode === undefined || exitCode !== 0 ? 'failed' : 'exited';
    if (record.taskState === 'failed') record.status = 'failed';
    this.registry.refreshDependents(record.taskName);
    this.taskLifecycleEvent(record, `Task process ended: ${record.taskName} (${record.exitReason})`, record.status === 'failed' ? 'error' : 'info', { exitCode });
    this.registry.pruneSessionRegistry();
  }

  captureTaskEnd(execution: vscode.TaskExecution): void {
    if (execution.task.definition?.type === 'logline') return;
    const record = this.taskSummary(execution);
    record.endedAt = Date.now();
    if (record.status !== 'failed') record.status = record.exitCode === undefined || record.exitCode === 0 ? 'exited' : 'failed';
    record.taskState = record.status;
    record.exitReason ??= record.status === 'exited' ? 'completed' : 'failed';
    this.registry.refreshDependents(record.taskName);
    this.taskLifecycleEvent(record, `Task ended: ${record.taskName} (${record.exitReason})`, record.status === 'failed' ? 'error' : 'info');
    this.executions.delete(execution);
    if (!this.executions.size && !this.hasProcesses()) {
      this.state.status = `Task ${record.status}: ${record.taskName} (${record.exitReason})`;
      this.state.notify();
    }
    this.registry.pruneSessionRegistry();
  }
}
