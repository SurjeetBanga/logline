import type { ViewerState } from './state';
import type { WebviewApi } from './types';
/** Only one snapshot is in flight; pushes during it request one follow-up. */
export class SnapshotBridge {
  pending = false;
  refreshRequested = false;
  updateRequested = false;
  private nextRequestId = 0;
  private pendingRequestId?: number;
  constructor(private readonly api: WebviewApi, private readonly state: ViewerState, private readonly query: () => string,
    private readonly columns: () => string[] = () => this.state.extraColumns) { }
  request(force = false): void {
    if (document.hidden) return;
    if (this.pending) { if (force) this.refreshRequested = true; else this.updateRequested = true; return; }
    this.pending = true;
    const requestId = ++this.nextRequestId;
    this.pendingRequestId = requestId;
    const state = this.state;
    this.api.postMessage({
      type: 'snapshot', requestId, query: this.query(), serverId: state.selectedServer || undefined, sessionId: state.selectedSession || undefined,
      levels: state.currentLevels(), page: state.page, before: state.before, sort: state.selectedSort || undefined,
      sortDirection: state.selectedSortDirection, columns: this.columns(), statsOnly: state.paused && !force
    });
  }
  received(requestId?: number): void {
    if (requestId !== undefined && requestId !== this.pendingRequestId) return;
    this.pending = false; this.pendingRequestId = undefined;
  }
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
