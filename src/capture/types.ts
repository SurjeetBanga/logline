import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SessionSummary } from '../core/types';

export interface SessionServer {
  id: string;
  label: string;
  jsonOnly?: boolean;
  shell?: boolean;
  taskName?: string;
  taskType?: string;
  dependencies?: string[];
  dependencyState?: string;
  source?: string;
  taskScope?: string;
  taskLabel?: string;
  sourceKind?: 'process' | 'task' | 'terminal' | 'import';
  owned?: boolean;
}

export interface Session {
  child: ChildProcessWithoutNullStreams;
  stopping: boolean;
  exited: boolean;
  server: SessionServer;
  record: SessionSummary;
}
