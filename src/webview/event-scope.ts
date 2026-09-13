/** Resources owned by one viewer instance, released together on disposal. */
type ViewerEventMap = GlobalEventHandlersEventMap & Pick<WindowEventMap, 'message'> & Pick<DocumentEventMap, 'visibilitychange'>;
export class EventScope {
  private readonly abort = new AbortController();
  private readonly cleanups: (() => void)[] = [];
  private readonly frames = new Set<number>();
  listen<K extends keyof ViewerEventMap>(target: EventTarget, type: K,
    handler: (event: ViewerEventMap[K]) => unknown, options: AddEventListenerOptions = {}): void {
    if ((target as Node).isConnected === false) {
      // Detached row/control nodes are collected with their handlers. Do not
      // retain them in the viewer's long-lived abort signal as rows change.
      target.addEventListener(type, (event => { if (!this.abort.signal.aborted) handler(event as ViewerEventMap[K]); }) as EventListener, options);
    } else target.addEventListener(type, handler as EventListener, { ...options, signal: this.abort.signal });
  }
  track(dispose: () => void): void { this.cleanups.push(dispose); }
  observer(callback: ResizeObserverCallback): ResizeObserver {
    const observer = new ResizeObserver(callback);
    this.track(() => observer.disconnect());
    return observer;
  }
  frame(callback: () => void): void {
    const id = requestAnimationFrame(() => { this.frames.delete(id); if (!this.abort.signal.aborted) callback(); });
    this.frames.add(id);
  }
  dispose(): void {
    this.abort.abort();
    for (const id of this.frames) cancelAnimationFrame(id);
    this.frames.clear();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }
}
