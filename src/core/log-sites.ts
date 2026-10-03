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
  CALL.lastIndex = 0;
  for (let match = CALL.exec(text); match && sites.length < MAX_SITES_PER_FILE; match = CALL.exec(text)) {
    const literal = readStringLiteral(text, match.index + match[0].length);
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
function readStringLiteral(text: string, start: number): { value: string; interpolated: boolean } | undefined {
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
      return { value, interpolated: quote === '`' || /[fF$]/.test(prefix) };
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

// Placeholders become empty strings between literal parts. Braces count as
// placeholders in every language (f-strings, C# interpolation and message
// templates, SLF4J and Rust `{}`), as do printf verbs.
const PLACEHOLDER = /\$\{[^}]*\}|#\{[^}]*\}|\{\{|\}\}|\{[^{}]*\}|%%|%(?:\([^)]*\))?[-+ #0]*(?:\d+|\*)?(?:\.\d+)?[sdifoOjJvqxXeEgGtTpcbuUw]/g;

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

interface Compiled { site: LogSite; regex: RegExp; score: number; }

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
        if (!candidate.regex.test(message)) continue;
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

  // Each matchable site is filed under the longest word in its literals, so
  // a message only tests the sites whose key word it contains.
  private wordIndex(): Map<string, Compiled[]> {
    if (this.byWord) return this.byWord;
    const index = new Map<string, Compiled[]>();
    for (const sites of this.files.values()) for (const site of sites) {
      if (!site.matchable) continue;
      const words = site.literals.join(' ').match(WORD);
      if (!words) continue;
      const key = words.reduce((longest, word) => word.length > longest.length ? word : longest).toLowerCase();
      const regex = new RegExp(site.literals.map(part => escapeRegex(part).replace(/\s+/g, '\\s+')).join('[^]*?'));
      const list = index.get(key) ?? [];
      list.push({ site, regex, score: site.literals.join('').replace(/\s+/g, '').length });
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
export interface SiteStats { hits: number; errors: number; lastSeen?: number; samples: SiteSample[]; exact: number; }

/** Per-site counts of retained and newly captured events. */
export class LogSiteTracker {
  readonly stats = new Map<string, SiteStats>();
  /** The newest event id already counted. */
  watermark = 0;
  /** The index version the counts were computed against. */
  indexVersion = -1;

  constructor(readonly index: LogSiteIndex) { }

  reset(watermark = 0): void { this.stats.clear(); this.watermark = watermark; this.indexVersion = this.index.version; }

  /** Count events in id order; returns whether any site changed. */
  process(events: Iterable<LogEvent>): boolean {
    let changed = false;
    for (const event of events) {
      if (event.id <= this.watermark) continue;
      this.watermark = event.id;
      const match = this.index.match(event);
      if (!match) continue;
      let stats = this.stats.get(match.site.id);
      if (!stats) { stats = { hits: 0, errors: 0, samples: [], exact: 0 }; this.stats.set(match.site.id, stats); }
      stats.hits++;
      if (match.exact) stats.exact++;
      if (event.level === 'error' || event.level === 'fatal') stats.errors++;
      stats.lastSeen = event.timestampMs ?? stats.lastSeen;
      stats.samples.push({ id: event.id, level: event.level, message: (event.message ?? '').slice(0, 200), time: event.timestampMs });
      if (stats.samples.length > 3) stats.samples.shift();
      changed = true;
    }
    return changed;
  }
}
