import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseJsonc } from '../../core/jsonc';
import { dependencyNames, dependencyNamesFromValue, taskDefinitionLabel, taskToLoglineDefinition, type LoglineTaskDefinition } from './definition';
import { appendTasksToJsonc } from './jsonc-edit';

export async function convertTask(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust this workspace before converting a task.');
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) { vscode.window.showInformationMessage('Open a workspace before converting a task.'); return; }
  interface ParsedTasksFile { file: string; document: { version?: string; tasks?: unknown[]; }; sourceText?: string; }
  // Keyed by folder URI rather than the WorkspaceFolder object itself, since
  // a Task's `.scope` folder instance isn't guaranteed to be reference-equal
  // to the entries in vscode.workspace.workspaceFolders.
  const parsedByFolder = new Map<string, ParsedTasksFile>();
  // Merge dependsOn refs from every folder's tasks.json, since a picked
  // task's dependency can be declared in a different folder than its own.
  const rawDependencyByRef = new Map<string, string[]>();
  for (const workspaceFolder of folders) {
    const file = path.join(workspaceFolder.uri.fsPath, '.vscode', 'tasks.json');
    let document: { version?: string; tasks?: unknown[]; } = { version: '2.0.0', tasks: [] };
    let sourceText: string | undefined;
    try {
      sourceText = readFileSync(file, 'utf8');
      document = parseJsonc(sourceText) as { version?: string; tasks?: unknown[]; };
      if (!document || typeof document !== 'object') document = { version: '2.0.0', tasks: [] };
      if (!Array.isArray(document.tasks)) document.tasks = [];
    } catch { /* create tasks.json when this folder has no task file yet */ }
    parsedByFolder.set(workspaceFolder.uri.toString(), { file, document, sourceText });
    for (const raw of document.tasks ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Record<string, unknown>;
      const deps = dependencyNamesFromValue(value.dependsOn);
      if (!deps.length) continue;
      for (const key of ['label', 'task', 'script']) if (typeof value[key] === 'string') rawDependencyByRef.set(value[key] as string, deps);
    }
  }
  let tasks: vscode.Task[];
  try { tasks = await vscode.tasks.fetchTasks(); }
  catch (error) {
    vscode.window.showErrorMessage(`Could not read VS Code tasks: ${(error as Error).message}`);
    return;
  }
  const candidates = tasks.filter(task => task.definition?.type !== 'logline' && taskToLoglineDefinition(task));
  if (!candidates.length) { vscode.window.showInformationMessage('No shell, process, node-terminal, or launch pre-task was found.'); return; }
  const picked = await vscode.window.showQuickPick(candidates.map(task => ({
    label: taskDefinitionLabel(task), description: `${task.source} · ${task.definition.type}`, task
  })), { title: 'Convert VS Code task to Logline' });
  if (!picked) return;
  const scopeFolder = typeof picked.task.scope === 'object' ? picked.task.scope : undefined;
  const targetFolder = (scopeFolder && folders.find(f => f.uri.toString() === scopeFolder.uri.toString())) ?? folders[0];
  const { file, document, sourceText } = parsedByFolder.get(targetFolder.uri.toString())!;
  const byName = new Map<string, vscode.Task>();
  const ambiguousNames = new Set<string>();
  // A name shared by two different tasks can't be resolved unambiguously,
  // so drop it entirely rather than let whichever task registered last win.
  const registerName = (key: string, task: vscode.Task) => {
    const existing = byName.get(key);
    if (existing && existing !== task) { ambiguousNames.add(key); return; }
    byName.set(key, task);
  };
  for (const task of tasks) {
    registerName(task.name, task);
    const definition = task.definition as Record<string, unknown>;
    for (const key of ['label', 'task', 'script']) if (typeof definition[key] === 'string') registerName(definition[key] as string, task);
  }
  for (const key of ambiguousNames) byName.delete(key);
  const generated: LoglineTaskDefinition[] = [];
  const generatedByLabel = new Map<string, LoglineTaskDefinition>();
  const convert = (task: vscode.Task): LoglineTaskDefinition | undefined => {
    const label = `Logline: ${taskDefinitionLabel(task)}`;
    const existing = generatedByLabel.get(label);
    if (existing) return existing;
    const definition = taskToLoglineDefinition(task);
    if (!definition) return undefined;
    // Mark before traversing dependencies so a malformed dependency cycle is
    // emitted once and cannot recurse forever.
    generatedByLabel.set(label, definition);
    generated.push(definition);
    const dependencies = dependencyNames(task).length ? dependencyNames(task) : (rawDependencyByRef.get(task.name) ?? []);
    if (dependencies.length) {
      definition.dependsOn = dependencies.map(name => {
        const dependency = byName.get(name);
        const converted = dependency ? convert(dependency) : undefined;
        return converted?.label ?? name;
      });
      if (definition.dependsOn.length === 1) definition.dependsOn = definition.dependsOn[0];
    }
    return definition;
  };
  convert(picked.task);
  const existingLabels = new Set(document.tasks!.map(task => {
    const value = task as Record<string, unknown>;
    return typeof value.label === 'string' ? value.label : undefined;
  }).filter((value): value is string => Boolean(value)));
  const additions = generated.filter(task => !existingLabels.has(task.label!));
  if (!additions.length) {
    vscode.window.showInformationMessage(`Logline task already exists for ${taskDefinitionLabel(picked.task)}.`);
    return;
  }
  document.version ??= '2.0.0';
  document.tasks!.push(...additions);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const preserved = sourceText && appendTasksToJsonc(sourceText, additions);
    writeFileSync(file, preserved ?? (JSON.stringify(document, null, 2) + '\n'), 'utf8');
  } catch (error) {
    vscode.window.showErrorMessage(`Could not write ${path.relative(targetFolder.uri.fsPath, file)}: ${(error as Error).message}`);
    return;
  }
  vscode.window.showInformationMessage(`Converted ${taskDefinitionLabel(picked.task)} to ${additions.length} Logline task${additions.length === 1 ? '' : 's'}.`);
}
