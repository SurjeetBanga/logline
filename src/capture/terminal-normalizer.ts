/**
 * Incremental normalisation for VS Code shell-integration output. Terminal
 * streams contain control sequences and often split them across chunks, so
 * this deliberately keeps a small amount of state between writes.
 */
export interface TerminalLine { text: string; truncated: boolean; }

export class TerminalNormalizer {
  private pending = '';
  private escape = '';
  private truncated = false;
  private alternateScreen = false;
  private pendingCarriageReturn = false;
  private droppingEscape = false;
  private readonly limit: number;
  private static readonly maxEscape = 4096;
  constructor(private readonly onLine: (line: TerminalLine) => void, limit = 64 * 1024) { this.limit = limit; }

  write(chunk: string): void {
    if (this.droppingEscape) {
      const newline = chunk.search(/[\r\n]/);
      if (newline < 0) return;
      this.droppingEscape = false;
      chunk = chunk.slice(newline + 1);
    }
    let text = this.escape + chunk;
    this.escape = '';
    if (text.length > TerminalNormalizer.maxEscape && text.charCodeAt(0) === 0x1b) {
      // A malformed control sequence must never become an unbounded side
      // buffer. Drop it and resume at the first ordinary character.
      const newline = text.search(/[\r\n]/);
      if (newline < 0) { this.droppingEscape = true; return; }
      text = text.slice(newline + 1);
    }
    if (this.pendingCarriageReturn) {
      if (text.startsWith('\n')) {
        this.pendingCarriageReturn = false;
      } else {
        this.pendingCarriageReturn = false;
        this.pending = '';
        this.truncated = false;
      }
    }
    let plain = '';
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x1b) {
        if (plain) { this.append(plain); plain = ''; }
        const next = text[i + 1];
        if (next === '[') {
          let found = -1;
          for (let j = i + 2; j < text.length; j++) if (/[\x40-\x7e]/.test(text[j])) { found = j; break; }
          if (found < 0) { this.escape = text.slice(i).slice(0, TerminalNormalizer.maxEscape); break; }
          const sequence = text.slice(i, found + 1);
          if (/\x1b\[\?(?:1049|1047|47)h/.test(sequence)) this.alternateScreen = true;
          if (/\x1b\[\?(?:1049|1047|47)l/.test(sequence)) this.alternateScreen = false;
          i = found;
          continue;
        }
        if (next === ']') {
          // OSC strings terminate with BEL or the exact ST pair ESC \.
          let found = -1;
          let endLength = 1;
          for (let j = i + 2; j < text.length; j++) {
            if (text.charCodeAt(j) === 7) { found = j; break; }
            if (text.charCodeAt(j) === 0x1b && text[j + 1] === '\\') { found = j; endLength = 2; break; }
          }
          if (found < 0) { this.escape = text.slice(i).slice(0, TerminalNormalizer.maxEscape); break; }
          i = found + endLength - 1;
          continue;
        }
        // Drop a two-byte escape sequence and retain an incomplete one.
        if (i + 1 >= text.length) { this.escape = text.slice(i, i + TerminalNormalizer.maxEscape); break; }
        i++;
        continue;
      }
      if (code === 13) {
        // Progress bars rewrite the current terminal line. Keep the newest
        // value instead of generating one event per redraw.
        plain && this.append(plain);
        plain = '';
        if (text[i + 1] === '\n') this.pendingCarriageReturn = false;
        else if (i + 1 >= text.length) this.pendingCarriageReturn = true;
        else { this.pending = ''; this.truncated = false; }
        continue;
      }
      if (code === 10) {
        if (plain) this.append(plain);
        plain = '';
        this.emit();
        continue;
      }
      if (code >= 0 && code < 0x20 && code !== 9) continue;
      if (!this.alternateScreen) plain += text[i];
    }
    if (plain) this.append(plain);
  }

  end(): void {
    if (this.escape) { this.escape = ''; }
    if (this.pending) this.emit();
  }

  private append(value: string): void {
    const room = this.limit - this.pending.length;
    if (room <= 0) { this.truncated = true; return; }
    this.pending += value.slice(0, room);
    if (value.length > room) this.truncated = true;
  }

  private emit(): void {
    const text = this.pending.trimEnd();
    if (text || this.truncated) this.onLine({ text, truncated: this.truncated });
    this.pending = '';
    this.truncated = false;
  }
}

/** Conservative severity parsing for unstructured terminal lines. */
export function terminalLevel(text: string): string {
  const match = text.match(/^\s*(?:\[[^\]]+\]\s*)?(?:\d{4}-\d\d?-\d\d?(?:[T ][^ ]+)?\s+)?(?:\[[ ]*)?(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)(?:\s*\]|\b)/i);
  if (!match) return 'unclassified';
  const value = match[1].toLowerCase();
  return value === 'warning' ? 'warn' : value;
}
