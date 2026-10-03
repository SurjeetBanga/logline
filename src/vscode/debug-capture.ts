import * as vscode from 'vscode';
import type { DebugCapture, DebugSessionInfo } from '../capture/debug-capture';
import { missingOtelVariables } from '../core/otel-environment';

type SessionLike = Pick<vscode.DebugSession, 'id' | 'name' | 'type' | 'configuration'> & { parentSession?: SessionLike };
type DebugApi = {
  registerDebugAdapterTrackerFactory?: typeof vscode.debug.registerDebugAdapterTrackerFactory;
  onDidTerminateDebugSession?: typeof vscode.debug.onDidTerminateDebugSession;
  stopDebugging?: typeof vscode.debug.stopDebugging;
  registerDebugConfigurationProvider?: typeof vscode.debug.registerDebugConfigurationProvider;
};

/** Describe a session by its top-level launch configuration, so child sessions and restarts group together. */
export function describeSession(session: SessionLike, stop?: () => void): DebugSessionInfo {
  let root = session;
  while (root.parentSession) root = root.parentSession;
  const configuration = (session.configuration ?? {}) as Record<string, unknown>;
  const rootConfiguration = (root.configuration ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const target = text(configuration.program) ?? text(configuration.module) ?? text(configuration.mainClass)
    ?? text(configuration.url) ?? text(configuration.command);
  return {
    id: session.id,
    name: text(rootConfiguration.name) ?? root.name,
    type: session.type,
    command: target ? `${session.type} · ${target}` : undefined,
    cwd: text(configuration.cwd),
    console: text(configuration.console),
    stop
  };
}

/** Observe every debug adapter's output events and session lifecycle. */
export function registerDebugCapture(capture: DebugCapture): vscode.Disposable[] {
  const debug = (vscode as unknown as { debug?: DebugApi }).debug;
  if (!debug?.registerDebugAdapterTrackerFactory) return [];
  const disposables: vscode.Disposable[] = [
    debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        const stop = debug.stopDebugging ? () => { void debug.stopDebugging!(session); } : undefined;
        capture.start(describeSession(session, stop));
        return {
          onDidSendMessage(message: unknown) {
            const event = message as { type?: string; event?: string; body?: Record<string, unknown> } | undefined;
            if (event?.type !== 'event') return;
            if (event.event === 'output') capture.output(session.id, event.body);
            else if (event.event === 'exited') capture.exited(session.id, event.body?.exitCode);
          },
          onExit() { capture.end(session.id); }
        };
      }
    })
  ];
  if (debug.onDidTerminateDebugSession) disposables.push(debug.onDidTerminateDebugSession(session => capture.end(session.id)));
  return disposables;
}

/**
 * Add OpenTelemetry variables to every launch configuration while the
 * receiver runs. Variables in the configuration or VS Code's environment win.
 */
export function registerDebugEnvironment(variables: () => Record<string, string> | undefined): vscode.Disposable[] {
  const debug = (vscode as unknown as { debug?: DebugApi }).debug;
  if (!debug?.registerDebugConfigurationProvider) return [];
  return [debug.registerDebugConfigurationProvider('*', {
    resolveDebugConfiguration(_folder: unknown, configuration: vscode.DebugConfiguration) {
      const defaults = variables();
      if (!defaults || configuration.request === 'attach') return configuration;
      const env = configuration.env && typeof configuration.env === 'object' && !Array.isArray(configuration.env) ? configuration.env as Record<string, string> : {};
      const added = missingOtelVariables({ ...process.env, ...env }, defaults);
      if (Object.keys(added).length) configuration.env = { ...added, ...env };
      return configuration;
    }
  })];
}
