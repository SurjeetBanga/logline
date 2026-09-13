/** Status shared by capture sources; retained event IDs belong to Ingestion. */
export class RuntimeState {
  status = 'Ready — run a server command to begin';
  command = '';
  generation = 0;
  constructor(readonly notify: () => void) { }
  invalidate(): void { this.generation++; this.notify(); }
}
