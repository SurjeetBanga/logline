import * as vscode from 'vscode';
import type { NudgeStep } from '../core/usage-events';

/** Set once someone chose not to hear about terminals without shell integration again. */
export const INTEGRATION_NOTICE_KEY = 'logline.integrationNotice.never';

const SHELL_INTEGRATION_DOCS = 'https://code.visualstudio.com/docs/terminal/shell-integration';
const RUN_COMMAND = 'Run Command';
const LEARN_MORE = 'Learn More';
const NEVER = "Don't Show Again";

export interface IntegrationNoticeOptions {
  global: Pick<vscode.Memento, 'get' | 'update'>;
  record?: (step: NudgeStep) => void;
}

/** Why a shell may not have brought up shell integration, from its path or name. */
export function integrationHint(shell: string | undefined): string {
  const name = (shell ?? '').toLowerCase();
  if (/(^|[\\/])cmd(\.exe)?$/.test(name))
    return 'Command Prompt has no shell integration; run your app in PowerShell or Git Bash instead.';
  if (/pwsh|powershell/.test(name))
    return "PowerShell's often does not start when its execution policy blocks scripts or a custom prompt replaces VS Code's.";
  return 'A custom prompt or shell configuration can stop it from starting.';
}

/**
 * Says, once a window and until told not to, that capture is on but a
 * terminal cannot be read because it has no shell integration: without this,
 * capture says it is on and nothing ever arrives.
 */
export class IntegrationNotice {
  private told = false;

  constructor(private readonly options: IntegrationNoticeOptions) {}

  /** A terminal came up without shell integration; returns whether it was said. */
  async noIntegration(shell: string | undefined): Promise<boolean> {
    const { global, record } = this.options;
    if (this.told || global.get<boolean>(INTEGRATION_NOTICE_KEY, false)) return false;
    this.told = true;
    record?.('shown');
    const answer = await vscode.window.showWarningMessage(
      `Logline cannot capture this terminal: its shell integration did not start, so VS Code does not pass on its output. ${integrationHint(shell)} Run Command captures a command without it.`,
      RUN_COMMAND,
      LEARN_MORE,
      NEVER,
    );
    if (answer === RUN_COMMAND) {
      record?.('accepted');
      await vscode.commands.executeCommand('logline.runCommand');
    } else if (answer === LEARN_MORE) {
      record?.('accepted');
      await vscode.env.openExternal(vscode.Uri.parse(SHELL_INTEGRATION_DOCS));
    } else if (answer === NEVER) {
      record?.('never');
      await global.update(INTEGRATION_NOTICE_KEY, true);
    } else record?.('dismissed');
    return true;
  }
}
