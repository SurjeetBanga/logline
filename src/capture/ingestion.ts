import type { ContainerTag } from '../core/container-prefix';
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
  location?: LogEvent['location'];
  /** Set when the line carried a container prefix; the container becomes its own source. */
  container?: ContainerTag;
}

/** The source id and label for one container of a capture source. */
export function containerSource(serverId: string, tag: ContainerTag): { serverId: string; server: string } {
  return { serverId: `${serverId}::${tag.service}`, server: tag.service };
}

/** All capture sources share one monotonic ID sequence and retention path. */
export class Ingestion {
  sequence = 0;
  constructor(readonly store: LogStore, private readonly persist: (raw: string) => void) { }

  create(raw: string, stream: string, receivedAt = new Date()): LogEvent {
    return parseLogLine(raw, stream, ++this.sequence, receivedAt);
  }

  commit(event: LogEvent, persist = false): void {
    if (persist) this.persist(event.raw ?? event.message ?? '');
    this.store.add(event);
  }

  accept(raw: string, stream: string, metadata: CaptureMetadata): LogEvent | undefined {
    const tag = metadata.container;
    // A timestamp printed by Docker stands in for the arrival time; one inside the payload still wins.
    const event = this.create(raw, stream, tag?.time !== undefined ? new Date(tag.time) : undefined);
    if (metadata.jsonOnly && !event.isJson) return undefined;
    const source = tag ? containerSource(metadata.serverId, tag) : metadata;
    event.serverId = source.serverId;
    event.server = source.server;
    if (tag) {
      event.fields ??= {};
      if (!Object.hasOwn(event.fields, 'container')) event.fields.container = tag.container;
      if (tag.pod && !Object.hasOwn(event.fields, 'pod')) event.fields.pod = tag.pod;
    }
    event.sessionId = metadata.sessionId;
    event.truncated = metadata.truncated;
    if (event.truncated) event.isJson = false;
    if (metadata.location) event.location = metadata.location;
    // Disk capture retains the physical line, including ANSI and surrounding whitespace.
    if (metadata.persist) this.persist(tag ? `${tag.container} | ${raw}` : raw);
    this.commit(event);
    return event;
  }
}
