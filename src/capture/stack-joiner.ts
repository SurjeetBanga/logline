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

const FRAME = /^\s+at\s+\S/;                                    // Java `\tat a.B(C.java:1)`, Node `    at fn (file.js:1:2)`
const OMITTED = /^\s*\.\.\. \d+ (?:more|common frames omitted)/;
const CAUSE = /^\s*(?:Caused by|Suppressed):\s/;
const TRACEBACK = /^Traceback \(most recent call last\):/;
const CHAINED = /^(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)/;
const INDENTED = /^\s+\S/;
// The final line of a Python traceback: `ValueError: bad input`, `KeyboardInterrupt`.
const PYTHON_RAISE = /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Iteration)\b/;
const MAX_LINES = 1000;

const looksStructured = (line: string) => /^\s*[[{]/.test(line);

/**
 * Optional per-line metadata (such as the code location a debug adapter
 * reported) travels with a line; a joined trace keeps its first line's.
 */
export class StackJoiner<M = undefined> {
  private held?: { text: string; truncated: boolean; lines: number; traceback: boolean; meta?: M };
  private timer?: ReturnType<typeof setTimeout>;

  /**
   * @param flushMs How long a held line may wait for a continuation. Zero
   *   disables the timer, for sources that call end() themselves (imports).
   */
  constructor(private readonly deliver: (line: string, truncated: boolean, meta?: M) => void,
    private readonly limit = 64 * 1024, private readonly flushMs = 100) { }

  write(line: string, truncated: boolean, meta?: M): void {
    const held = this.held;
    if (held && !looksStructured(line) && held.lines < MAX_LINES && held.text.length + 1 + line.length <= this.limit) {
      const traceback = held.traceback || CHAINED.test(line);
      const continues = FRAME.test(line) || OMITTED.test(line) || CAUSE.test(line) || TRACEBACK.test(line) || CHAINED.test(line)
        || (traceback && (INDENTED.test(line) || PYTHON_RAISE.test(line)));
      if (continues) {
        held.text += '\n' + line;
        held.truncated ||= truncated;
        held.lines++;
        // A traceback stays open until its exception line; a chained cause
        // reopens it for the following `Traceback` block.
        held.traceback = TRACEBACK.test(line) || CHAINED.test(line) ? true
          : traceback && !(PYTHON_RAISE.test(line) && !INDENTED.test(line));
        this.schedule();
        return;
      }
    }
    this.flush();
    if (looksStructured(line)) { this.deliver(line, truncated, meta); return; }
    this.held = { text: line, truncated, lines: 1, traceback: TRACEBACK.test(line), meta };
    this.schedule();
  }

  /** Release the held line, if any. */
  flush(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    this.deliver(held.text, held.truncated, held.meta);
  }

  end(): void { this.flush(); }

  private schedule(): void {
    if (!this.flushMs) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }
}
