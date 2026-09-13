import { parseLogLine } from '../core/log-event';
import type { LogStore } from '../core/log-store';
import type { LogEvent } from '../core/types';

export interface CaptureMetadata {
  serverId: string;
  server: string;
  sessionId: string;
  truncated?: boolean;
  jsonOnly?: boolean;
  persist?: boolean;
}

/** All capture sources share one monotonic ID sequence and retention path. */
export class Ingestion {
  sequence = 0;
  constructor(readonly store: LogStore, private readonly persist: (raw: string) => void) { }

  create(raw: string, stream: string): LogEvent {
    return parseLogLine(raw, stream, ++this.sequence, new Date());
  }

  commit(event: LogEvent, persist = false): void {
    if (persist) this.persist(event.raw ?? event.message ?? '');
    this.store.add(event);
  }

  accept(raw: string, stream: string, metadata: CaptureMetadata): LogEvent | undefined {
    const event = this.create(raw, stream);
    if (metadata.jsonOnly && !event.isJson) return undefined;
    event.serverId = metadata.serverId;
    event.server = metadata.server;
    event.sessionId = metadata.sessionId;
    event.truncated = metadata.truncated;
    if (event.truncated) event.isJson = false;
    // Disk capture retains the physical line, including ANSI and surrounding whitespace.
    if (metadata.persist) this.persist(raw);
    this.commit(event);
    return event;
  }
}
