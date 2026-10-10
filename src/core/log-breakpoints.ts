import { matchesQuery, parseQuery, queryError, type ParsedQuery } from './query';
import type { LogEvent } from './types';

/** A search that pauses the debugger when a debug session logs a matching event. */
export interface LogBreakpointRule {
  id: number;
  query: string;
  levels: string[];
  /** Matching events seen since the rule was added. */
  hits: number;
  /** Times a debug session was paused for this rule. */
  pauses: number;
}

const MAX_RULES = 10;
// Output keeps arriving between asking a debugger to pause and the program
// stopping; one pause per rule in this window avoids a queue of pauses.
const PAUSE_INTERVAL_MS = 1500;

/** The rules behind "Break on matching logs", independent of the debugger API. */
export class LogBreakpointRules {
  private readonly rules: (LogBreakpointRule & { parsed: ParsedQuery; pausedAt: number })[] = [];
  private nextId = 1;

  get size(): number { return this.rules.length; }

  list(): LogBreakpointRule[] {
    return this.rules.map(({ id, query, levels, hits, pauses }) => ({ id, query, levels: [...levels], hits, pauses }));
  }

  /** Add a rule, or return the existing one with the same filter. Throws with a user-facing message for invalid input. */
  add(query: string, levels: readonly string[] = []): LogBreakpointRule {
    const text = query.trim();
    const wanted = [...new Set(levels.map(level => level.toLowerCase()))].sort();
    if (!text && !wanted.length) throw new Error('Enter a search or choose log levels to break on.');
    const error = queryError(text);
    if (error) throw new Error(error);
    const existing = this.rules.find(rule => rule.query === text && rule.levels.join() === wanted.join());
    if (existing) return existing;
    if (this.rules.length >= MAX_RULES) throw new Error(`Logline keeps at most ${MAX_RULES} log breakpoints. Remove one first.`);
    const rule = { id: this.nextId++, query: text, levels: wanted, hits: 0, pauses: 0, parsed: parseQuery(text), pausedAt: -Infinity };
    this.rules.push(rule);
    return rule;
  }

  remove(id: number): boolean {
    const index = this.rules.findIndex(rule => rule.id === id);
    if (index === -1) return false;
    this.rules.splice(index, 1);
    return true;
  }

  clear(): void { this.rules.length = 0; }

  /**
   * The rule that should pause the debugger for a newly captured event, if
   * any. Every matching rule counts the hit; at most one asks for a pause.
   */
  check(event: LogEvent, now = Date.now(), changed?: (event: LogEvent) => boolean): LogBreakpointRule | undefined {
    let pause: (typeof this.rules)[number] | undefined;
    for (const rule of this.rules) {
      if (rule.levels.length && !rule.levels.includes(String(event.level).toLowerCase())) continue;
      if (!matchesQuery(event, rule.parsed, now, changed)) continue;
      rule.hits++;
      if (!pause && now - rule.pausedAt >= PAUSE_INTERVAL_MS) pause = rule;
    }
    if (pause) { pause.pausedAt = now; pause.pauses++; }
    return pause;
  }
}

/** A short description of a rule for status text. */
export function describeRule(rule: Pick<LogBreakpointRule, 'query' | 'levels'>): string {
  const levels = rule.levels.length ? `level ${rule.levels.join('/')}` : '';
  return [rule.query, levels].filter(Boolean).join(' · ');
}
