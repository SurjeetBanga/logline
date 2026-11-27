import { createRedactor, type RedactionOptions } from './redaction';

/** A variable as the Debug Adapter Protocol reports it, with its children when they were read. */
export interface SnapshotVariable {
  name: string;
  value: string;
  children?: SnapshotVariable[];
}

export interface SnapshotFrame {
  name: string;
  file: string;
  line: number;
  variables: SnapshotVariable[];
}

export interface SnapshotInput {
  /** The exception's type, such as `KeyError`, when the debugger says. */
  type?: string;
  /** What the debugger says about it: `'card'`, or `Cannot read properties of undefined`. */
  message?: string;
  /** Frames in the program's own code, innermost first. */
  frames: SnapshotFrame[];
}

/** How much of a program's state one snapshot keeps. */
export const SNAPSHOT_LIMITS = { frames: 3, variables: 30, children: 20, value: 200, bytes: 4096 };

// Groups and internals debuggers list among the variables, which say nothing about the program.
const SKIPPED = /^(?:__proto__|\[\[\w+\]\]|special variables|function variables|class variables|protected variables)$/;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** A variable's value as JSON: a number or boolean as itself, a quoted string unquoted, children as an object. */
function valueOf(variable: SnapshotVariable): unknown {
  if (variable.children?.length) {
    const object: Record<string, unknown> = {};
    for (const child of variable.children.slice(0, SNAPSHOT_LIMITS.children))
      if (!SKIPPED.test(child.name)) object[child.name] = valueOf(child);
    return object;
  }
  const value = variable.value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && value.length < 16) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  const quoted = /^(['"])(.*)\1$/s.exec(value);
  return clip(quoted ? quoted[2] : value, SNAPSHOT_LIMITS.value);
}

/**
 * The event a snapshot is recorded as: the exception, where it was raised, and the locals of each frame,
 * redacted like everything Logline hands an agent, and cut to a few kilobytes.
 */
export function snapshotRecord(input: SnapshotInput, redaction: RedactionOptions = {}): Record<string, unknown> {
  const redactor = createRedactor({ ...redaction, enabled: true });
  const frames = input.frames.slice(0, SNAPSHOT_LIMITS.frames).map((frame) => {
    const locals: Record<string, unknown> = {};
    for (const variable of frame.variables.slice(0, SNAPSHOT_LIMITS.variables))
      if (!SKIPPED.test(variable.name)) locals[variable.name] = redactor.value(valueOf(variable), variable.name);
    return { name: frame.name, file: frame.file, line: frame.line, locals };
  });
  const top = frames[0];
  const type = input.type ? clip(input.type, 200) : undefined;
  const message = input.message ? redactor.text(clip(input.message, 500)) : undefined;
  // The innermost frame's locals are top-level fields, so a search reads them as `locals.total:>10`.
  const callers = frames.slice(1);
  const record: Record<string, unknown> = {
    level: 'error',
    message: `Exception: ${[type, message].filter(Boolean).join(' ') || 'raised'}${top ? ` · ${top.name}() ${basename(top.file)}:${top.line}` : ''}`,
    kind: 'exception-snapshot',
    exception: { ...(type ? { type } : {}), ...(message ? { message } : {}) },
    ...(top ? { function: top.name, file: top.file, line: top.line, locals: top.locals } : {}),
    ...(callers.length ? { callers } : {}),
  };
  // Over the budget, outer frames go first, then the innermost frame's last variables.
  while (JSON.stringify(record).length > SNAPSHOT_LIMITS.bytes && callers.length) {
    callers.pop();
    if (!callers.length) delete record.callers;
  }
  const locals = top?.locals;
  if (locals)
    for (const name of Object.keys(locals).reverse()) {
      if (JSON.stringify(record).length <= SNAPSHOT_LIMITS.bytes) break;
      delete locals[name];
    }
  return record;
}

/** What a snapshot event's innermost frame held, for a hover: `in charge(): order = {…}, total = 19.9`. */
export function snapshotSummary(record: unknown, limit = 400): { place: string; text: string } | undefined {
  const snapshot = record as { kind?: unknown; file?: unknown; line?: unknown; function?: unknown; locals?: unknown };
  if (snapshot?.kind !== 'exception-snapshot' || typeof snapshot.file !== 'string' || typeof snapshot.line !== 'number')
    return undefined;
  const locals = snapshot.locals && typeof snapshot.locals === 'object' ? Object.entries(snapshot.locals) : [];
  const text = locals.map(([name, value]) => `${name} = ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const name = typeof snapshot.function === 'string' ? snapshot.function : 'this frame';
  return {
    place: snapshotPlace(snapshot.file, snapshot.line),
    text: clip(`in ${name}(): ${text.join(', ') || 'no locals'}`, limit),
  };
}

/** Where a snapshot or an error was raised, by file name and line, as paths differ between a debugger and a stack. */
export function snapshotPlace(file: string, line: number): string {
  return `${basename(file)}:${line}`;
}

export function basename(file: string): string {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
}
