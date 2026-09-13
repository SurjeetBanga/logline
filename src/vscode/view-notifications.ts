import type { Settings } from '../core/settings';
import type { HostMessage } from '../protocol/messages';

export type ViewSink = (message: HostMessage) => void;
/** Coalesce ingestion bursts without polling or retaining a queue per view. */
export class ViewNotifications {
  private readonly views = new Set<ViewSink>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyPending = false;
  private disposed = false;
  constructor(private readonly config: Settings) { }
  subscribe(view: ViewSink): { dispose(): void; } {
    this.views.add(view);
    return { dispose: () => { this.views.delete(view); } };
  }
  send(message: HostMessage): void { for (const view of this.views) view(message); }
  notify(): void {
    if (this.disposed) return;
    if (this.notifyTimer) { this.notifyPending = true; return; }
    this.send({ type: 'update' });
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.notifyPending) { this.notifyPending = false; this.notify(); }
    }, this.config.get('refreshIntervalMs', 500));
    this.notifyTimer.unref?.();
  }
  dispose(): void { this.disposed = true; clearTimeout(this.notifyTimer); this.views.clear(); }
}
