import { agentsDirectory } from '../protocol/agent-bridge';
import { AGENT_WORKFLOWS } from '../protocol/agent-workflows';
import {
  mcpTools,
  readWindows,
  sendHello,
  serveStdio,
  workspaceArgument,
  workspaceUnexpanded,
  type ManifestTool,
} from './server';

// Filled in from package.json when scripts/build.mjs bundles this file into out/mcp.js.
declare const LOGLINE_TOOLS: ManifestTool[];
declare const LOGLINE_VERSION: string;

serveStdio({
  tools: mcpTools(LOGLINE_TOOLS),
  prompts: AGENT_WORKFLOWS,
  version: LOGLINE_VERSION,
  windows: () => readWindows(agentsDirectory()),
  // Claude Code sets CLAUDE_PROJECT_DIR; other clients start servers in the project.
  cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  workspace: workspaceArgument(process.argv),
  unexpanded: workspaceUnexpanded(process.argv),
  hello: sendHello,
});
