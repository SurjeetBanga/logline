import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SessionSummary, SourceKind } from '../core/types';

export interface SessionServer {
  id: string;
  label: string;
  jsonOnly?: boolean;
  shell?: boolean | string;
  taskName?: string;
  taskType?: string;
  dependencies?: string[];
  dependencyState?: string;
  source?: string;
  taskScope?: string;
  taskLabel?: string;
  sourceKind?: SourceKind;
  owned?: boolean;
}

export interface Session {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  /** The process and its output pipes have closed. */
  exited: boolean;
  /** The process itself has exited; a descendant can still hold its output pipes open. */
  processExited?: boolean;
  server: SessionServer;
  record: SessionSummary;
}
