import type { MetricStore } from '../core/metrics';
import { scopeAttributes } from '../core/metric-query';
import { errorText, type MetricConnector } from './connectors/types';
import type { RuntimeState } from './runtime-state';

/** A connection whose metric queries can be watched. */
export interface MetricTarget {
  id: string;
  label: string;
  connector: MetricConnector;
}

interface Watch {
  target: MetricTarget;
  query: string;
  timer: ReturnType<typeof setInterval>;
  polling?: Promise<void>;
  error?: string;
}

/** Metrics are polled less often than logs: series change slowly and stores limit queries. */
const POLL_MS = 15000;
/** Each poll reads this far back, so a point that arrives late is still added. */
const WINDOW_MS = 600000;

/**
 * Watched metric queries: each is polled into the Metrics list's store, as
 * gauges of the connection's service, like metrics received over OTLP.
 */
export class RemoteMetrics {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly metrics: MetricStore,
    private readonly state: RuntimeState,
    private readonly pollMs = POLL_MS,
  ) {}

  private key(connectionId: string, query: string): string {
    return JSON.stringify([connectionId, query]);
  }

  /** The queries watched on a connection. */
  watching(connectionId: string): string[] {
    return [...this.watches.values()].filter((watch) => watch.target.id === connectionId).map((watch) => watch.query);
  }

  /** The latest error of a watched query, if its last poll failed. */
  error(connectionId: string, query: string): string | undefined {
    return this.watches.get(this.key(connectionId, query))?.error;
  }

  watch(target: MetricTarget, query: string): void {
    const key = this.key(target.id, query);
    if (this.watches.has(key)) return;
    const watch: Watch = { target, query, timer: setInterval(() => void this.poll(watch), this.pollMs) };
    watch.timer.unref?.();
    this.watches.set(key, watch);
    void this.poll(watch);
  }

  unwatch(connectionId: string, query: string): void {
    const key = this.key(connectionId, query);
    const watch = this.watches.get(key);
    if (!watch) return;
    clearInterval(watch.timer);
    this.watches.delete(key);
  }

  /** Stop every watch of a connection, such as one removed from settings. */
  stopConnection(connectionId: string): void {
    for (const watch of [...this.watches.values()])
      if (watch.target.id === connectionId) this.unwatch(connectionId, watch.query);
  }

  private poll(watch: Watch): Promise<void> {
    watch.polling ??= (async () => {
      const now = Date.now();
      try {
        const result = await watch.target.connector.queryMetrics(watch.query, now - WINDOW_MS, now);
        if (!this.watches.has(this.key(watch.target.id, watch.query))) return;
        watch.error = undefined;
        let added = false;
        for (const series of result.series)
          for (const [timeMs, value] of series.points)
            // The store keeps only points newer than a series' last, so overlapping reads add nothing twice.
            added =
              this.metrics.add({
                name: series.name,
                ...(series.unit ? { unit: series.unit } : {}),
                kind: 'gauge',
                service: watch.target.label,
                attributes: scopeAttributes(series.scope),
                timeMs,
                value,
              }) || added;
        if (added) this.state.notify();
      } catch (error) {
        watch.error = errorText(error);
        this.state.notify();
      } finally {
        watch.polling = undefined;
      }
    })();
    return watch.polling;
  }

  async dispose(): Promise<void> {
    const pending = [...this.watches.values()].map((watch) => watch.polling);
    for (const watch of [...this.watches.values()]) this.unwatch(watch.target.id, watch.query);
    await Promise.all(pending);
  }
}
