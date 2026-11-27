import * as vscode from 'vscode';
import type { GitHubAuth } from '../capture/connectors/github-actions';

interface GitApi {
  readonly repositories: readonly { readonly state: { readonly HEAD?: { readonly name?: string } } }[];
}

/** The branch checked out in the workspace's first repository, from the built-in git extension. */
export async function checkedOutBranch(): Promise<string | undefined> {
  const extension = vscode.extensions?.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!extension) return undefined;
  try {
    const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    return api.repositories[0]?.state.HEAD?.name;
  } catch {
    return undefined;
  }
}

/**
 * GitHub Actions connections sign in with the GitHub account VS Code knows, so
 * no token is typed or stored by Logline. Reading `repo` lets it see the runs
 * of private repositories; VS Code asks once, when a connection is tested or run.
 */
export const githubAuth: GitHubAuth = {
  async token() {
    try {
      // Asks to sign in only when VS Code has no GitHub session with this scope yet.
      return (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }))?.accessToken;
    } catch {
      return undefined;
    }
  },
  branch: checkedOutBranch,
};
