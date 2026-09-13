import { StringDecoder } from 'node:string_decoder';

export class LineReader {
  onLine: (line: string, truncated: boolean) => void;
  limit: number;
  pending: string;
  truncated: boolean;
  decoder: StringDecoder;

  constructor(onLine: (line: string, truncated: boolean) => void, limit = 64 * 1024) {
    this.onLine = onLine;
    this.limit = limit;
    this.pending = '';
    this.truncated = false;
    this.decoder = new StringDecoder('utf8');
  }

  write(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }

  consume(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      const room = this.limit - this.pending.length;
      this.pending += text.slice(start, Math.min(end, start + room));
      if (end - start > room) this.truncated = true;
      if (newline === -1) break;
      this.emit();
      start = newline + 1;
    }
  }

  emit(): void {
    const line = this.pending.replace(/\r$/, '');
    if (line || this.truncated) this.onLine(line, this.truncated);
    this.pending = '';
    this.truncated = false;
  }

  end(): void { this.consume(this.decoder.end()); this.emit(); }
}
