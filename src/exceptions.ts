import type { LogEvent } from './types';

export interface SourceLocation { file: string; line: number; column: number }
export interface ExceptionLine { text: string; source?: SourceLocation }
export interface ExceptionBlock { title: string; lines: ExceptionLine[] }

// Source locations are data, never command URIs. The host resolves them against
// workspace files before opening an editor.
export function parseSourceLocation(text: string): SourceLocation | undefined {
  const python = text.match(/^\s*File "([^"]+)", line (\d+)/);
  const location = text.match(/\(([^()]+?):(\d+)(?::(\d+))?\)\s*$/)
    ?? text.match(/(?:^\s*at\s+|^\s*)(\S+?):(\d+)(?::(\d+))?\s*$/);
  const match = python ?? location;
  if (!match) return undefined;
  let file = match[1];
  if (file.startsWith('file://')) {
    try {
      const url = new URL(file);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      file = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch { return undefined; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(file) && !/^[A-Za-z]:[\\/]/.test(file)) return undefined;
  if (!/\.[A-Za-z\d]+$/.test(file) || /[\x00-\x1f]/.test(file)) return undefined;
  const line = Number(match[2]);
  const column = Number(match[3] ?? 1);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return undefined;
  return { file, line, column };
}

// JSON key tokens that can lead extractExceptions to emit a block. Anchored on
// the closing quote and colon so a value like "level":"error" is not mistaken
// for an `error` key.
const EXCEPTION_KEY = /"(?:err|error|exception|thrown|cause|rootCause|stack|stack_trace|stackTrace|stacktrace|extendedStackTrace|exception\.[A-Za-z]+)"\s*:/;

export function extractExceptions(event: LogEvent): ExceptionBlock[] {
  if (!event.raw) return [];
  const blocks: ExceptionBlock[] = [];
  let remaining = 64 * 1024;
  const add = (title: string, text: string) => {
    if (!remaining || blocks.length >= 8 || !text) return;
    const clipped = text.slice(0, remaining);
    remaining -= clipped.length;
    const lines = clipped.split(/\r?\n/).slice(0, 300).map(text => ({ text, source: parseSourceLocation(text) }));
    if (clipped.length < text.length || clipped.split(/\r?\n/).length > 300) lines.push({ text: '[Exception preview truncated]', source: undefined });
    blocks.push({ title: title.slice(0, 512), lines });
  };
  if (!event.isJson) {
    if (/\b(?:Error|Exception|Traceback|Caused by:)\b/.test(event.raw) || parseSourceLocation(event.raw)) add('Exception', event.raw);
    return blocks;
  }
  // A structured event can only yield a block through an exception-ish key, an
  // embedded multi-line traceback, or a bare string payload. Checking the raw
  // text for those first lets ordinary events skip the JSON.parse entirely,
  // which is most of the cost of grouping errors across a large retained set.
  if (!EXCEPTION_KEY.test(event.raw) && !event.raw.includes('\\n') && !event.raw.startsWith('"')) return [];
  let value: unknown;
  try { value = JSON.parse(event.raw); } catch { return []; }
  const visit = (value: unknown, label: string, depth: number) => {
    if (depth > 8 || blocks.length >= 8 || !remaining) return;
    if (typeof value === 'string') { add(label, value); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    const description = [object.type ?? object.name ?? object['exception.type'], object.message ?? object.localizedMessage ?? object['exception.message']]
      .filter(part => typeof part === 'string').join(': ') || label;
    const title = label === 'Caused by' ? `Caused by: ${description}` : description;
    const stack = object.stack ?? object.stack_trace ?? object.stackTrace ?? object.stacktrace ?? object['exception.stacktrace'];
    if (typeof stack === 'string') add(title, stack);
    else if (Array.isArray(stack) && stack.every(line => typeof line === 'string')) add(title, stack.join('\n'));
    else if (Array.isArray(object.extendedStackTrace)) {
      const frames = object.extendedStackTrace.slice(0, 300).map(frame => {
        if (!frame || typeof frame !== 'object') return '';
        const item = frame as Record<string, unknown>;
        return `    at ${String(item.class ?? '')}.${String(item.method ?? '')}(${String(item.file ?? 'Unknown Source')}:${String(item.line ?? '')})`;
      }).join('\n');
      add(title, frames || title);
    } else if (label !== 'Exception' || object['exception.message']) {
      add(title, typeof object['exception.message'] === 'string' ? object['exception.message'] : title);
    }
    for (const key of ['err', 'error', 'exception', 'thrown', 'cause', 'rootCause']) {
      if (object[key] !== undefined) visit(object[key], key === 'cause' || key === 'rootCause' ? 'Caused by' : key, depth + 1);
    }
    // Some JSON loggers put the complete traceback directly in the message.
    if (!stack && typeof object.message === 'string' && /\n\s*(?:at\s|File ")/.test(object.message)) add(title, object.message);
  };
  visit(value, 'Exception', 0);
  return blocks;
}
