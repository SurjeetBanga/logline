import type { ServerConfig } from './types';

export function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

export function nextServerId(servers: ServerConfig[], label: string): string {
  const base = slugify(label);
  let id = base;
  let suffix = 2;
  while (servers.some(server => server.id === id)) id = `${base}-${suffix++}`;
  return id;
}

export function resolveAutoStartServers(servers: ServerConfig[], isTrusted: boolean): { blocked: boolean; servers: ServerConfig[] } {
  const pending = servers.filter(server => server.autoStart);
  if (!pending.length) return { blocked: false, servers: [] };
  if (!isTrusted) return { blocked: true, servers: [] };
  return { blocked: false, servers: pending };
}

// Saved servers are shared through workspace settings, so their cwd accepts the
// same ${workspaceFolder} placeholder that tasks.json does.
export function resolveCwd(cwd: string | undefined, workspaceCwd: string | undefined): string | undefined {
  if (!cwd) return workspaceCwd;
  return cwd.replace(/\$\{workspaceFolder\}/g, workspaceCwd ?? '');
}

export interface RunTarget {
  command: string;
  cwd: string | undefined;
  server: ServerConfig;
  env: Record<string, string> | undefined;
}

export function resolveRunTarget(servers: ServerConfig[], serverId: string, workspaceCwd: string | undefined): RunTarget | undefined {
  const server = servers.find(candidate => candidate.id === serverId);
  if (!server) return undefined;
  return { command: server.command, cwd: resolveCwd(server.cwd, workspaceCwd), server, env: server.env };
}
