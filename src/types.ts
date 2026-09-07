// The shape LogStore, query matching, and the webview protocol all operate
// on. Only `id` and `level` are load-bearing for LogStore itself (see
// log-store.ts); parseLogLine always populates the rest in production, but
// tests and other callers may construct partial events directly.
// A saved entry from the `logline.servers` setting.
export interface ServerConfig {
  id: string;
  label: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
  jsonOnly?: boolean;
}

export interface LogEvent {
  id: number;
  level: string;
  message?: string;
  timestamp?: string;
  timestampMs?: number;
  isJson?: boolean;
  raw?: string;
  fields?: Record<string, string | number | boolean>;
  stream?: string;
  truncated?: boolean;
  serverId?: string;
  server?: string;
  sessionId?: string;
}

export type SessionStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'failed';

export interface SessionSummary {
  id: string;
  serverId: string;
  server: string;
  status: SessionStatus;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  events: number;
  exitCode?: number;
  signal?: string;
  error?: string;
}
