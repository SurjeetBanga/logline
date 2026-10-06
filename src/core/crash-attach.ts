// A Node app that logs JSON often reports a failure as a JSON error and then
// dies with a plain-text crash or stack trace. The two stay separate events,
// each redacted, indexed and persisted as captured; the trace only records
// the id of the error it followed (`attachedTo`), so views can relate them
// without changing either event.
//
// A trace is attached only to the last JSON event of the same source and run,
// only when that event is an error, and only when it arrives soon after it:
// within a short window, or a longer one when the trace is a Node crash that
// ends the process. A healthy JSON line in between, a restart (a new run), or
// another container (its own source) keeps an unrelated crash off an old error.

import { isExitingCrash, isPlainCrash } from './exceptions';
import type { LogEvent } from './types';

export const ATTACH_WINDOW_MS = 2000;
export const EXIT_ATTACH_WINDOW_MS = 30000;
// Distinct runs remembered at once; the oldest is forgotten first.
const MAX_RUNS = 256;

interface LastJson { id: number; error: boolean; at: number; }

export class CrashLinker {
  private readonly last = new Map<string, LastJson>();

  /** Record a new event and set `attachedTo` when it is a trace that follows a JSON error. */
  observe(event: LogEvent, now: number): void {
    const key = `${event.serverId ?? ''}\0${event.sessionId ?? ''}`;
    if (event.isJson) {
      this.last.delete(key);
      if (this.last.size >= MAX_RUNS) this.last.delete(this.last.keys().next().value!);
      this.last.set(key, { id: event.id, error: event.level === 'error' || event.level === 'fatal', at: now });
      return;
    }
    const previous = this.last.get(key);
    if (!previous?.error || !event.raw || !isPlainCrash(event.raw)) return;
    const elapsed = now - previous.at;
    if (elapsed > (isExitingCrash(event.raw) ? EXIT_ATTACH_WINDOW_MS : ATTACH_WINDOW_MS)) return;
    event.attachedTo = previous.id;
    // One trace per error: a second crash starts nothing new to attach to.
    this.last.delete(key);
  }

  clear(): void { this.last.clear(); }
}
