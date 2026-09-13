// A minimal JSONC reader for tasks.json: strips // and /* */ comments and
// trailing commas before handing the result to JSON.parse. Not a full JSON5
// parser — just enough tolerance for what VS Code's own tasks.json allows.
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; result += ch; }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      result += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; result += ch; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    result += ch;
  }
  return result;
}

export function parseJsonc(text: string): unknown {
  const withoutComments = stripJsonComments(text);
  let withoutTrailingCommas = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === ',') {
      let next = i + 1;
      while (/\s/.test(withoutComments[next] ?? '')) next++;
      if (withoutComments[next] === '}' || withoutComments[next] === ']') continue;
    }
    withoutTrailingCommas += ch;
  }
  return JSON.parse(withoutTrailingCommas);
}
