import { agentsDirectory } from '../protocol/agent-bridge';
import { mcpTools, readWindows, serveStdio, type ManifestTool } from './server';

// Filled in from package.json when scripts/build.mjs bundles this file into out/mcp.js.
declare const LOGLINE_TOOLS: ManifestTool[];
declare const LOGLINE_VERSION: string;

const flag = process.argv.indexOf('--workspace');
serveStdio({
  tools: mcpTools(LOGLINE_TOOLS),
  version: LOGLINE_VERSION,
  windows: () => readWindows(agentsDirectory()),
  // Claude Code sets CLAUDE_PROJECT_DIR; other clients start servers in the project.
  cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  workspace: (flag >= 0 ? process.argv[flag + 1] : undefined) || process.env.LOGLINE_WORKSPACE || undefined
});
