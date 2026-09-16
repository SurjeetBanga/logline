import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProcessRunner } from '../../capture/process-runner';
import type { SessionRegistry } from '../../capture/session-registry';
import type { SessionServer } from '../../capture/types';
import { taskIdentity } from '../../capture/task-identity';
import type { LoglineTaskDefinition } from './definition';

export class LogPseudoTerminal implements vscode.Pseudoterminal {
  runner: ProcessRunner;
  registry: SessionRegistry;
  task: LoglineTaskDefinition;
  folder: vscode.WorkspaceFolder | undefined;
  sessionId: string | undefined;
  writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite = this.writeEmitter.event;
  closeEmitter = new vscode.EventEmitter<number>();
  onDidClose = this.closeEmitter.event;

  constructor(runner: ProcessRunner, registry: SessionRegistry, task: LoglineTaskDefinition, folder: vscode.WorkspaceFolder | undefined) {
    this.runner = runner; this.registry = registry; this.task = task; this.folder = folder;
  }
  open(): void {
    // Args are passed straight through to spawn rather than joined into the
    // command string, so an argument containing a space or quote still works.
    const args = (this.task.args ?? []).map(value => String(value));
    const cwd = this.task.options?.cwd ? String(this.task.options.cwd)
      .replace(/\$\{workspaceFolder\}/g, this.folder?.uri.fsPath ?? '')
      .replace(/\$\{workspaceFolderBasename\}/g, path.basename(this.folder?.uri.fsPath ?? '')) : this.folder?.uri.fsPath;
    const label = this.task.taskName ?? this.task.label ?? this.task.command;
    const dependencies = this.task.dependsOn
      ? (Array.isArray(this.task.dependsOn) ? this.task.dependsOn : [this.task.dependsOn]) : [];
    const taskScope = this.folder?.uri.toString();
    const taskType = this.task.taskType ?? 'logline';
    const dependencyState = this.registry.dependencyState(dependencies, taskScope);
    const server: SessionServer = {
      id: this.task.taskId ?? taskIdentity(label, taskType, taskScope), label,
      jsonOnly: this.task.jsonOnly, shell: this.task.shell, taskName: label, taskType,
      taskScope, taskLabel: this.task.label ?? label,
      dependencies, dependencyState, source: 'logline', sourceKind: 'task', owned: true
    };
    this.sessionId = this.runner.run(String(this.task.command), cwd, server,
      { write: text => this.writeEmitter.fire(text) }, this.task.options?.env, this.task.args !== undefined ? args : undefined,
      code => this.closeEmitter.fire(code));
  }
  close(): void {
    // Target the specific session this open() started, not every session
    // sharing this task's serverId - a later re-run of the same task must
    // not be torn down by a stale close() from this earlier run.
    if (this.sessionId) this.runner.stopSessionById(this.sessionId);
  }
  handleInput(): void { }
}
