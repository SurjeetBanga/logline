import type * as vscode from 'vscode';
import { taskIdentity } from '../../capture/task-identity';

export interface LoglineTaskDefinition extends vscode.TaskDefinition {
  label?: string;
  command: string;
  args?: unknown[];
  options?: { cwd?: string; env?: Record<string, string>; };
  /** Run the command through the user's shell. Defaults to argv mode when args are present. */
  shell?: boolean;
  /** Drop non-JSON output for this task only. */
  jsonOnly?: boolean;
  /** Stable id used to group this task's events in the Logs selector. */
  taskId?: string;
  taskName?: string;
  taskType?: string;
  detail?: string;
  isBackground?: boolean;
  problemMatcher?: string | string[];
  presentation?: Record<string, unknown>;
  runOptions?: Record<string, unknown>;
  group?: string;
  dependsOn?: string | string[];
  dependsOrder?: 'sequence' | 'parallel';
}

export type ExecutableTask = vscode.Task & {
  definition: vscode.TaskDefinition & {
    dependsOn?: string | string[];
    dependsOrder?: 'sequence' | 'parallel';
    jsonOnly?: boolean;
  };
};

export function taskDefinitionLabel(task: vscode.Task): string {
  const definition = task.definition as Record<string, unknown>;
  return task.name || (typeof definition.label === 'string' ? definition.label : undefined)
    || (typeof definition.task === 'string' ? definition.task : undefined) || 'VS Code task';
}

export function shellValue(value: string | vscode.ShellQuotedString): string {
  return typeof value === 'string' ? value : value.value;
}

export function quoteShell(value: string): string {
  // A generated command line is only used for ShellExecution tasks. Double
  // quoting keeps spaces and quotes intact on the shells supported by VS Code.
  return /^[A-Za-z0-9_./:=+@%-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function taskToLoglineDefinition(task: vscode.Task): LoglineTaskDefinition | undefined {
  const execution = task.execution;
  if (!execution || !('process' in execution || 'command' in execution || 'commandLine' in execution)) return undefined;
  const definition = task.definition as ExecutableTask['definition'];
  const label = taskDefinitionLabel(task);
  const options = (execution as vscode.ProcessExecution | vscode.ShellExecution).options;
  const base = {
    type: 'logline' as const,
    label: `Logline: ${label}`,
    taskName: label,
    taskId: taskIdentity(label, String(definition.type), typeof task.scope === 'object' ? task.scope.uri.toString() : undefined),
    taskType: String(definition.type),
    detail: task.detail,
    isBackground: task.isBackground || undefined,
    problemMatcher: (task.problemMatchers ?? []).length ? [...(task.problemMatchers ?? [])] : undefined,
    presentation: Object.keys(task.presentationOptions ?? {}).length ? { ...task.presentationOptions } : undefined,
    runOptions: Object.keys(task.runOptions ?? {}).length ? { ...task.runOptions } : undefined,
    group: task.group?.id,
    options: options ? { cwd: options.cwd, env: options.env } : undefined,
    jsonOnly: definition.jsonOnly === true,
    dependsOn: definition.dependsOn,
    dependsOrder: definition.dependsOrder
  };
  if ('process' in execution) {
    return { ...base, command: execution.process, args: [...execution.args], shell: false };
  }
  const shell = execution as vscode.ShellExecution;
  if (shell.commandLine !== undefined) return { ...base, command: shell.commandLine, shell: true };
  const command = shellValue(shell.command);
  const args = shell.args.map(shellValue);
  return { ...base, command: [command, ...args].map(quoteShell).join(' '), shell: true };
}

export function dependencyNames(task: vscode.Task): string[] {
  const value = (task.definition as Record<string, unknown>).dependsOn;
  return dependencyNamesFromValue(value);
}

export function dependencyNamesFromValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? [value] : [];
}
