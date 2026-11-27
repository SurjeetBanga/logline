// A Copilot Chat session as VS Code keeps it: workspaceStorage/<id>/chatSessions/<session>.jsonl.
// Its first line is the whole session; each later line changes one part of it,
// such as a request's result or a tool call's outcome. Replaying the lines gives
// the session as it is now, from which what is new since the last line is read.

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

/** How a session file changes the session. */
const Change = { Initial: 0, Set: 1, Push: 2, Delete: 3 } as const;

/** Apply one line of a session file to `state`; returns the session after it. */
export function replayChatLine(state: Json | undefined, entry: Json): Json | undefined {
  if (entry.kind === Change.Initial) return prune(object(entry.v));
  if (!state || !Array.isArray(entry.k) || !entry.k.length) return state;
  const path = entry.k as (string | number)[];
  const parent = walk(state, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent) return state;
  const container = parent as Record<string | number, unknown>;
  switch (entry.kind) {
    case Change.Set:
      container[key] = entry.v;
      break;
    case Change.Push: {
      const list = Array.isArray(container[key]) ? (container[key] as unknown[]) : (container[key] = []);
      // With a start, the items from there are replaced rather than added to.
      if (typeof entry.i === 'number' && entry.i >= 0) list.length = Math.min(list.length, entry.i);
      if (Array.isArray(entry.v)) list.push(...(entry.v as unknown[]));
      break;
    }
    case Change.Delete:
      if (Array.isArray(container)) container.splice(Number(key), 1);
      else delete container[key];
      break;
    default:
      return state;
  }
  return prune(state);
}

function walk(state: unknown, path: (string | number)[]): object | undefined {
  let at: unknown = state;
  for (const key of path) {
    if (!at || typeof at !== 'object') return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at && typeof at === 'object' ? at : undefined;
}

/**
 * Drop what is never read and can be large, such as the prompt sent to the
 * model and each tool's full output, so a long session is cheap to hold.
 */
function prune(state: Json | undefined): Json | undefined {
  const requests = state?.requests;
  if (!Array.isArray(requests)) return state;
  for (const value of requests) {
    const request = object(value);
    if (!request) continue;
    delete request.agent;
    delete request.variableData;
    delete request.contentReferences;
    delete request.codeCitations;
    const metadata = object(object(request.result)?.metadata);
    if (metadata)
      object(request.result)!.metadata =
        typeof metadata.resolvedModel === 'string' ? { resolvedModel: metadata.resolvedModel } : {};
    if (!Array.isArray(request.response)) continue;
    for (const part of request.response) {
      const block = object(part);
      if (!block) continue;
      if (block.kind === 'thinking') block.value = '';
      const details = object(block.resultDetails);
      if (details) block.resultDetails = details.isError === true ? { isError: true } : {};
    }
  }
  return state;
}

/** A tool call in a request's response. */
export interface ChatToolCall {
  id: string;
  tool: string;
  /** What VS Code shows for it, such as `Read [](file:///…/a.ts#1-20), lines 1 to 20`. */
  said: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  at?: number;
  output?: string;
  failed: boolean;
  denied: boolean;
}

/** VS Code's markdown text: a string, or `{ value }`. */
export function markdownText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof object(value)?.value === 'string'
      ? String(object(value)!.value)
      : '';
}

/** The tool calls a request finished, in the order they were made. */
export function finishedTools(request: Json): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  for (const part of Array.isArray(request.response) ? request.response : []) {
    const block = object(part);
    if (block?.kind !== 'toolInvocationSerialized' || block.isComplete !== true) continue;
    const id = typeof block.toolCallId === 'string' ? block.toolCallId : undefined;
    if (!id) continue;
    const data = object(block.toolSpecificData);
    const terminal = data?.kind === 'terminal' ? data : undefined;
    const line = object(terminal?.commandLine);
    const command =
      [line?.userEdited, line?.toolEdited, line?.original, terminal?.command].find(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      ) ?? undefined;
    const state = object(terminal?.terminalCommandState);
    const exitCode = typeof state?.exitCode === 'number' ? state.exitCode : undefined;
    const output = markdownText(object(terminal?.terminalCommandOutput)?.text);
    const denied = object(block.isConfirmed)?.type === 0;
    calls.push({
      id,
      tool: typeof block.toolId === 'string' ? block.toolId : 'tool',
      said: markdownText(block.pastTenseMessage) || markdownText(block.invocationMessage),
      ...(command ? { command } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(typeof state?.duration === 'number' ? { durationMs: state.duration } : {}),
      ...(typeof state?.timestamp === 'number' ? { at: state.timestamp } : {}),
      ...(output ? { output } : {}),
      failed: object(block.resultDetails)?.isError === true || (exitCode !== undefined && exitCode !== 0),
      denied,
    });
  }
  return calls;
}

/** What the model wrote in reply, without its thinking or tool calls. */
export function replyText(request: Json): string {
  return (Array.isArray(request.response) ? request.response : [])
    .map((part) => object(part))
    .filter((part) => part && (part.kind === undefined || part.kind === 'markdownContent'))
    .map((part) => markdownText(part!.kind === 'markdownContent' ? part!.content : part!.value))
    .join('')
    .trim();
}

/** `Read [](file:///shop/a.ts#1-20), lines 1 to 20` as `Read a.ts, lines 1 to 20`, with the first file it names. */
export function plainMessage(said: string, cwd?: string): { text: string; file?: string } {
  let file: string | undefined;
  const text = said
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label: string, target: string) => {
      const path = filePath(target);
      if (path && !file) file = relativeTo(path, cwd);
      return label.trim() || (path ? relativeTo(path, cwd) : target);
    })
    .replace(/`/g, '')
    .trim();
  return { text, ...(file ? { file } : {}) };
}

function filePath(target: string): string | undefined {
  if (!target.startsWith('file://')) return undefined;
  try {
    const path = decodeURIComponent(new URL(target).pathname);
    // file:///c%3A/shop → c:/shop on Windows.
    return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return undefined;
  }
}

function relativeTo(path: string, cwd?: string): string {
  const base = cwd?.replace(/\\/g, '/').replace(/\/+$/, '');
  return base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? path.slice(base.length + 1) : path;
}
