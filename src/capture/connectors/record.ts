import { stripAnsi } from '../../core/log-event';
import type { RemoteRecord } from './types';

/**
 * The fields of one fetched log, written as the JSON line Logline parses.
 * This runs for every fetched log, so it only collects; connectors decide
 * where their store keeps each field.
 */
export class LogFields {
  readonly fields: Record<string, unknown> = {};

  /** `reserved` are the names of the fields every event has, which an attribute of the same name must not replace. */
  constructor(private readonly reserved: ReadonlySet<string>) {}

  put(name: string, value: unknown): void {
    if (value !== undefined && value !== null) this.fields[name] = value;
  }

  /** The log's message; colors a service printed reach most stores as escape codes, and the message keeps its text. */
  message(value: unknown): void {
    this.put('message', typeof value === 'string' ? stripAnsi(value) : value);
  }

  /** An attribute of the log, kept under `attributes.` when its name is one of the event's own fields. */
  attribute(name: string, value: unknown): void {
    this.put(this.reserved.has(name) ? `attributes.${name}` : name, value);
  }

  /** The line, with its time when `time` is an ISO time or milliseconds since the epoch. */
  record(time: unknown): RemoteRecord {
    const ms = typeof time === 'string' ? Date.parse(time) : typeof time === 'number' ? time : NaN;
    const record: RemoteRecord = { line: JSON.stringify(this.fields) };
    if (Number.isFinite(ms)) record.timeMs = ms;
    return record;
  }
}
