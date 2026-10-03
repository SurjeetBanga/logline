// logfmt (`level=info msg="request done" durationMs=12`) is the line format of
// Go's slog/logrus text handlers, Heroku router logs and many Ruby and Elixir
// loggers. A line only counts as logfmt when every token is a key=value pair,
// so prose that merely contains an `=` stays plain text. The spec also allows
// bare keys, but accepting them would turn any sentence ending in `a=1 b=2`
// into a structured event, so they are rejected.

const KEY = /^[A-Za-z_@][\w.@/-]*$/;
const NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;
const MAX_PAIRS = 120;

const isSpace = (char: string | undefined) => char === ' ' || char === '\t';

export function parseLogfmt(line: string): Record<string, string | number> | undefined {
  // Cheap rejection before tokenizing: no `=`, or it cannot start with a key.
  if (!line.includes('=')) return undefined;
  const first = line.charCodeAt(0);
  if (!(first === 64 || first === 95 || (first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return undefined;
  const result: Record<string, string | number> = {};
  let pairs = 0;
  let i = 0;
  const length = line.length;
  while (i < length && pairs < MAX_PAIRS) {
    while (isSpace(line[i])) i++;
    if (i >= length) break;
    const keyStart = i;
    while (i < length && line[i] !== '=' && !isSpace(line[i]) && line[i] !== '"') i++;
    const key = line.slice(keyStart, i);
    if (line[i] !== '=' || !KEY.test(key)) return undefined;
    i++;
    let value: string | number;
    if (line[i] === '"') {
      i++;
      let text = '';
      let closed = false;
      while (i < length) {
        const char = line[i];
        if (char === '\\' && i + 1 < length) {
          const next = line[i + 1];
          text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else if (char === '"') {
          closed = true;
          i++;
          break;
        } else {
          text += char;
          i++;
        }
      }
      if (!closed || (i < length && !isSpace(line[i]))) return undefined;
      value = text;
    } else {
      const valueStart = i;
      while (i < length && !isSpace(line[i])) i++;
      const text = line.slice(valueStart, i);
      if (text.includes('"')) return undefined;
      value = NUMBER.test(text) ? Number(text) : text;
    }
    pairs++;
    if (Object.hasOwn(result, key)) continue;
    if (key === '__proto__') Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    else result[key] = value;
  }
  // A single pair (`PATH=/usr/bin`) is as likely to be shell output as a log.
  return pairs >= 2 ? result : undefined;
}
