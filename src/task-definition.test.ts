import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseJsonc } from './core/jsonc';
import { taskConversionError, taskToLoglineDefinition } from './vscode/tasks/definition';
import { appendTasksToJsonc } from './vscode/tasks/jsonc-edit';

test('process and shell task executions become captured Logline definitions', () => {
  const process = taskToLoglineDefinition({
    name: 'Compile', source: 'npm', definition: { type: 'process' },
    execution: { process: 'node', args: ['script.js', 'path with spaces'], options: { cwd: '${workspaceFolder}' } }
  } as unknown as import('vscode').Task)!;
  assert.equal(process.shell, false);
  assert.deepEqual(process.args, ['script.js', 'path with spaces']);
  assert.equal(process.options?.cwd, '${workspaceFolder}');
  const shell = taskToLoglineDefinition({
    name: 'Watch', source: 'shell', definition: { type: 'shell' },
    execution: { commandLine: 'npm run watch -- --verbose', options: {} }
  } as unknown as import('vscode').Task)!;
  assert.equal(shell.shell, true);
  assert.equal(shell.command, 'npm run watch -- --verbose');
  const customShell = taskToLoglineDefinition({
    name: 'Custom shell', source: 'shell', definition: { type: 'shell' },
    execution: { command: 'echo', args: ['hello'], options: { executable: '/bin/zsh' } }
  } as unknown as import('vscode').Task)!;
  assert.equal(customShell.shell, '/bin/zsh');
});

test('a shell command/args pair is rejoined into one quoted command line', () => {
  const shell = taskToLoglineDefinition({
    name: 'Grep', source: 'shell', definition: { type: 'shell' },
    execution: { command: 'grep', args: ['a value with spaces', { value: 'literal"quote', quoting: 'strong' }], options: {} }
  } as unknown as import('vscode').Task)!;
  assert.equal(shell.shell, true);
  assert.equal(shell.command, 'grep "a value with spaces" "literal\\"quote"');
});

test('appendTasksToJsonc inserts the first entry into an empty tasks array', () => {
  const result = appendTasksToJsonc('{\n  "version": "2.0.0",\n  "tasks": []\n}', [{ label: 'Logline: New' }])!;
  const parsed = JSON.parse(result) as { tasks: { label: string; }[]; };
  assert.deepEqual(parsed.tasks.map(task => task.label), ['Logline: New']);
});

test('appendTasksToJsonc adds a separating comma only when one is not already present', () => {
  const withoutComma = appendTasksToJsonc('{"tasks": [{"label": "Existing"}]}', [{ label: 'New' }])!;
  assert.deepEqual(JSON.parse(withoutComma).tasks.map((t: { label: string; }) => t.label), ['Existing', 'New']);
  const withComma = appendTasksToJsonc('{"tasks": [{"label": "Existing"},]}', [{ label: 'New' }])!;
  assert.equal(/"Existing"\s*,\s*\{/.test(withComma), false, 'a pre-existing trailing comma must not be doubled');
  assert.deepEqual((parseJsonc(withComma) as { tasks: { label: string; }[]; }).tasks.map(t => t.label), ['Existing', 'New']);
});

test('appendTasksToJsonc ignores a commented-out tasks property and nested arrays in existing tasks', () => {
  const text = [
    '{',
    '  // "tasks": ["not this one"]',
    '  "version": "2.0.0",',
    '  "tasks": [',
    '    { "label": "Existing", "problemMatcher": ["$tsc", "$eslint-stylish"] }',
    '  ]',
    '}'
  ].join('\n');
  const result = appendTasksToJsonc(text, [{ label: 'New' }])!;
  const parsed = parseJsonc(result) as { tasks: { label: string; }[]; };
  assert.deepEqual(parsed.tasks.map(task => task.label), ['Existing', 'New']);
});

test('appendTasksToJsonc ignores braces inside string values while locating root tasks', () => {
  const text = '{"description":"value with { braces }", "config":{"tasks":[{"label":"nested"}]}, "tasks":[]}';
  const result = appendTasksToJsonc(text, [{ label: 'root' }])!;
  const parsed = parseJsonc(result) as { tasks: { label: string }[]; config: { tasks: { label: string }[] } };
  assert.deepEqual(parsed.tasks.map(task => task.label), ['root']);
  assert.deepEqual(parsed.config.tasks.map(task => task.label), ['nested']);
});

test('appendTasksToJsonc returns undefined when there is no tasks array to preserve', () => {
  assert.equal(appendTasksToJsonc('{"version": "2.0.0"}', [{ label: 'New' }]), undefined);
});

test('task insertion preserves multiple trailing comments and inserts commas before them', () => {
  for (const comma of ['', ',']) {
    const text = `{ "tasks": [{ "label": "Existing" }${comma} // first\n // second\n /* third */ ] }`;
    const result = appendTasksToJsonc(text, [{ label: 'New' }])!;
    assert.deepEqual((parseJsonc(result) as { tasks: { label: string }[] }).tasks.map(task => task.label), ['Existing', 'New']);
    assert.ok(result.includes('// first\n // second\n /* third */'));
  }
});

test('only shell tasks refused for shellArgs report a conversion error', () => {
  const task = (execution: unknown) => ({ name: 'T', source: 'test', definition: { type: 'custom' }, execution } as unknown as import('vscode').Task);
  assert.equal(taskConversionError(task(undefined)), undefined, 'custom or dependency-only tasks are not candidates');
  assert.equal(taskConversionError(task({ process: 'node', args: [] })), undefined);
  assert.equal(taskConversionError(task({ commandLine: 'npm test' })), undefined);
  assert.match(taskConversionError(task({ commandLine: 'npm test', options: { shellArgs: ['-c'] } }))!, /shellArgs/);
});

test('the tasks.json schema accepts the shell executable a conversion can emit', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const loglineTask = manifest.contributes.taskDefinitions.find((definition: { type: string }) => definition.type === 'logline');
  assert.deepEqual(loglineTask.properties.shell.type, ['boolean', 'string']);
});
