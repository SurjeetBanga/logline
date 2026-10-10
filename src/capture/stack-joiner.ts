// Plain-text stack traces arrive one physical line at a time. Left alone, a
// Java or Node exception becomes dozens of unrelated rows, the first of which
// has no frames for exception extraction or error grouping to anchor on. This
// joins recognizable continuation lines onto the line that precedes them so
// the whole trace becomes one event.
//
// Every plain-text line is held briefly, since only the next line can tell
// whether it starts a trace. A JSON line, a non-continuation line, end of
// stream, or the flush timer releases it. Structured (JSON) lines are never
// held or joined.

import { NODE_CRASH_CARET, NODE_CRASH_LOCATION } from '../core/exceptions';

const FRAME = /^\s+at\s+\S/; // Java `\tat a.B(C.java:1)`, Node `    at fn (file.js:1:2)`
const OMITTED = /^\s*\.\.\. \d+ (?:more|common frames omitted)/;
const CAUSE = /^\s*(?:Caused by|Suppressed):\s/;
const TRACEBACK = /^Traceback \(most recent call last\):/;
const CHAINED =
  /^(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)/;
const INDENTED = /^\s+\S/;
// The final line of a Python traceback: `ValueError: bad input`, `KeyboardInterrupt`.
const PYTHON_RAISE = /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Iteration)\b/;
// What Node prints after a crash's frames: the error's own properties
// (`    at f (x.js:1:1) {` … `}`), a hint for thrown non-errors, and its version.
const OPENS_PROPERTIES = /\s\{$/;
const CLOSES_PROPERTIES = /^\}\s*$/; // nested objects close indented
const NODE_HINT = /^\(Use `node --trace-/;
const NODE_VERSION = /^Node\.js v\d+\.\d+\.\d+/;
const MAX_LINES = 1000;

const looksStructured = (line: string) => /^\s*[[{]/.test(line);
// A crash's source line is printed as written and may itself start with a
// bracket, so only a line that parses releases a tentative header.
const isJson = (line: string) => {
  if (!looksStructured(line)) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

/**
 * What the held text expects next. A Node crash block is matched as a unit:
 * its location and source line stay tentative until the caret confirms them,
 * so a lone `path:line` line, or one followed by something else, is released
 * line by line exactly as before.
 */
type Mode = 'trace' | 'traceback' | 'node-source' | 'node-caret' | 'node-error' | 'properties';

interface Held<M> {
  text: string;
  truncated: boolean;
  lines: number;
  mode: Mode;
  /** Set once a frame or confirmed crash header is part of the text. */
  trace: boolean;
  /** The physical lines of a block that is not confirmed yet. */
  tentative?: { text: string; truncated: boolean; meta?: M }[];
  meta?: M;
}

/**
 * Optional per-line metadata (such as the code location a debug adapter
 * reported) travels with a line; a joined trace keeps its first line's.
 */
export class StackJoiner<M = undefined> {
  private held?: Held<M>;
  private timer?: ReturnType<typeof setTimeout>;

  /**
   * @param flushMs How long a held line may wait for a continuation. Zero
   *   disables the timer, for sources that call end() themselves (imports).
   */
  constructor(
    private readonly deliver: (line: string, truncated: boolean, meta?: M) => void,
    private readonly limit = 64 * 1024,
    private readonly flushMs = 100,
  ) {}

  write(line: string, truncated: boolean, meta?: M): void {
    const held = this.held;
    if (held) {
      const mode =
        held.lines < MAX_LINES && held.text.length + 1 + line.length <= this.limit ? next(held, line) : undefined;
      if (mode) {
        held.text += '\n' + line;
        held.truncated ||= truncated;
        held.lines++;
        held.trace ||= FRAME.test(line) || mode === 'node-error';
        if (mode === 'node-caret') held.tentative?.push({ text: line, truncated, meta });
        else held.tentative = undefined;
        held.mode = mode;
        this.schedule();
        return;
      }
      // Releasing a tentative block can leave one of its later lines held,
      // which this line may continue.
      this.release();
      this.write(line, truncated, meta);
      return;
    }
    if (looksStructured(line)) {
      this.deliver(line, truncated, meta);
      return;
    }
    const crash = NODE_CRASH_LOCATION.test(line);
    this.held = {
      text: line,
      truncated,
      lines: 1,
      trace: false,
      meta,
      mode: TRACEBACK.test(line) ? 'traceback' : crash ? 'node-source' : 'trace',
      tentative: crash ? [{ text: line, truncated, meta }] : undefined,
    };
    this.schedule();
  }

  /** Release held lines, if any. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.held) this.release();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  end(): void {
    this.flush();
  }

  /**
   * Deliver the held text. An unconfirmed crash block delivers its first line
   * alone and replays the rest, which may start something of its own.
   */
  private release(): void {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    if (!held.tentative) {
      this.deliver(held.text, held.truncated, held.meta);
      return;
    }
    const [first, ...rest] = held.tentative;
    this.deliver(first.text, first.truncated, first.meta);
    for (const part of rest) this.write(part.text, part.truncated, part.meta);
  }

  private schedule(): void {
    if (!this.flushMs) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }
}

/** The mode after appending `line`, or undefined when it does not continue the held text. */
function next<M>(held: Held<M>, line: string): Mode | undefined {
  switch (held.mode) {
    // The source line is printed as written, so it can look like anything
    // except a JSON log line, which is never held.
    case 'node-source':
      return isJson(line) ? undefined : 'node-caret';
    case 'node-caret':
      return NODE_CRASH_CARET.test(line) ? 'node-error' : undefined;
    // The error line itself: `Error: boom`, `TypeError: x`, or a thrown value.
    case 'node-error':
      return line.trim() && !looksStructured(line) ? 'trace' : undefined;
    case 'properties':
      if (CLOSES_PROPERTIES.test(line)) return 'trace';
      return INDENTED.test(line) ? 'properties' : undefined;
  }
  if (looksStructured(line)) return undefined;
  if (FRAME.test(line) && OPENS_PROPERTIES.test(line)) return 'properties';
  if (held.trace && (NODE_VERSION.test(line) || NODE_HINT.test(line))) return 'trace';
  const traceback = held.mode === 'traceback' || CHAINED.test(line);
  const continues =
    FRAME.test(line) ||
    OMITTED.test(line) ||
    CAUSE.test(line) ||
    TRACEBACK.test(line) ||
    CHAINED.test(line) ||
    (traceback && (INDENTED.test(line) || PYTHON_RAISE.test(line)));
  if (!continues) return undefined;
  // A traceback stays open until its exception line; a chained cause
  // reopens it for the following `Traceback` block.
  const open =
    TRACEBACK.test(line) || CHAINED.test(line) ? true : traceback && !(PYTHON_RAISE.test(line) && !INDENTED.test(line));
  return open ? 'traceback' : 'trace';
}
