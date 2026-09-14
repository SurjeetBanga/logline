/** Status shared by capture sources; retained event IDs belong to Ingestion. */
export class RuntimeState {
  static readonly readyStatus = 'Ready — run a server command to begin';
  status = RuntimeState.readyStatus;
  command = '';
  generation = 0;
  constructor(readonly notify: () => void) { }
  invalidate(): void { this.generation++; this.notify(); }
  /** Remove status left by finished imports or commands when the log history is cleared. */
  reset(running = false): void {
    this.status = running ? 'Running' : RuntimeState.readyStatus;
    if (!running) this.command = '';
    this.invalidate();
  }
}
