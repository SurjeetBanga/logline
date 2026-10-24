import type { SessionRegistry } from '../capture/session-registry';
import type { LogStore } from '../core/log-store';
import { compareSignatures, differingFields, summarizeComparison } from '../core/signature-compare';
import type { LogEvent } from '../core/types';
import type { CompareRequest, CompareSample, CompareView } from '../protocol/messages';

/** Newest events read from each side; errors are a small share of them. */
const EVENTS_PER_RUN = 5000;
/** Local runs shown side by side, so a rerun after a fix shows next to the one before. */
const LOCAL_RUNS = 3;
const ROWS = 50;
const SAMPLE_FIELDS = 40;

function sample(event: LogEvent | undefined, other: LogEvent | undefined): CompareSample | undefined {
  if (!event) return undefined;
  const fields = Object.fromEntries(
    Object.entries(event.fields ?? {})
      .slice(0, SAMPLE_FIELDS)
      .map(([name, value]) => [name, typeof value === 'string' ? value.slice(0, 200) : value]),
  );
  return {
    id: event.id,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    level: event.level,
    ...(event.message ? { message: event.message.slice(0, 500) } : {}),
    fields,
    differs: other ? differingFields(event, other) : [],
  };
}

/**
 * Production compared with local runs: the Compare tab's view, and a
 * notification when the local source being compared finishes another run.
 */
export class ProductionCompare {
  private pinned?: CompareRequest;
  private readonly announced = new Set<string>();

  constructor(
    private readonly store: LogStore,
    private readonly registry: SessionRegistry,
    private readonly finished: (view: CompareView) => void,
  ) {}

  /** The newest runs of a local source that `allowed` admits, oldest first. */
  private localRuns(
    serverId: string,
    allowed: (runId: string) => boolean = () => true,
  ): { id: string; label: string; startedAt: number }[] {
    const records = [...this.registry.records.values()]
      .filter((record) => record.serverId === serverId && allowed(record.id))
      .sort((a, b) => a.startedAt - b.startedAt);
    if (records.length)
      return records
        .slice(-LOCAL_RUNS)
        .map((record) => ({ id: record.id, label: record.command || record.server, startedAt: record.startedAt }));
    // Imported files and runs the registry has forgotten still have their events.
    return this.store
      .sessionIds(serverId)
      .filter((id) => id !== '*' && allowed(id))
      .slice(-LOCAL_RUNS)
      .map((id) => ({ id, label: this.store.serverLabel(serverId) ?? serverId, startedAt: 0 }));
  }

  private events(serverId: string, sessionId?: string): LogEvent[] {
    return this.store.reversePage({ serverId, ...(sessionId ? { sessionId } : {}) }, EVENTS_PER_RUN).events;
  }

  /**
   * Compare, and remember the comparison so a later local run can be
   * reported against it. `allowed` limits which local runs are read, such as
   * to the runs shared with an agent.
   */
  build(request: CompareRequest, pin = true, allowed?: (runId: string) => boolean): CompareView {
    if (pin) {
      this.pinned = request;
      // Only runs that finish from now on are reported.
      for (const record of this.registry.records.values())
        if (record.serverId === request.localServerId && record.status !== 'running') this.announced.add(record.id);
    }
    const baseline = this.events(request.baselineServerId, request.baselineSessionId);
    const runs = this.localRuns(request.localServerId, allowed);
    const local = runs.map((run) => this.events(request.localServerId, run.id));
    const changeScope = this.store.changeScope;
    const rows = compareSignatures(
      baseline,
      local,
      changeScope ? (event) => changeScope.matches(event) : undefined,
      ROWS,
    );
    const record = request.baselineSessionId ? this.registry.records.get(request.baselineSessionId) : undefined;
    const label = this.store.serverLabel(request.baselineServerId) ?? request.baselineServerId;
    return {
      baseline: {
        serverId: request.baselineServerId,
        ...(request.baselineSessionId ? { sessionId: request.baselineSessionId } : {}),
        label: record?.command ? `${label} · ${record.command}` : label,
        events: baseline.length,
      },
      local: {
        serverId: request.localServerId,
        label: this.store.serverLabel(request.localServerId) ?? request.localServerId,
      },
      runs,
      rows: rows.map((row) => {
        const prod = row.baselineSample !== undefined ? this.store.find(row.baselineSample) : undefined;
        const mine = row.localSample !== undefined ? this.store.find(row.localSample) : undefined;
        return { ...row, samples: { baseline: sample(prod, mine), local: sample(mine, prod) } };
      }),
      summary: summarizeComparison(rows),
    };
  }

  /** Stop reporting runs, such as when logs are cleared. */
  unpin(): void {
    this.pinned = undefined;
    this.announced.clear();
  }

  /** Report local runs of the compared source that finished since the last check. */
  check(): void {
    const pinned = this.pinned;
    if (!pinned) return;
    for (const record of this.registry.records.values()) {
      if (record.serverId !== pinned.localServerId || record.status === 'running' || record.status === 'stopping')
        continue;
      if (this.announced.has(record.id)) continue;
      this.announced.add(record.id);
      this.finished(this.build(pinned, false));
      return;
    }
  }
}
