/**
 * Debug log lines that Logline writes into source code: which logging call a
 * file already uses, the line to insert for an expression, where it goes, and
 * how to find the inserted lines again to remove them. Every inserted line
 * ends with a marker comment, so removal never touches code a person wrote.
 */

export const INSERT_MARKER = 'logline';

type Family =
  | 'js'
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'scala'
  | 'groovy'
  | 'csharp'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'dart';

const FAMILY_BY_EXTENSION: Record<string, Family> = {
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  mts: 'js',
  cts: 'js',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',
  cs: 'csharp',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
};

const HASH_COMMENT = new Set<Family>(['python', 'ruby']);

export function insertFamily(file: string): Family | undefined {
  return FAMILY_BY_EXTENSION[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
}

/** The languages Insert Log writes, as file extensions. */
export const INSERT_EXTENSIONS = Object.keys(FAMILY_BY_EXTENSION);

/** A logging call found in a file: `logger.info`, `slog.Info`, `$log->debug`, `info!`. */
export interface LogCall {
  /** What comes before the method, including its separator: `logger.`, `$this->logger->`, or empty for a macro. */
  receiver: string;
  /** A quiet-level method in the receiver's own spelling: `debug`, `Info`, `LogDebug`, `info!`. */
  method: string;
  /** The first argument is an object literal (`logger.info({ id }, "msg")`), as with pino and bunyan. */
  objectFirst: boolean;
}

const LEVEL_METHODS = [
  'trace',
  'debug',
  'info',
  'log',
  'warn',
  'warning',
  'error',
  'Trace',
  'Debug',
  'Info',
  'Warn',
  'Error',
  'Tracef',
  'Debugf',
  'Infof',
  'Warnf',
  'Errorf',
  'Debugw',
  'Infow',
  'Warnw',
  'Errorw',
  'Information',
  'Warning',
  'Verbose',
  'LogTrace',
  'LogDebug',
  'LogInformation',
  'LogWarning',
  'LogError',
];
// Groups: 1 receiver, 2 method, 3 an object literal as the first argument, 4 a Rust macro.
const CALL = new RegExp(
  String.raw`((?:\$?[A-Za-z_]\w*(?:\(\))?(?:\.|->|::))+)(${LEVEL_METHODS.join('|')})\s*\(\s*(\{)?|\b(trace|debug|info|warn|error)!\s*\(`,
  'g',
);
// A debug line uses a quiet level; warnings and errors would set off alerts and error counts.
// A receiver whose last name is the console or names a log: `console.`, `this.logger.`, `$log->`, `Log::`.
const LOG_RECEIVER = /(?:^|[.>:$])(?:console|\w*log\w*)(?:\(\))?(?:\.|->|::)$/i;
const QUIET = /^(?:log|trace|debug|info|information|verbose|logtrace|logdebug|loginformation)[fw]?!?$/i;

/**
 * The logging call a file uses most, with a quiet method in its spelling, or
 * undefined when the file logs nothing yet. `console.log` counts too, so a
 * file that only uses the console keeps using it.
 */
export function detectLogCall(text: string): LogCall | undefined {
  const counts = new Map<string, { call: LogCall; count: number }>();
  CALL.lastIndex = 0;
  let scanned = 0;
  for (let match = CALL.exec(text); match && scanned < 5000; match = CALL.exec(text), scanned++) {
    // `log` is also a logarithm, as in Math.log and math.log: it counts only on a receiver named for logging.
    if (match[2] === 'log' && !LOG_RECEIVER.test(match[1])) continue;
    const receiver = match[4] ? '' : match[1];
    const method = match[4] ? `${match[4]}!` : match[2];
    const entry = counts.get(receiver) ?? { call: { receiver, method: '', objectFirst: false }, count: 0 };
    counts.set(receiver, entry);
    entry.count++;
    if (!entry.call.method && QUIET.test(method)) entry.call.method = method;
    if (match[3]) entry.call.objectFirst = true;
  }
  let best: { call: LogCall; count: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  if (!best) return undefined;
  const call = best.call;
  // A receiver seen only at warn or error gets the info method in its own spelling.
  if (!call.method) {
    if (call.receiver === '') call.method = 'info!';
    else if (call.receiver === 'console.') call.method = 'log';
    else if (/^Log(?:\.|::)$/.test(call.receiver)) call.method = /::$/.test(call.receiver) ? 'info' : 'Information';
    else
      call.method =
        /^[A-Z]|slog\.$/.test(call.receiver) || /^[A-Z]/.test(firstMethod(text, call.receiver)) ? 'Info' : 'info';
  }
  return call;
}

function firstMethod(text: string, receiver: string): string {
  const index = text.indexOf(receiver);
  return index === -1 ? '' : text.slice(index + receiver.length, index + receiver.length + 1);
}

export interface InsertRequest {
  /** Workspace-relative or absolute path; only its extension and basename are used. */
  file: string;
  /** The whole document. */
  text: string;
  /** 0-based line the cursor is on. */
  line: number;
  /** The selected expression, or the word at the cursor; empty logs that the line was reached. */
  expression: string;
}

export interface Insertion {
  /** 0-based line the new line is inserted before. */
  line: number;
  /** The full new line, without a trailing newline. */
  text: string;
  /** The literal message the line logs, which its CodeLens strips from what it shows. */
  label: string;
}

/** The line Insert Log adds, and where. Undefined for languages it does not write. */
export function planInsertion(request: InsertRequest): Insertion | undefined {
  const family = insertFamily(request.file);
  if (!family) return undefined;
  const lines = request.text.split(/\r?\n/);
  const cursor = Math.min(Math.max(0, request.line), lines.length - 1);
  const expression = request.expression.trim();
  const { line, indent } = placement(lines, cursor, family);
  const scope = enclosingScope(lines, cursor, family) ?? basename(request.file);
  const label = expression ? `${scope}: ${expression}` : `${scope}: reached line ${line + 1}`;
  const statement = buildStatement(family, detectLogCall(request.text), label, expression, request.text);
  const comment = HASH_COMMENT.has(family) ? '#' : '//';
  return { line, text: `${indent}${statement} ${comment} ${INSERT_MARKER}`, label };
}

function basename(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  return name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
}

/**
 * A label as a string literal that interpolates nothing. `format` also
 * escapes what the call's format string would read as a placeholder.
 */
function quote(label: string, family: Family, format = false): string {
  if (family === 'php' || family === 'ruby') return `'${label.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (family === 'dart') return `'${label.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
  let escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (family === 'kotlin' || family === 'groovy') escaped = escaped.replace(/\$/g, '\\$');
  if (format && (family === 'python' || family === 'go')) escaped = escaped.replace(/%/g, '%%');
  if (family === 'rust' || (format && family === 'csharp')) escaped = escaped.replace(/\{/g, '{{').replace(/\}/g, '}}');
  return `"${escaped}"`;
}

// The key a structured value is logged under: the expression itself when it
// is a plain name, otherwise its last name (`order.items` → `items`).
function fieldName(expression: string): string {
  const names = expression.match(/[A-Za-z_]\w*/g);
  return names?.[names.length - 1] ?? 'value';
}

const isIdentifier = (expression: string) => /^[A-Za-z_$][\w$]*$/.test(expression);
// The label followed by a format placeholder, as one string literal.
const formatted = (label: string, family: Family, placeholder: string) =>
  `${quote(`${label}=`, family, true).slice(0, -1)}${placeholder}"`;

function buildStatement(
  family: Family,
  call: LogCall | undefined,
  label: string,
  expression: string,
  text: string,
): string {
  const message = quote(label, family);
  const name = fieldName(expression);
  const target = call ? `${call.receiver}${call.method}` : '';
  switch (family) {
    case 'js': {
      if (!call || call.receiver === 'console.') {
        const method = call?.method ?? 'log';
        return expression ? `console.${method}(${message}, ${expression});` : `console.${method}(${message});`;
      }
      if (!expression) return `${target}(${message});`;
      const object = isIdentifier(expression) ? `{ ${expression} }` : `{ ${name}: ${expression} }`;
      return call.objectFirst ? `${target}(${object}, ${message});` : `${target}(${message}, ${object});`;
    }
    case 'python': {
      if (!call) return expression ? `print(${quote(`${label} =`, family)}, repr(${expression}))` : `print(${message})`;
      const method = call.method === 'log' ? 'info' : call.method;
      return expression
        ? `${call.receiver}${method}(${formatted(label, family, '%r')}, ${expression})`
        : `${call.receiver}${method}(${message})`;
    }
    case 'go': {
      if (call && /w$/.test(call.method)) {
        return expression ? `${target}(${message}, ${JSON.stringify(name)}, ${expression})` : `${target}(${message})`;
      }
      if (call && /f$/.test(call.method)) {
        return expression ? `${target}(${formatted(label, family, '%+v')}, ${expression})` : `${target}(${message})`;
      }
      if (call && call.receiver !== 'log.' && call.receiver !== 'fmt.') {
        if (!expression) return `${target}(${message})`;
        // zap's Logger takes typed fields; slog and the rest take key-value pairs.
        const field = text.includes('go.uber.org/zap')
          ? `zap.Any(${JSON.stringify(name)}, ${expression})`
          : `${JSON.stringify(name)}, ${expression}`;
        return `${target}(${message}, ${field})`;
      }
      const printf = !text.includes('"log"') && text.includes('"fmt"') ? 'fmt.Printf' : 'log.Printf';
      const newline = printf === 'fmt.Printf' ? '\\n' : '';
      return expression
        ? `${printf}(${formatted(label, family, `%+v${newline}`)}, ${expression})`
        : `${printf}(${quote(label, family, true).slice(0, -1)}${newline}")`;
    }
    case 'java':
    case 'groovy':
    case 'scala':
    case 'kotlin': {
      const semi = family === 'java' ? ';' : '';
      if (call && !/^System\.(?:out|err)\.$/.test(call.receiver)) {
        const method = call.method === 'log' ? 'info' : call.method;
        return expression
          ? `${call.receiver}${method}(${formatted(label, family, '{}')}, ${expression})${semi}`
          : `${call.receiver}${method}(${message})${semi}`;
      }
      const print = family === 'java' ? 'System.out.println' : 'println';
      return expression ? `${print}(${message} + " = " + ${expression})${semi}` : `${print}(${message})${semi}`;
    }
    case 'csharp': {
      if (call && call.receiver !== 'Console.') {
        const hole = /^Log/.test(call.method) ? name[0].toUpperCase() + name.slice(1) : 'Value';
        return expression
          ? `${target}(${formatted(label, family, `{@${hole}}`)}, ${expression});`
          : `${target}(${quote(label, family, true)});`;
      }
      return expression ? `Console.WriteLine(${message} + " = " + ${expression});` : `Console.WriteLine(${message});`;
    }
    case 'rust': {
      const macro = call && call.receiver === '' ? call.method.slice(0, -1) : 'eprintln';
      return expression ? `${macro}!(${formatted(label, family, '{:?}')}, ${expression});` : `${macro}!(${message});`;
    }
    case 'ruby': {
      const print = call ? `${call.receiver}${call.method === 'log' ? 'info' : call.method}` : 'puts';
      return expression ? `${print}(${message} + " = " + (${expression}).inspect)` : `${print}(${message})`;
    }
    case 'php': {
      if (call && /(?:->|::)$/.test(call.receiver)) {
        const method = call.method === 'log' ? 'debug' : call.method;
        return expression
          ? `${call.receiver}${method}(${message}, ['${name}' => ${expression}]);`
          : `${call.receiver}${method}(${message});`;
      }
      return expression ? `error_log(${message} . ' = ' . print_r(${expression}, true));` : `error_log(${message});`;
    }
    case 'swift': {
      if (call) {
        const method = call.method === 'log' ? 'info' : call.method;
        return expression
          ? `${call.receiver}${method}("${quote(label, family).slice(1, -1)} = \\(String(describing: ${expression}))")`
          : `${call.receiver}${method}(${message})`;
      }
      return expression ? `print(${quote(`${label} =`, family)}, ${expression})` : `print(${message})`;
    }
    case 'dart': {
      const print = call ? `${call.receiver}${call.method === 'log' ? 'info' : call.method}` : 'print';
      return expression ? `${print}(${message} + ' = \${${expression}}');` : `${print}(${message});`;
    }
  }
}

const indentOf = (line: string) => line.match(/^\s*/)![0];
const EXITS = /^\s*(?:return|throw|raise|break|continue|yield|panic!?|exit|die)\b/;
const BLOCK_START =
  /^\s*(?:(?:pub(?:\([^)]*\))?|export|async|static|public|private|protected|internal|override|suspend|open)\s+)*(?:func|fn|fun|function|if|else|elif|for|foreach|while|until|unless|switch|match|loop|try|catch|except|finally|with|def|do|unsafe|impl|using|lock|select|case|when)\b/;

// Whether a line ends by opening a block of statements, rather than an
// object, array, or argument list that continues on the next line.
function opensBlock(text: string, family: Family): boolean {
  const code = text.replace(family === 'python' || family === 'ruby' ? /\s*#.*$/ : /\s*\/\/.*$/, '');
  if (family === 'python') return /:\s*$/.test(code) && !/^\s*class\b/.test(code);
  if (family === 'ruby')
    return (
      /\bdo(?:\s*\|[^|]*\|)?\s*$|\bthen\s*$/.test(code) || /^\s*(?:def|if|unless|while|until|case|begin)\b/.test(code)
    );
  if (!/\{\s*$/.test(code)) return false;
  return (
    /(?:\)|=>|->\s*[^{]*|\belse|\btry|\bfinally|\bdo)\s*\{\s*$/.test(code) ||
    BLOCK_START.test(code) ||
    /\bfunction\b/.test(code)
  );
}

/**
 * Where the new line goes: inside a block the cursor's line opens, after the
 * statement the cursor is on (followed across lines until its brackets
 * close), or before a line that leaves the function, since code after it
 * would never run.
 */
function placement(lines: string[], line: number, family: Family): { line: number; indent: string } {
  const current = lines[line] ?? '';
  if (EXITS.test(current)) return { line, indent: indentOf(current) };
  if (/^\s*[}\])]/.test(current) && !opensBlock(current, family))
    return { line, indent: indentOf(current) + unit(lines) };
  let end = line;
  if (!opensBlock(current, family)) {
    let depth = 0;
    for (let index = line; index < Math.min(lines.length, line + 50); index++) {
      depth += bracketDelta(lines[index], family);
      end = index;
      if (depth <= 0) break;
      // A multi-line statement that ends by opening a block, such as a call taking a callback.
      if (index > line && opensBlock(lines[index], family)) break;
    }
    if (depth > 0 && !opensBlock(lines[end], family)) end = line;
  }
  if (opensBlock(lines[end] ?? '', family)) {
    const next = lines.slice(end + 1).find((text) => text.trim());
    const indent =
      next !== undefined && indentOf(next).length > indentOf(current).length
        ? indentOf(next)
        : indentOf(current) + unit(lines);
    return { line: end + 1, indent };
  }
  return { line: end + 1, indent: indentOf(current) };
}

// The indentation step the file uses, from its first indented line.
function unit(lines: string[]): string {
  for (const text of lines) {
    const indent = indentOf(text);
    if (indent && text.trim()) return indent.startsWith('\t') ? '\t' : indent.length >= 4 ? '    ' : indent;
  }
  return '  ';
}

// Opening minus closing brackets outside strings and line comments.
function bracketDelta(text: string, family: Family): number {
  let delta = 0;
  let open = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (open) {
      if (char === '\\') index++;
      else if (char === open) open = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') open = char;
    else if (char === '/' && text[index + 1] === '/') break;
    else if (char === '#' && HASH_COMMENT.has(family)) break;
    else if (char === '(' || char === '[' || char === '{') delta++;
    else if (char === ')' || char === ']' || char === '}') delta--;
  }
  return delta;
}

const SCOPES: RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:def|fn|func|fun|sub)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|final|export|default|suspend|open)\s+)*(?:[\w<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^={;]+)?\s*(?:throws\s+[\w.,\s]+)?\{\s*$/,
];
// A method whose opening brace is on the next line, as C# and some Java put it.
const BRACE_ON_NEXT_LINE = new RegExp(SCOPES[3].source.replace(String.raw`\{\s*$`, '$'));
const NOT_SCOPES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'return',
  'else',
  'foreach',
  'using',
  'lock',
]);

/** The function the cursor is in, by looking upward for a declaration less indented than the cursor's line. */
export function enclosingScope(lines: string[], line: number, family?: Family): string | undefined {
  const start = lines[line] ?? '';
  let limit = indentOf(start).length;
  // The declaration line itself names the function the new line goes into.
  for (let index = line; index >= Math.max(0, line - 400); index--) {
    const text = lines[index];
    if (!text.trim() || (index !== line && /^\s*\{\s*$/.test(text))) continue;
    const indent = indentOf(text).length;
    if (index !== line && indent >= limit) continue;
    limit = Math.min(limit, indent);
    const braceNext = lines[index + 1]?.trim() === '{';
    for (const pattern of braceNext ? [...SCOPES, BRACE_ON_NEXT_LINE] : SCOPES) {
      const match = text.match(pattern);
      if (match && !NOT_SCOPES.has(match[1])) return match[1];
    }
    if (indent === 0 && index !== line && family !== 'python') return undefined;
  }
  return undefined;
}

const MARKED = new RegExp(String.raw`(?:\/\/|#)\s*${INSERT_MARKER}\s*$`);

/** Whether a line is one Insert Log wrote. */
export function isInsertedLine(text: string): boolean {
  return MARKED.test(text);
}

/** 0-based lines Insert Log wrote. */
export function insertedLines(text: string): number[] {
  if (!text.includes(INSERT_MARKER)) return [];
  const found: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (isInsertedLine(line)) found.push(index);
  });
  return found;
}

// Keys loggers add to every event, which say nothing about the logged value.
const META = new Set([
  'level',
  'lvl',
  'severity',
  'time',
  'ts',
  'timestamp',
  '@timestamp',
  'msg',
  'message',
  'pid',
  'hostname',
  'host',
  'v',
  'name',
  'logger',
  'caller',
  'source',
  'file',
  'line',
  'service',
  'traceId',
  'spanId',
  'trace_id',
  'span_id',
]);

/**
 * What an inserted line logged, for its CodeLens: the structured fields it
 * added, or the text after its label. `label` is the line's literal message.
 */
export function loggedValue(
  event: { message?: string; raw?: string; isJson?: boolean; fields?: Record<string, string | number | boolean> },
  label: string,
  limit = 80,
): string | undefined {
  let value: string | undefined;
  if (event.isJson && event.raw) {
    try {
      const parsed = JSON.parse(event.raw) as Record<string, unknown>;
      const own = Object.entries(parsed).filter(([key]) => !META.has(key));
      if (own.length === 1) value = compact(own[0][1]);
      else if (own.length) value = compact(Object.fromEntries(own));
    } catch {
      /* not JSON after all; fall back to the message */
    }
  }
  if (value === undefined && !event.isJson && event.fields) {
    // Key-value output such as logfmt: the fields the line added.
    const own = Object.entries(event.fields).filter(([key]) => !META.has(key));
    if (own.length === 1) value = compact(own[0][1]);
    else if (own.length) value = own.map(([key, field]) => `${key}=${compact(field)}`).join(' ');
  }
  if (value === undefined && event.message) {
    const message = event.message;
    const at = label ? message.indexOf(label) : -1;
    const rest = (at === -1 ? message : message.slice(at + label.length)).replace(/^\s*(?:=|:)?\s*/, '');
    value = rest || undefined;
  }
  if (value === undefined) return undefined;
  value = value.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function compact(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
