import * as vscode from 'vscode';
import type { DebugCapture, DebugSessionInfo } from '../capture/debug-capture';
import {
  SNAPSHOT_LIMITS,
  type SnapshotFrame,
  type SnapshotInput,
  type SnapshotVariable,
} from '../core/exception-snapshot';
import { isAppFile } from '../core/runtime-errors';

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

type Request = (command: string, args?: unknown) => Thenable<unknown>;
interface DapVariable {
  name?: unknown;
  value?: unknown;
  variablesReference?: unknown;
}
// How long the debugger may take to answer each request; a slow one is not waited on.
const REQUEST_TIMEOUT_MS = 2000;

function ask(request: Request, command: string, args: unknown): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    Promise.resolve(request(command, args)).then(
      (body) => {
        clearTimeout(timer);
        resolve(body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function variables(
  request: Request,
  reference: unknown,
  depth: number,
  limit: number,
): Promise<SnapshotVariable[]> {
  if (typeof reference !== 'number' || reference <= 0) return [];
  const body = await ask(request, 'variables', { variablesReference: reference, count: limit });
  const list = Array.isArray(body?.variables) ? (body.variables as DapVariable[]).slice(0, limit) : [];
  const read: SnapshotVariable[] = [];
  for (const variable of list) {
    if (typeof variable.name !== 'string') continue;
    const value = typeof variable.value === 'string' ? variable.value : String(variable.value ?? '');
    const children =
      depth > 1 && typeof variable.variablesReference === 'number' && variable.variablesReference > 0
        ? await variables(request, variable.variablesReference, depth - 1, SNAPSHOT_LIMITS.children)
        : undefined;
    read.push({ name: variable.name, value, ...(children?.length ? { children } : {}) });
  }
  return read;
}

/**
 * What the program held where it raised an exception: the exception, and the locals of the innermost frames in
 * its own code, two levels deep. Only reads, while the debugger is stopped; undefined when it tells nothing.
 */
export async function readSnapshot(request: Request, threadId: number): Promise<SnapshotInput | undefined> {
  const [info, trace] = await Promise.all([
    ask(request, 'exceptionInfo', { threadId }),
    ask(request, 'stackTrace', { threadId, startFrame: 0, levels: 20 }),
  ]);
  const stack = Array.isArray(trace?.stackFrames) ? (trace.stackFrames as Record<string, unknown>[]) : [];
  const frames: SnapshotFrame[] = [];
  for (const frame of stack) {
    if (frames.length >= SNAPSHOT_LIMITS.frames) break;
    const file = (frame.source as { path?: unknown } | undefined)?.path;
    if (typeof file !== 'string' || !isAppFile(file) || typeof frame.id !== 'number') continue;
    const scopes = await ask(request, 'scopes', { frameId: frame.id });
    const list = Array.isArray(scopes?.scopes) ? (scopes.scopes as Record<string, unknown>[]) : [];
    // The frame's own scope; globals and scopes the debugger calls expensive are left alone.
    const local = list.find((scope) => scope.expensive !== true && !/global/i.test(String(scope.name ?? '')));
    frames.push({
      name: typeof frame.name === 'string' ? frame.name : 'anonymous',
      file,
      line: typeof frame.line === 'number' ? frame.line : 0,
      variables: local ? await variables(request, local.variablesReference, 2, SNAPSHOT_LIMITS.variables) : [],
    });
  }
  const details = info?.details as { typeName?: unknown; message?: unknown } | undefined;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const type = text(details?.typeName) ?? text(info?.exceptionId);
  const message = text(details?.message) ?? text(info?.description);
  if (!frames.length && !type && !message) return undefined;
  return { type, message, frames };
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
            else if (event.event === 'stopped') {
              stopped = true;
              // Stopped on an exception the user's own exception breakpoints asked for: read what the program
              // held. Logline never pauses or resumes a program for this.
              const threadId = event.body?.threadId;
              if (
                event.body?.reason === 'exception' &&
                typeof threadId === 'number' &&
                typeof session.customRequest === 'function' &&
                capture.snapshots
              )
                void readSnapshot((command, args) => session.customRequest(command, args), threadId).then(
                  (snapshot) => snapshot && capture.snapshot(session.id, snapshot),
                );
            } else if (event.event === 'continued') stopped = false;
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
