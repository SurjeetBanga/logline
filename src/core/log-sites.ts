import { extractExceptions } from './exceptions';
import { findSensitiveValues, hasRequestContext, isQuietFailure, isStructured, type SensitiveKind, type SensitiveValue } from './log-findings';
import { getField } from './query';
import type { LogEvent } from './types';

/** A logging call in source code whose first argument is a string literal. */
export interface LogSite {
  /** Stable while lines move: file, template, and its occurrence within the file. */
  id: string;
  /** Workspace-relative path with `/` separators. */
  file: string;
  /** 1-based position of the logging call. */
  line: number;
  column: number;
  /** Severity implied by the method name, when it has one. */
  level?: string;
  /** The format string with placeholders shown as `…`. */
  template: string;
  /** Literal text between placeholders, in order. */
  literals: string[];
  /** Whether the literals are distinctive enough to attribute a message by text alone. */
  matchable: boolean;
}

export interface SiteMatch { site: LogSite; exact: boolean; }

// Source extensions worth scanning, and those whose strings interpolate `$name`.
export const LOG_SITE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'kts', 'scala', 'groovy', 'go', 'cs', 'rs', 'rb', 'php', 'swift', 'dart', 'cpp', 'cc', 'c', 'h', 'hpp'];
const DOLLAR_INTERPOLATION = new Set(['kt', 'kts', 'scala', 'groovy', 'php', 'dart']);

const METHODS = [
  'log', 'info', 'warn', 'warning', 'error', 'debug', 'trace', 'fatal', 'critical', 'exception', 'verbose', 'notice', 'severe', 'fine',
  'Print', 'Printf', 'Println', 'Info', 'Infof', 'Infow', 'Infoln', 'Warn', 'Warnf', 'Warnw', 'Warning', 'Warningf', 'Error', 'Errorf', 'Errorw',
  'Debug', 'Debugf', 'Debugw', 'Fatal', 'Fatalf', 'Fatalw', 'Panic', 'Panicf', 'Trace', 'Tracef',
  'LogInformation', 'LogWarning', 'LogError', 'LogDebug', 'LogTrace', 'LogCritical', 'Information', 'Verbose', 'WriteLine'
];
// `receiver.method(` where the receiver may chain calls (`zap.L().Info(`),
// or a bare `print(`, or a Rust macro such as `info!(`.
const CALL = new RegExp(String.raw`(?:\b((?:[A-Za-z_$][\w$]*(?:\(\))?\.)+)(${METHODS.join('|')})|\b(print)|\b(info|warn|error|debug|trace|println|eprintln|print|panic)!)\s*\(\s*`, 'g');
const LEVEL_BY_METHOD: Record<string, string> = {
  trace: 'trace', verbose: 'trace', fine: 'trace', debug: 'debug', info: 'info', information: 'info', notice: 'info',
  warn: 'warn', warning: 'warn', error: 'error', exception: 'error', severe: 'error', critical: 'fatal', fatal: 'fatal', panic: 'fatal',
  loginformation: 'info', logwarning: 'warn', logerror: 'error', logdebug: 'debug', logtrace: 'trace', logcritical: 'fatal'
};
const MAX_SITES_PER_FILE = 2000;
const MAX_TEMPLATE = 300;

/** Find logging calls in one source file. */
export function extractLogSites(file: string, text: string): LogSite[] {
  const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const sites: LogSite[] = [];
  const occurrences = new Map<string, number>();
  const lineStarts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lineStarts.push(index + 1);
  const comments = new CommentScanner(text);
  CALL.lastIndex = 0;
  for (let match = CALL.exec(text); match && sites.length < MAX_SITES_PER_FILE; match = CALL.exec(text)) {
    if (comments.covers(match.index, lineStarts[lineOf(lineStarts, match.index).line - 1])) continue;
    const literal = readMessage(text, match.index + match[0].length);
    if (!literal) continue;
    const method = (match[2] ?? match[3] ?? match[4]).replace(/(?:f|w|ln)$/, '').toLowerCase();
    // Plain `print(` and `.log(` carry no severity; method names like Errorf do.
    const level = LEVEL_BY_METHOD[method];
    const parts = splitTemplate(literal.value, literal.interpolated, DOLLAR_INTERPOLATION.has(extension));
    const literals = parts.filter(part => part.trim());
    if (!literals.length) continue;
    const template = parts.join('…').slice(0, MAX_TEMPLATE);
    const position = lineOf(lineStarts, match.index);
    const occurrence = (occurrences.get(template) ?? 0) + 1;
    occurrences.set(template, occurrence);
    const distinctive = literals.join('').replace(/\s+/g, '');
    sites.push({
      id: `${file}\0${template}\0${occurrence}`, file, line: position.line, column: position.column, level, template, literals,
      matchable: distinctive.length >= 6 && literals.some(part => part.replace(/\s+/g, '').length >= 4)
    });
  }
  return sites;
}

// Examples in comments and doc comments are not logging calls. Detection is
// heuristic: `//` after code (but not in a URL), comment-only lines starting
// with `*`, `#` or `--`, and an unclosed `/*` before the call. Calls are
// visited in order, so each line and each comment delimiter is scanned once;
// a minified file is a single long line with thousands of calls.
class CommentScanner {
  private line = -1;
  /** Where the rest of the current line becomes a comment, or Infinity. */
  private lineComment = Infinity;
  private nextSlash: number;
  private nextOpen: number;
  private nextClose: number;
  private lastOpen = -1;
  private lastClose = -1;

  constructor(private readonly text: string) {
    this.nextSlash = text.indexOf('//');
    this.nextOpen = text.indexOf('/*');
    this.nextClose = text.indexOf('*/');
  }

  /** Whether `offset`, on the line starting at `lineStart`, is inside a comment. Offsets must not decrease. */
  covers(offset: number, lineStart: number): boolean {
    if (lineStart !== this.line) {
      this.line = lineStart;
      this.lineComment = this.commentStart(lineStart);
    }
    if (offset >= this.lineComment) return true;
    while (this.nextOpen !== -1 && this.nextOpen <= offset) { this.lastOpen = this.nextOpen; this.nextOpen = this.text.indexOf('/*', this.nextOpen + 1); }
    while (this.nextClose !== -1 && this.nextClose <= offset) { this.lastClose = this.nextClose; this.nextClose = this.text.indexOf('*/', this.nextClose + 1); }
    return this.lastOpen > this.lastClose;
  }

  private commentStart(lineStart: number): number {
    const { text } = this;
    LINE_PREFIX.lastIndex = lineStart;
    if (LINE_PREFIX.test(text)) return LINE_PREFIX.lastIndex;
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    while (this.nextSlash !== -1 && this.nextSlash < lineStart) this.nextSlash = text.indexOf('//', this.nextSlash + 1);
    for (let index = this.nextSlash; index !== -1 && index < lineEnd; index = text.indexOf('//', index + 1)) {
      // `//` right after `:` or a quote is a URL or a string, not a comment.
      if (index === lineStart || !/[:"'`\\]/.test(text[index - 1])) return index + 2;
    }
    return Infinity;
  }
}
const LINE_PREFIX = /[^\S\n]*(?:\*|#(?![{\[])|--)/y;

function lineOf(starts: number[], offset: number): { line: number; column: number } {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

// Reads one string literal, including common prefixes: f"", r"", $"", @"",
// $@"", template literals, and Python triple quotes. Concatenation and
// variables as the first argument are not followed.
function readStringLiteral(text: string, start: number): { value: string; interpolated: boolean; end: number } | undefined {
  let index = start;
  const prefix = text.slice(index, index + 3).match(/^(?:[fFrRbBuU]{1,2}|\$@|@\$|\$|@)?/)![0];
  index += prefix.length;
  const quote = text[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  const triple = quote !== '`' && text.startsWith(quote.repeat(3), index);
  const close = triple ? quote.repeat(3) : quote;
  const raw = /[rR@]/.test(prefix);
  const multiline = triple || quote === '`' || prefix.includes('@');
  index += close.length;
  let value = '';
  const limit = Math.min(text.length, index + 2000);
  while (index < limit) {
    if (text.startsWith(close, index)) {
      return { value, interpolated: quote === '`' || /[fF$]/.test(prefix), end: index + close.length };
    }
    const char = text[index];
    if (char === '\n' && !multiline) return undefined;
    if (char === '\\' && !raw) {
      const next = text[index + 1];
      value += next === 'n' || next === 't' || next === 'r' ? ' ' : next ?? '';
      index += 2;
      continue;
    }
    value += char;
    index++;
  }
  return undefined;
}

// Stands for an expression concatenated into a message; a placeholder like any other.
const EXPRESSION = '\0';
// Calls whose own first argument is the message format.
const WRAPPER = /^(?:String\.format|String\.Format|string\.Format|MessageFormat\.format|fmt\.Sprintf|fmt\.Errorf|util\.format|sprintf|format!)\s*\(\s*/;

/**
 * The message a logging call logs: its first argument, or the second when
 * the first is a context object or marker (`logger.info({ id }, "msg")`).
 * An argument may wrap a format call and concatenate literals with
 * expressions (`"Order " + id + " rejected"`); it needs at least one literal.
 */
function readMessage(text: string, start: number): { value: string; interpolated: boolean } | undefined {
  const first = readArgument(text, start);
  if (first.message) return first.message;
  if (text[first.end] !== ',') return undefined;
  return readArgument(text, skipSpace(text, first.end + 1)).message;
}

function readArgument(text: string, start: number): { message?: { value: string; interpolated: boolean }; end: number } {
  let index = start;
  const wrapper = text.slice(index, index + 40).match(WRAPPER);
  if (wrapper) index += wrapper[0].length;
  let value = '', interpolated = false, literals = 0;
  for (let term = 0; term < 32; term++) {
    const literal = readStringLiteral(text, index);
    if (literal) { value += literal.value; interpolated ||= literal.interpolated; literals++; index = literal.end; }
    else {
      const end = skipExpression(text, index);
      if (end === index) break;
      value += EXPRESSION;
      index = end;
    }
    index = skipSpace(text, index);
    if (text[index] !== '+' || text[index + 1] === '+' || text[index + 1] === '=') break;
    index = skipSpace(text, index + 1);
  }
  return { message: literals ? { value, interpolated } : undefined, end: index };
}

const skipSpace = (text: string, index: number) => { while (index < text.length && /\s/.test(text[index])) index++; return index; };

// Skips one operand of a concatenation (a name, call, member access or
// bracketed expression), stopping at a top-level `+`, `,` or `)`.
function skipExpression(text: string, start: number): number {
  let depth = 0;
  const limit = Math.min(text.length, start + 300);
  for (let index = start; index < limit; index++) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      const literal = readStringLiteral(text, index);
      if (!literal) return start;
      index = literal.end - 1;
    } else if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') { if (depth === 0) return index; depth--; }
    else if (depth === 0 && (char === '+' || char === ',' || char === ';')) return index;
  }
  return start;
}

// Placeholders become empty strings between literal parts. Braces count as
// placeholders in every language (f-strings, C# interpolation and message
// templates, SLF4J and Rust `{}`), as do printf verbs.
const PLACEHOLDER = /\0|\$\{[^}]*\}|#\{[^}]*\}|\{\{|\}\}|\{[^{}]*\}|%%|%(?:\([^)]*\))?[-+ #0]*(?:\d+|\*)?(?:\.\d+)?[sdifoOjJvqxXeEgGtTpcbuUw]/g;

function splitTemplate(value: string, interpolated: boolean, dollar: boolean): string[] {
  const parts: string[] = [''];
  const pattern = dollar ? new RegExp(`${PLACEHOLDER.source}|\\$[A-Za-z_]\\w*`, 'g') : PLACEHOLDER;
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    parts[parts.length - 1] += value.slice(last, match.index);
    last = match.index! + match[0].length;
    const token = match[0];
    if (token === '{{' || token === '}}') parts[parts.length - 1] += token[0];
    else if (token === '%%') parts[parts.length - 1] += '%';
    // A `${…}` in a plain (non-template) string is literal text.
    else if (token.startsWith('${') && !interpolated && !dollar) parts[parts.length - 1] += token;
    else parts.push('');
  }
  parts[parts.length - 1] += value.slice(last);
  return parts;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A query-language filter for one site's messages. Whitespace and quotes
 * are escaped so the regex stays a single search term; the shortest
 * literals are dropped first when the query would exceed its length limit.
 */
export function siteQuery(site: LogSite): string {
  const literals = site.literals.map(part => part.trim()).filter(Boolean);
  const encode = (parts: string[]) => `message:/${parts.map(part => escapeRegex(part).replace(/\s+/g, '\\s+').replace(/"/g, '\\x22')).join('.*')}/`;
  let kept = literals;
  while (kept.length > 1 && encode(kept).length > 256) {
    const shortest = kept.reduce((min, part, index) => part.length < kept[min].length ? index : min, 0);
    kept = kept.filter((_part, index) => index !== shortest);
  }
  return encode(kept).slice(0, 256);
}

/** The code location an event reports about itself: from its capture source or common logger fields. */
export function eventLocation(event: LogEvent): { file: string; line: number } | undefined {
  if (event.location) return event.location;
  const text = (name: string) => { const value = getField(event, name); return typeof value === 'string' && value ? value : undefined; };
  const number = (name: string) => { const value = Number(getField(event, name)); return Number.isSafeInteger(value) && value > 0 ? value : undefined; };
  for (const [fileField, lineField] of [
    ['code.file.path', 'code.line.number'], ['code.filepath', 'code.lineno'], ['log.origin.file.name', 'log.origin.file.line'],
    ['source.file', 'source.line'], ['pathname', 'lineno'], ['filename', 'lineno'], ['file', 'line']
  ]) {
    const file = text(fileField), line = number(lineField);
    if (file && line) return { file, line };
  }
  // zap, go-kit and pino-caller report `path/file.go:42` or `file:///path/x.js:10:5`.
  const caller = text('caller');
  const match = caller?.match(/^(.*?[^\s:]\.[A-Za-z\d]+):(\d+)(?::\d+)?$/);
  if (match) return { file: match[1].replace(/^file:\/\//, ''), line: Number(match[2]) };
  return undefined;
}

const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1);
const normalizePath = (file: string) => file.replace(/\\/g, '/');
const WORD = /[A-Za-z][A-Za-z0-9_]{3,}/g;
const KEY_WORD = /(?<![\w…])[A-Za-z][A-Za-z0-9_]{3,}(?![\w…])/g;

interface Compiled { site: LogSite; parts: RegExp[]; score: number; }

/**
 * Whether the literal parts occur in order, separated by anything. Each part
 * is found at its earliest, shortest occurrence after the previous one, which
 * decides the same as one regex joined by lazy wildcards without its
 * backtracking: that regex takes seconds to fail on a 512-character message
 * repeating most of a template's words.
 */
function inOrder(parts: readonly RegExp[], message: string): boolean {
  let position = 0;
  for (const part of parts) {
    part.lastIndex = position;
    const found = part.exec(message);
    if (!found) return false;
    position = found.index + found[0].length;
  }
  return true;
}

/**
 * All known logging calls in the workspace, with two ways to attribute an
 * event to one: the code location the event reports, or its message text.
 */
export class LogSiteIndex {
  version = 0;
  private readonly files = new Map<string, LogSite[]>();
  private byBasename?: Map<string, LogSite[]>;
  private byWord?: Map<string, Compiled[]>;
  private readonly messageCache = new Map<string, Compiled | null>();
  // Reported locations with no indexed statement, for the editor to index on demand.
  private readonly unresolved = new Set<string>();

  setFile(file: string, sites: LogSite[]): void {
    const previous = this.files.get(file);
    if (!sites.length && !previous) return;
    if (previous && previous.length === sites.length && previous.every((site, index) => site.id === sites[index].id && site.line === sites[index].line)) return;
    if (sites.length) this.files.set(file, sites); else this.files.delete(file);
    this.changed();
  }

  deleteFile(file: string): void { if (this.files.delete(file)) this.changed(); }
  clear(): void { if (this.files.size) { this.files.clear(); this.changed(); } }
  sitesIn(file: string): readonly LogSite[] { return this.files.get(file) ?? []; }
  get size(): number { let count = 0; for (const sites of this.files.values()) count += sites.length; return count; }
  allSites(): IterableIterator<LogSite[]> { return this.files.values(); }

  find(id: string): LogSite | undefined {
    const file = id.slice(0, id.indexOf('\0'));
    return this.files.get(file)?.find(site => site.id === id);
  }

  match(event: LogEvent): SiteMatch | undefined {
    const location = eventLocation(event);
    if (location) {
      const site = this.atLocation(location.file, location.line);
      if (site) return { site, exact: true };
      if (this.unresolved.size < 256) this.unresolved.add(location.file);
    }
    const message = event.message;
    if (!message) return undefined;
    let compiled = this.messageCache.get(message);
    if (compiled === undefined) {
      compiled = this.byMessage(message) ?? null;
      if (this.messageCache.size >= 10000) this.messageCache.clear();
      this.messageCache.set(message, compiled);
    }
    return compiled ? { site: compiled.site, exact: false } : undefined;
  }

  /** Reported file paths that matched no indexed statement since the last call. */
  takeUnresolved(): string[] {
    const files = [...this.unresolved];
    this.unresolved.clear();
    return files;
  }

  /** The site at or just above a reported line in a file matching the reported path's suffix. */
  atLocation(file: string, line: number): LogSite | undefined {
    const path = normalizePath(file);
    const name = basename(path);
    const candidates = this.basenameIndex().get(name) ?? [];
    let best: LogSite | undefined;
    for (const site of candidates) {
      const pathMatches = path === site.file || path.endsWith('/' + site.file) || site.file.endsWith('/' + path);
      // Multi-line calls are reported at the call's first or last line.
      if (!pathMatches || site.line > line || line - site.line > 3) continue;
      if (!best || site.line > best.line) best = site;
    }
    return best;
  }

  private byMessage(message: string): Compiled | undefined {
    const words = new Set(message.match(WORD) ?? []);
    let best: Compiled | undefined;
    let tied = false;
    const seen = new Set<Compiled>();
    for (const word of words) {
      for (const candidate of this.wordIndex().get(word.toLowerCase()) ?? []) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (!inOrder(candidate.parts, message)) continue;
        if (!best || candidate.score > best.score) { best = candidate; tied = false; }
        else if (candidate.score === best.score) tied = true;
      }
    }
    // Two different statements that explain a message equally well are
    // ambiguous; attributing it to either would be a guess.
    return tied ? undefined : best;
  }

  private basenameIndex(): Map<string, LogSite[]> {
    if (this.byBasename) return this.byBasename;
    const index = new Map<string, LogSite[]>();
    for (const sites of this.files.values()) for (const site of sites) {
      const name = basename(site.file);
      const list = index.get(name) ?? [];
      list.push(site);
      index.set(name, list);
    }
    return this.byBasename = index;
  }

  // Each matchable site is filed under the rarest word in its literals, so a
  // message only tests the sites whose key word it contains. Keying on a
  // common word ("Processing", "completed") would put thousands of statements
  // in one bucket and test every message against all of them.
  private wordIndex(): Map<string, Compiled[]> {
    if (this.byWord) return this.byWord;
    const keyed: [LogSite, string[]][] = [];
    const frequency = new Map<string, number>();
    for (const sites of this.files.values()) for (const site of sites) {
      if (!site.matchable) continue;
      // A word touching a placeholder (`cache_miss_` in `cache_miss_{key}`)
      // tokenizes differently in the logged message, so only words with real
      // boundaries in the template can be keys.
      const words = [...new Set(site.template.match(KEY_WORD)?.map(word => word.toLowerCase()))];
      if (!words.length) continue;
      keyed.push([site, words]);
      for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
    const index = new Map<string, Compiled[]>();
    for (const [site, words] of keyed) {
      const key = words.reduce((best, word) => {
        const difference = frequency.get(word)! - frequency.get(best)!;
        return difference < 0 || (difference === 0 && word.length > best.length) ? word : best;
      });
      const parts = site.literals.map(part => new RegExp(escapeRegex(part).replace(/\s+/g, '\\s+?'), 'g'));
      const list = index.get(key) ?? [];
      list.push({ site, parts, score: site.literals.join('').replace(/\s+/g, '').length });
      index.set(key, list);
    }
    return this.byWord = index;
  }

  private changed(): void {
    this.version++;
    this.byBasename = undefined;
    this.byWord = undefined;
    this.messageCache.clear();
  }
}

export interface SiteSample { id: number; level: string; message: string; time?: number; }
export interface SiteStats {
  hits: number; errors: number; lastSeen?: number; samples: SiteSample[]; exact: number;
  /** Collected when findings are on: sensitive values by kind, with the latest event that carried each. */
  sensitive?: Map<SensitiveKind, { value: SensitiveValue; count: number; lastId: number }>;
  /** Error-level events that carried no stack trace or exception. */
  bareErrors?: number;
  /** Events logged as plain text, without structured fields. */
  plain?: number;
  /** Events below warning that describe a failure. */
  quietFailures?: number;
  /** Characters logged, and events cut at the line limit. */
  chars?: number;
  truncated?: number;
  /** Structured warnings and errors without a trace or request id. */
  contextless?: number;
}

/** Per-site counts of retained and newly captured events. */
export class LogSiteTracker {
  readonly stats = new Map<string, SiteStats>();
  /** The newest event id already counted. */
  watermark = 0;
  /** The index version the counts were computed against. */
  indexVersion = -1;
  /** Every event counted, attributed or not; the base for a statement's share of volume. */
  total = 0;
  /** Also collect the evidence log doctor reports. */
  findings = false;
  /** Structured events counted, and how many named their request or trace. */
  structured = 0;
  correlated = 0;
  /** Counts resets, after which an event can be attributed differently. */
  generation = 0;

  constructor(readonly index: LogSiteIndex) { }

  // What each counted event added, oldest first, so evicting an event can
  // subtract it without re-matching every retained event.
  private counted: Counted[] = [];
  private countedHead = 0;

  reset(watermark = 0): void {
    this.stats.clear(); this.watermark = watermark; this.indexVersion = this.index.version; this.total = 0; this.generation++;
    this.structured = 0; this.correlated = 0;
    this.counted = []; this.countedHead = 0;
  }

  /**
   * The site a counted event was attributed to: its id, `null` when it matched
   * no statement, or `undefined` when the event has not been counted.
   */
  siteOf(id: number): string | null | undefined {
    let low = this.countedHead, high = this.counted.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const entry = this.counted[middle];
      if (entry.id === id) return entry.site ?? null;
      if (entry.id < id) low = middle + 1; else high = middle - 1;
    }
    return undefined;
  }

  /** Stop counting events older than `oldestId`; returns whether any site changed. */
  evict(oldestId: number): boolean {
    let changed = false;
    while (this.countedHead < this.counted.length && this.counted[this.countedHead].id < oldestId) {
      const entry = this.counted[this.countedHead++];
      this.total--;
      if (entry.structured) this.structured--;
      if (entry.correlated) this.correlated--;
      if (!entry.site) continue;
      const stats = this.stats.get(entry.site);
      if (!stats) continue;
      changed = true;
      if (!--stats.hits) { this.stats.delete(entry.site); continue; }
      if (entry.exact) stats.exact--;
      if (entry.error) stats.errors--;
      if (entry.bareError) stats.bareErrors!--;
      if (entry.plain) stats.plain!--;
      if (entry.quietFailure) stats.quietFailures!--;
      if (entry.chars) stats.chars! -= entry.chars;
      if (entry.truncated) stats.truncated!--;
      if (entry.contextless) stats.contextless!--;
      for (const kind of entry.sensitive ?? []) {
        const found = stats.sensitive?.get(kind);
        if (found && !--found.count) stats.sensitive!.delete(kind);
      }
    }
    if (this.countedHead > 1024 && this.countedHead * 2 > this.counted.length) {
      this.counted = this.counted.slice(this.countedHead);
      this.countedHead = 0;
    }
    return changed;
  }

  /** Count events in id order; returns whether any site changed. */
  process(events: Iterable<LogEvent>): boolean {
    let changed = false;
    for (const event of events) {
      if (event.id <= this.watermark) continue;
      this.watermark = event.id;
      this.total++;
      const match = this.index.match(event);
      // Whether structured logs usually carry a request id is a property of all of them.
      const context = this.findings ? requestContext(event) : undefined;
      if (context?.structured) this.structured++;
      if (context?.correlated) this.correlated++;
      if (!match) { this.counted.push({ id: event.id, ...context }); continue; }
      let stats = this.stats.get(match.site.id);
      if (!stats) { stats = { hits: 0, errors: 0, samples: [], exact: 0 }; this.stats.set(match.site.id, stats); }
      const entry: Counted = { id: event.id, site: match.site.id, exact: match.exact, error: event.level === 'error' || event.level === 'fatal', ...context };
      stats.hits++;
      if (entry.exact) stats.exact++;
      if (entry.error) stats.errors++;
      stats.lastSeen = event.timestampMs ?? stats.lastSeen;
      stats.samples.push({ id: event.id, level: event.level, message: (event.message ?? '').slice(0, 200), time: event.timestampMs });
      if (stats.samples.length > 3) stats.samples.shift();
      if (this.findings) collectFindings(stats, event, entry);
      this.counted.push(entry);
      changed = true;
    }
    return changed;
  }
}

interface Counted {
  id: number; site?: string; exact?: boolean; error?: boolean;
  sensitive?: SensitiveKind[]; bareError?: boolean; plain?: boolean;
  quietFailure?: boolean; chars?: number; truncated?: boolean; contextless?: boolean;
  structured?: boolean; correlated?: boolean;
}

function requestContext(event: LogEvent): Pick<Counted, 'structured' | 'correlated'> {
  if (!isStructured(event)) return {};
  return hasRequestContext(event) ? { structured: true, correlated: true } : { structured: true };
}

function collectFindings(stats: SiteStats, event: LogEvent, counted: Counted): void {
  for (const value of findSensitiveValues(event)) {
    stats.sensitive ??= new Map();
    const entry = stats.sensitive.get(value.kind);
    if (entry) { entry.count++; entry.lastId = event.id; entry.value = value; }
    else stats.sensitive.set(value.kind, { value, count: 1, lastId: event.id });
    (counted.sensitive ??= []).push(value.kind);
  }
  if ((event.level === 'error' || event.level === 'fatal') && !extractExceptions(event).length) { stats.bareErrors = (stats.bareErrors ?? 0) + 1; counted.bareError = true; }
  if (!event.isJson && !Object.keys(event.fields ?? {}).length) { stats.plain = (stats.plain ?? 0) + 1; counted.plain = true; }
  if (isQuietFailure(event)) { stats.quietFailures = (stats.quietFailures ?? 0) + 1; counted.quietFailure = true; }
  const chars = (event.raw ?? event.message ?? '').length;
  if (chars) { stats.chars = (stats.chars ?? 0) + chars; counted.chars = chars; }
  if (event.truncated) { stats.truncated = (stats.truncated ?? 0) + 1; counted.truncated = true; }
  if (counted.structured && !counted.correlated && ['warn', 'error', 'fatal'].includes(event.level)) {
    stats.contextless = (stats.contextless ?? 0) + 1; counted.contextless = true;
  }
}
