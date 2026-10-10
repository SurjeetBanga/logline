import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    for (const command of ['showLogs', 'runCommand', 'followFile', 'stopCommand', 'export', 'import', 'exportForAI', 'convertTask', 'captureTask', 'showGuide', 'showWhatsNew',
      'enableTerminalCapture', 'disableTerminalCapture', 'manageTerminalCapture', 'shareWithAgent', 'shareSpecificRuns', 'stopSharing', 'askCopilot',
      'startOtlpReceiver', 'stopOtlpReceiver', 'showTrace', 'showQuietLogStatements', 'showLogSite', 'connectAgent', 'showStatus']) {
      assert.ok(commands.includes(`logline.${command}`), `${command} is registered`);
    }
    await vscode.workspace.getConfiguration('logline').update('persistLogs', true, vscode.ConfigurationTarget.Workspace);
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
    const folder = vscode.workspace.workspaceFolders![0];
    const persisted = `${folder.uri.fsPath}/.logline/latest.log`;
    const persistedText = async (text: string) => {
      let captured = '';
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { captured = await readFile(persisted, 'utf8'); } catch { /* persistence flush is asynchronous */ }
        if (captured.includes(text)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return captured;
    };
    assert.match(await persistedText('extension smoke'), /extension smoke/, 'task output is captured in Logline persistence');
    await vscode.commands.executeCommand('logline.stopCommand');

    // Debug capture: a Node debug session's Debug Console output reaches Logline.
    let debugSubscription: vscode.Disposable | undefined;
    try {
      const ended = new Promise<void>((resolve, reject) => {
        debugSubscription = vscode.debug.onDidTerminateDebugSession(session => { if (!session.parentSession && session.name === 'Logline smoke debug') resolve(); });
        timer = setTimeout(() => reject(new Error('Debug session did not finish')), 30000);
      });
      assert.ok(await vscode.debug.startDebugging(folder, {
        type: 'node', request: 'launch', name: 'Logline smoke debug', program: '${workspaceFolder}/app.js', console: 'internalConsole'
      }), 'a Node debug session starts');
      await ended;
    } finally { clearTimeout(timer); debugSubscription?.dispose(); }
    assert.match(await persistedText('smoke debug statement ready'), /smoke debug statement ready/, 'debug output is captured');

    // Log lenses: the statement that printed the debug output shows a hit count.
    const app = vscode.Uri.joinPath(folder.uri, 'app.js');
    await vscode.window.showTextDocument(app);
    let lensTitles: string[] = [];
    const lensDeadline = Date.now() + 15000;
    while (Date.now() < lensDeadline) {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', app) ?? [];
      lensTitles = lenses.map(lens => lens.command?.title ?? '');
      if (lensTitles.some(title => /\bhits?\b/.test(title))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(lensTitles.some(title => /1 hit\b/.test(title)), `the log statement shows its hit (CodeLens: ${lensTitles.join(' | ') || 'none'})`);

    // OpenTelemetry: the receiver accepts an OTLP/JSON log on the configured port.
    await vscode.commands.executeCommand('logline.startOtlpReceiver');
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const body = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'smoke' } }] },
      scopeLogs: [{ logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1000000n), severityNumber: 9, body: { stringValue: 'smoke otel record' }, traceId }] }] }] });
    const send = (path: string, payload: string) => new Promise<number>((resolve, reject) => {
      const post = request({ host: '127.0.0.1', port: Number(process.env.LOGLINE_SMOKE_OTLP_PORT), path, method: 'POST', headers: { 'content-type': 'application/json' } },
        response => { response.resume(); resolve(response.statusCode ?? 0); });
      post.on('error', reject);
      post.end(payload);
    });
    assert.equal(await send('/v1/logs', body), 200, 'the OpenTelemetry receiver accepts OTLP/JSON');
    const metrics = JSON.stringify({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'smoke' } }] },
      scopeMetrics: [{ metrics: [{ name: 'smoke.orders', unit: '{order}', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(Date.now()) * 1000000n), asInt: '3' }] } }] }] }] });
    assert.equal(await send('/v1/metrics', metrics), 200, 'the OpenTelemetry receiver accepts metrics');
    assert.equal(await send('/v1/metrics', '{"resourceMetrics":'), 400, 'malformed metrics are refused');
    assert.match(await persistedText('smoke otel record'), /smoke otel record/, 'received telemetry is captured');
    await vscode.commands.executeCommand('logline.showTrace', traceId);
    await vscode.commands.executeCommand('logline.stopOtlpReceiver');

    // Agents: the installed MCP server runs on the editor's runtime, as Connect Claude Code or Codex registers it, finds
    // this window, and gets its answer. Nothing is shared, so only the window can reply NOT_SHARED; a broken bridge says NOT_CONNECTED.
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'logline_list_shared_sources', arguments: {} } }
    ];
    const output = await new Promise<string>((resolve, reject) => {
      const server = spawn(process.execPath, [join(homedir(), '.logline', 'mcp.js'), '--workspace', folder.uri.fsPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let stdout = '';
      const timeout = setTimeout(() => { server.kill(); reject(new Error(`MCP server did not exit: ${stdout}`)); }, 15000);
      server.stdout.on('data', chunk => { stdout += chunk; });
      server.once('error', reject);
      server.once('exit', () => { clearTimeout(timeout); resolve(stdout); });
      server.stdin.end(requests.map(message => JSON.stringify(message)).join('\n') + '\n');
    });
    const replies = new Map(output.trim().split('\n').map(line => JSON.parse(line) as { id: number; result: any }).map(reply => [reply.id, reply.result]));
    assert.equal(replies.get(2)?.tools?.length, 6, `the MCP server lists the six tools (${output})`);
    assert.match(replies.get(3)?.content?.[0]?.text ?? '', /NOT_SHARED/, `the window answers the MCP server (${output})`);

    // Show Status reads every part of the running controller before it shows the list.
    const status = vscode.commands.executeCommand('logline.showStatus');
    await new Promise(resolve => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await status;

    await writeFile(result, JSON.stringify({ passed: true, checks: ['activation', 'commands', 'webview focus', 'task discovery', 'captured task completion', 'captured task output', 'stop',
      'debug capture', 'log lens', 'OpenTelemetry receiver', 'metrics', 'trace command', 'MCP agent bridge', 'status'] }));
  } catch (error) {
    await writeFile(result, JSON.stringify({ passed: false, error: String(error) }));
    throw error;
  }
}
