import type { ViewerState } from './state';
import type { WebviewApi } from './types';
/** Only one snapshot is in flight; pushes during it request one follow-up. */
export class SnapshotBridge {
  pending = false;
  refreshRequested = false;
  updateRequested = false;
  forcedRequest = false;
  constructor(private readonly api: WebviewApi, private readonly state: ViewerState, private readonly query: () => string) { }
  request(force = false): void {
    if (document.hidden) return;
    if (this.pending) { if (force) this.refreshRequested = true; else this.updateRequested = true; return; }
    this.pending = true; this.forcedRequest = force;
    const state = this.state;
    this.api.postMessage({
      type: 'snapshot', query: this.query(), serverId: state.selectedServer || undefined,
      levels: state.currentLevels(), page: state.page, before: state.before, sort: state.selectedSort || undefined,
      sortDirection: state.selectedSortDirection, columns: state.extraColumns, statsOnly: state.paused && !force
    });
  }
  received(): void { this.pending = false; }
  flush(): void {
    if (!this.refreshRequested && !this.updateRequested) return;
    const force = this.refreshRequested;
    this.refreshRequested = false; this.updateRequested = false; this.request(force);
  }
}
