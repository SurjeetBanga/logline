import type { HeldRows, RowEvent, Snapshot } from '../protocol/messages';
import type { ViewerState } from './state';
import type { WebviewApi } from './types';

interface Held { key: string; rows: RowEvent[]; version: string; }

/** Only one snapshot is in flight; pushes during it request one follow-up. */
export class SnapshotBridge {
  pending = false;
  refreshRequested = false;
  updateRequested = false;
  private nextRequestId = 0;
  private pendingRequestId?: number;
  // The newest page received for one set of request parameters. A refresh for
  // the same parameters sends only the rows after it, so a busy stream costs
  // the new rows instead of the whole page on every tick.
  private held?: Held;
  private pendingKey?: string;
  private pendingHave?: HeldRows;
  private answered?: { key: string; have?: HeldRows; };
  constructor(private readonly api: WebviewApi, private readonly state: ViewerState, private readonly query: () => string,
    private readonly columns: () => string[] = () => this.state.extraColumns,
    private readonly doctorRevision: () => number | undefined = () => undefined) { }
  request(force = false): void {
    if (document.hidden) return;
    if (this.pending) { if (force) this.refreshRequested = true; else this.updateRequested = true; return; }
    this.pending = true;
    const requestId = ++this.nextRequestId;
    this.pendingRequestId = requestId;
    const state = this.state;
    const params = {
      query: this.query(), serverId: state.selectedServer || undefined, sessionId: state.selectedSession || undefined,
      levels: state.currentLevels(), page: state.page, before: state.before, sort: state.selectedSort || undefined,
      sortDirection: state.selectedSortDirection, columns: this.columns()
    };
    const key = JSON.stringify([params.query, params.serverId, params.sessionId, params.levels, params.page, params.before,
      params.sort, params.sortDirection, params.columns]);
    const held = this.held?.key === key && this.held.rows.length ? this.held : undefined;
    this.pendingKey = key;
    this.pendingHave = held && { last: held.rows[held.rows.length - 1].id, count: held.rows.length, version: held.version };
    this.api.postMessage({
      type: 'snapshot', requestId, ...params, statsOnly: state.paused && !force,
      doctorRevision: this.doctorRevision(), ...(this.pendingHave ? { have: this.pendingHave } : {})
    });
  }
  received(requestId?: number): void {
    if (requestId !== undefined && requestId !== this.pendingRequestId) { this.answered = undefined; return; }
    this.answered = requestId !== undefined && this.pendingKey !== undefined ? { key: this.pendingKey, have: this.pendingHave } : undefined;
    this.pending = false; this.pendingRequestId = undefined;
  }
  /**
   * The complete page a snapshot describes. Rows the view already held are
   * reused as the same objects, and the array itself when nothing changed.
   * Returns undefined, and asks for a full refresh, if partial rows cannot be
   * placed after the held ones.
   */
  rows(data: Snapshot): RowEvent[] | undefined {
    if (!data.events) return undefined;
    const answered = this.answered;
    let rows = data.events;
    if (data.keep !== undefined) {
      const held = this.held;
      const kept = held && answered?.have && held.key === answered.key && held.rows[held.rows.length - 1].id === answered.have.last
        && data.keep <= held.rows.length && held.rows[held.rows.length - data.keep]?.id === data.keepFirst ? held : undefined;
      if (!kept) {
        this.held = undefined;
        this.refreshRequested = true;
        return undefined;
      }
      rows = data.keep === kept.rows.length && !data.events.length ? kept.rows
        : [...kept.rows.slice(kept.rows.length - data.keep), ...data.events];
    }
    this.held = answered && data.rowsVersion !== undefined ? { key: answered.key, rows, version: data.rowsVersion } : undefined;
    return rows;
  }
  /** Forget held rows, so the next refresh sends a whole page. */
  forget(): void { this.held = undefined; }
  failed(requestId?: number): boolean {
    if (requestId !== undefined && requestId !== this.pendingRequestId) return false;
    this.pending = false; this.pendingRequestId = undefined;
    return true;
  }
  flush(): void {
    if (!this.refreshRequested && !this.updateRequested) return;
    const force = this.refreshRequested;
    this.refreshRequested = false; this.updateRequested = false; this.request(force);
  }
}
