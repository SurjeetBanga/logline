// Format validated JSON without materializing huge indentation strings for deep
// or wide objects. Preserve lexical values (including large integer IDs).
export function formatDetails(raw: string, indentation = 2, limit = 256 * 1024): string {
  const width = Math.max(1, Math.min(8, Math.floor(indentation) || 2));
  let output = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const newline = () => '\n' + ' '.repeat(Math.min(depth, 64) * width);
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      output += char;
    } else if (char === '{' || char === '[') {
      output += char;
      depth++;
      let next = i + 1;
      while (/\s/.test(raw[next] ?? '') && next < raw.length) next++;
      if (raw[next] !== '}' && raw[next] !== ']') output += newline();
    } else if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      let previous = i - 1;
      while (previous >= 0 && /\s/.test(raw[previous])) previous--;
      if (raw[previous] !== '{' && raw[previous] !== '[') output += newline();
      output += char;
    } else if (char === ',') output += ',' + newline();
    else if (char === ':') output += ': ';
    else if (!/\s/.test(char)) output += char;
    if (output.length > limit) return output.slice(0, limit) + '\n[Formatted preview truncated]';
  }
  return output;
}
