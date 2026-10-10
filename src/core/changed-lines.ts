import { extractExceptions } from './exceptions';
import { eventLocation, type LogSiteIndex } from './log-sites';
import type { LogEvent } from './types';

/** 1-based, inclusive line ranges, sorted and merged. */
export type LineRanges = [number, number][];

/** Every line of a file, for files with no committed version to compare against. */
export const WHOLE_FILE: LineRanges = [[1, Number.MAX_SAFE_INTEGER]];

function merge(ranges: LineRanges): LineRanges {
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: LineRanges = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * The lines a unified diff of one file adds or changes, numbered in the new
 * file. A deletion marks the line that now sits where the removed code was,
 * since a stack frame or log statement right there is what the change touched.
 */
export function parseDiffRanges(diff: string): LineRanges {
  const ranges: LineRanges = [];
  let line = 0;
  let inHunk = false;
  for (const text of diff.split(/\r?\n/)) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
    if (text.startsWith('diff --git ')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (text.startsWith('+')) { ranges.push([line, line]); line++; }
    else if (text.startsWith('-')) ranges.push([Math.max(1, line), Math.max(1, line)]);
    else if (text.startsWith(' ') || text === '') line++;
  }
  return merge(ranges);
}

const normalize = (file: string) => file.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\/?([A-Za-z]):\//, (_, drive: string) => `${drive.toLowerCase()}:/`);
const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1);

function inRanges(ranges: LineRanges, line: number): boolean {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (line < ranges[middle][0]) high = middle - 1;
    else if (line > ranges[middle][1]) low = middle + 1;
    else return true;
  }
  return false;
}

/** Lines that differ from the last commit, keyed by absolute file path. */
export class ChangedLines {
  version = 0;
  private files = new Map<string, LineRanges>();
  private byBasename = new Map<string, string[]>();

  get fileCount(): number { return this.files.size; }

  /** Replace every file's ranges; the version changes only when something did. */
  set(files: ReadonlyMap<string, LineRanges>): void {
    const next = new Map([...files].filter(([, ranges]) => ranges.length).map(([file, ranges]) => [normalize(file), ranges] as const));
    if (next.size === this.files.size && [...next].every(([file, ranges]) => JSON.stringify(this.files.get(file)) === JSON.stringify(ranges))) return;
    this.files = next;
    this.byBasename = new Map();
    for (const file of next.keys()) {
      const name = basename(file);
      this.byBasename.set(name, [...this.byBasename.get(name) ?? [], file]);
    }
    this.version++;
  }

  /**
   * Whether a reported location is on a changed line. Relative paths, such as
   * a log statement's workspace path or a frame printed from the working
   * directory, match an absolute path that ends with them.
   */
  contains(file: string, line: number): boolean {
    if (!this.files.size) return false;
    const path = normalize(file).replace(/^\.\//, '');
    for (const candidate of this.byBasename.get(basename(path)) ?? []) {
      if (candidate !== path && !candidate.endsWith('/' + path)) continue;
      if (inRanges(this.files.get(candidate)!, line)) return true;
    }
    return false;
  }
}

/**
 * Whether an event came from changed code: the location it reports, the log
 * statement it was attributed to, or a stack frame in an exception it carries.
 */
export function touchesChanges(event: LogEvent, changes: ChangedLines, sites?: LogSiteIndex): boolean {
  if (!changes.fileCount) return false;
  const location = eventLocation(event);
  if (location && changes.contains(location.file, location.line)) return true;
  const site = sites?.match(event)?.site;
  if (site && changes.contains(site.file, site.line)) return true;
  for (const block of extractExceptions(event)) {
    for (const { source } of block.lines) if (source && changes.contains(source.file, source.line)) return true;
  }
  return false;
}

/** Answers `changed:true` for the log store, remembering each event's answer until the diff or the statement index changes. */
export class ChangeScope {
  private cache = new WeakMap<LogEvent, boolean>();
  private cachedVersion = '';

  constructor(readonly changes: ChangedLines, private readonly sites?: LogSiteIndex) { }

  /** Changes whenever an event already tested could now answer differently. */
  get version(): string { return `${this.changes.version}.${this.sites?.version ?? 0}`; }

  matches(event: LogEvent): boolean {
    const version = this.version;
    if (version !== this.cachedVersion) { this.cache = new WeakMap(); this.cachedVersion = version; }
    let touched = this.cache.get(event);
    if (touched === undefined) { touched = touchesChanges(event, this.changes, this.sites); this.cache.set(event, touched); }
    return touched;
  }
}
