export function appendTasksToJsonc(text: string, additions: unknown[]): string | undefined {
  let open = -1;
  // Find the real property token first. A regex can accidentally match a
  // commented example such as // "tasks": [], which would edit the comment.
  let objectDepth = 0;
  let arrayDepth = 0;
  let scanLineComment = false;
  let scanBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (scanLineComment) { if (char === '\n') scanLineComment = false; continue; }
    if (scanBlockComment) { if (char === '*' && next === '/') { scanBlockComment = false; i++; } continue; }
    if (char === '/' && next === '/') { scanLineComment = true; i++; continue; }
    if (char === '/' && next === '*') { scanBlockComment = true; i++; continue; }
    if (char === '"') {
      const start = i++;
      let escaped = false;
      for (; i < text.length; i++) {
        if (escaped) { escaped = false; continue; }
        if (text[i] === '\\') { escaped = true; continue; }
        if (text[i] === '"') break;
      }
      if (objectDepth !== 1 || arrayDepth !== 0 || text.slice(start + 1, i) !== 'tasks') continue;
      let value = i + 1;
      while (/\s/.test(text[value] ?? '')) value++;
      if (text[value] !== ':') continue;
      value++;
      while (/\s/.test(text[value] ?? '')) value++;
      if (text[value] === '[') { open = value; break; }
      continue;
    }
    if (char === '{') { objectDepth++; continue; }
    if (char === '}') { objectDepth--; continue; }
    if (char === '[') { arrayDepth++; continue; }
    if (char === ']') { arrayDepth--; continue; }
  }
  if (open < 0) return undefined;
  let depth = 0;
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let lastToken = '[';
  let lastTokenEnd = open + 1;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { quote = false; lastToken = char; lastTokenEnd = i + 1; }
      continue;
    }
    if (char === '"') { quote = true; continue; }
    if (char === '/' && next === '/') { lineComment = true; i++; continue; }
    if (char === '/' && next === '*') { blockComment = true; i++; continue; }
    if (char === '[') depth++;
    if (char === ']' && --depth === 0) {
      const serialized = JSON.stringify(additions, null, 2).slice(1, -1);
      const comma = lastToken !== '[' && lastToken !== ',' ? ',' : '';
      return text.slice(0, lastTokenEnd) + comma + text.slice(lastTokenEnd, i) + serialized + text.slice(i);
    }
    if (!/\s/.test(char)) { lastToken = char; lastTokenEnd = i + 1; }
  }
  return undefined;
}
