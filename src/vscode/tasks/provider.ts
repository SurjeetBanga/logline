import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProcessRunner } from '../../capture/process-runner';
import type { SessionRegistry } from '../../capture/session-registry';
import { parseJsonc } from '../../core/jsonc';
import type { LoglineTaskDefinition } from './definition';
import type { TaskLifecycle } from './lifecycle';
import { LogPseudoTerminal } from './terminal';

function makeLoglineTask(runner: ProcessRunner, registry: SessionRegistry, definition: LoglineTaskDefinition, folder: vscode.WorkspaceFolder): vscode.Task {
  const task = new vscode.Task(definition, folder, definition.label || definition.command, 'logline',
    new vscode.CustomExecution(resolved => Promise.resolve(new LogPseudoTerminal(runner, registry, resolved as LoglineTaskDefinition, folder))));
  task.detail = definition.detail;
  task.isBackground = definition.isBackground === true;
  if (definition.problemMatcher !== undefined) {
    task.problemMatchers = Array.isArray(definition.problemMatcher) ? definition.problemMatcher.map(String) : [String(definition.problemMatcher)];
  }
  if (definition.presentation && typeof definition.presentation === 'object') task.presentationOptions = definition.presentation as vscode.TaskPresentationOptions;
  if (definition.runOptions && typeof definition.runOptions === 'object') task.runOptions = definition.runOptions as vscode.RunOptions;
  if (definition.group) {
    const groups = [vscode.TaskGroup.Clean, vscode.TaskGroup.Build, vscode.TaskGroup.Rebuild, vscode.TaskGroup.Test];
    task.group = groups.find(group => group?.id === definition.group);
  }
  return task;
}

export function registerTasks(runner: ProcessRunner, registry: SessionRegistry, lifecycle: TaskLifecycle): vscode.Disposable[] {
  return [
    vscode.tasks.registerTaskProvider('logline', {
      provideTasks: () => {
        return (vscode.workspace.workspaceFolders ?? []).flatMap(folder => {
          try {
            const file = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
            const parsed = parseJsonc(readFileSync(file, 'utf8')) as { tasks?: LoglineTaskDefinition[]; };
            if (!Array.isArray(parsed?.tasks)) return [];
            return parsed.tasks.filter(task => task?.type === 'logline' && typeof task.command === 'string' && task.command)
              .map(task => makeLoglineTask(runner, registry, task, folder));
          } catch { return []; }
        });
      },
      resolveTask: task => {
        const definition = task.definition as LoglineTaskDefinition;
        if (definition?.type !== 'logline' || !definition.command) return undefined;
        const folder = typeof task.scope === 'object' ? task.scope : vscode.workspace.workspaceFolders?.[0];
        return folder ? makeLoglineTask(runner, registry, definition, folder) : undefined;
      }
    }),
    // VS Code exposes task lifecycle and process events, but deliberately does
    // not expose a stream of output for ordinary tasks. These events still give
    // Logline a searchable task timeline and process exit metadata. Converted
    // logline tasks use CustomExecution and are captured line-for-line below.
    vscode.tasks.onDidStartTask(event => lifecycle.captureTaskStart(event.execution)),
    vscode.tasks.onDidStartTaskProcess(event => lifecycle.captureTaskProcessStart(event.execution, event.processId)),
    vscode.tasks.onDidEndTaskProcess(event => lifecycle.captureTaskProcessEnd(event.execution, event.exitCode)),
    vscode.tasks.onDidEndTask(event => lifecycle.captureTaskEnd(event.execution))
  ];
}
