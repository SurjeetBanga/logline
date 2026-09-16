/** Protocol data shared by the host, webview, and Copilot tool adapter. */
export interface AgentRunStatus {
  id: string;
  sourceId: string;
  label: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  events: number;
  captureStatus?: string;
  captureReason?: string;
}

export interface AgentShareStatus {
  active: boolean;
  shareId?: string;
  revision: number;
  scope?: 'all' | 'selected';
  sources: { id: string; label: string; sessions: number; events: number; runs: AgentRunStatus[] }[];
}
