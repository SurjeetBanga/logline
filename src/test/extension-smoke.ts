import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';

/** Run inside a temporary VS Code Extension Development Host. */
export async function run(): Promise<void> {
  const result = process.env.LOGLINE_SMOKE_RESULT!;
  try {
    const extension = vscode.extensions.getExtension('surjeetbanga.logline');
    assert.ok(extension, 'development extension is installed');
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands();
    for (const command of ['showLogs', 'runCommand', 'stopCommand', 'export', 'import', 'exportForAI', 'convertTask', 'captureTask', 'showGuide', 'showWhatsNew']) {
      assert.ok(commands.includes(`logline.${command}`), `${command} is registered`);
    }
    await vscode.commands.executeCommand('logline.showLogs');
    const task = (await vscode.tasks.fetchTasks({ type: 'logline' })).find(task => task.name === 'Logline smoke');
    assert.ok(task, 'task provider discovers JSONC configuration');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: vscode.Disposable | undefined;
    try {
      const ended = new Promise<void>((resolve, reject) => {
        subscription = vscode.tasks.onDidEndTask(event => { if (event.execution.task.name === task.name) resolve(); });
        timer = setTimeout(() => reject(new Error('Captured task did not finish')), 15000);
      });
      await vscode.tasks.executeTask(task);
      await ended;
    } finally { clearTimeout(timer); subscription?.dispose(); }
    await vscode.commands.executeCommand('logline.stopCommand');
    await writeFile(result, JSON.stringify({ passed: true, checks: ['activation', 'commands', 'webview focus', 'task discovery', 'captured task completion', 'stop'] }));
  } catch (error) {
    await writeFile(result, JSON.stringify({ passed: false, error: String(error) }));
    throw error;
  }
}
