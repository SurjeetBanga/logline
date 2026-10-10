import * as vscode from 'vscode';
import type { DebugCapture, DebugSessionInfo } from '../capture/debug-capture';

type SessionLike = Pick<vscode.DebugSession, 'id' | 'name' | 'type' | 'configuration'> & {
  parentSession?: SessionLike;
};
// Requests after which the program runs again.
const RESUMING = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'restart', 'goto']);
type DebugApi = {
  registerDebugAdapterTrackerFactory?: typeof vscode.debug.registerDebugAdapterTrackerFactory;
  onDidTerminateDebugSession?: typeof vscode.debug.onDidTerminateDebugSession;
  stopDebugging?: typeof vscode.debug.stopDebugging;
};

/** Describe a session by its top-level launch configuration, so child sessions and restarts group together. */
export function describeSession(
  session: SessionLike,
  stop?: () => void,
  pause?: () => Promise<boolean>,
): DebugSessionInfo {
  let root = session;
  while (root.parentSession) root = root.parentSession;
  const configuration = (session.configuration ?? {}) as Record<string, unknown>;
  const rootConfiguration = (root.configuration ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const target =
    text(configuration.program) ??
    text(configuration.module) ??
    text(configuration.mainClass) ??
    text(configuration.url) ??
    text(configuration.command);
  return {
    id: session.id,
    name: text(rootConfiguration.name) ?? root.name,
    type: session.type,
    command: target ? `${session.type} · ${target}` : undefined,
    cwd: text(configuration.cwd),
    console: text(configuration.console),
    stop,
    pause,
  };
}

/** Observe every debug adapter's output events and session lifecycle. */
export function registerDebugCapture(capture: DebugCapture): vscode.Disposable[] {
  const debug = (vscode as unknown as { debug?: DebugApi }).debug;
  if (!debug?.registerDebugAdapterTrackerFactory) return [];
  const disposables: vscode.Disposable[] = [
    debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session: vscode.DebugSession) {
        const stop = debug.stopDebugging
          ? () => {
              void debug.stopDebugging!(session);
            }
          : undefined;
        // Whether the program is paused, so a log breakpoint does not ask again.
        let stopped = false;
        const pause = async () => {
          if (stopped || typeof session.customRequest !== 'function') return false;
          const response = (await session.customRequest('threads')) as { threads?: { id?: unknown }[] } | undefined;
          const threadId = response?.threads?.find((thread) => typeof thread.id === 'number')?.id;
          if (threadId === undefined) return false;
          await session.customRequest('pause', { threadId });
          return true;
        };
        capture.start(describeSession(session, stop, pause));
        return {
          onWillReceiveMessage(message: unknown) {
            const request = message as { type?: string; command?: string } | undefined;
            if (request?.type === 'request' && RESUMING.has(request.command ?? '')) stopped = false;
          },
          onDidSendMessage(message: unknown) {
            const event = message as { type?: string; event?: string; body?: Record<string, unknown> } | undefined;
            if (event?.type !== 'event') return;
            if (event.event === 'output') capture.output(session.id, event.body);
            else if (event.event === 'exited') capture.exited(session.id, event.body?.exitCode);
            else if (event.event === 'stopped') stopped = true;
            else if (event.event === 'continued') stopped = false;
          },
          onExit() {
            capture.end(session.id);
          },
        };
      },
    }),
  ];
  if (debug.onDidTerminateDebugSession)
    disposables.push(debug.onDidTerminateDebugSession((session) => capture.end(session.id)));
  return disposables;
}
