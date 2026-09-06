function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function nextServerId(servers, label) {
  const base = slugify(label);
  let id = base;
  let suffix = 2;
  while (servers.some(server => server.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function resolveAutoStartServers(servers, isTrusted) {
  const pending = servers.filter(server => server.autoStart);
  if (!pending.length) return { blocked: false, servers: [] };
  if (!isTrusted) return { blocked: true, servers: [] };
  return { blocked: false, servers: pending };
}

// Saved servers are shared through workspace settings, so their cwd accepts the
// same ${workspaceFolder} placeholder that tasks.json does.
function resolveCwd(cwd, workspaceCwd) {
  if (!cwd) return workspaceCwd;
  return cwd.replace(/\$\{workspaceFolder\}/g, workspaceCwd ?? '');
}

function resolveRunTarget(servers, serverId, workspaceCwd) {
  const server = servers.find(candidate => candidate.id === serverId);
  if (!server) return undefined;
  return { command: server.command, cwd: resolveCwd(server.cwd, workspaceCwd), server, env: server.env };
}

module.exports = { slugify, nextServerId, resolveAutoStartServers, resolveRunTarget, resolveCwd };
