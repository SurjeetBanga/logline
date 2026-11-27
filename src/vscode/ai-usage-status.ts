import * as vscode from 'vscode';
import {
  AI_USAGE_DETAILS,
  NO_CODEX_USAGE,
  aiUsageSeverity,
  aiUsageText,
  aiUsageTooltip,
  appUsage,
  type AiUsageDetail,
  type AppUsage,
  type CodexUsage,
} from '../core/codex-usage';
import { NO_CLAUDE_USAGE, type ClaudeUsage } from '../core/claude-usage';
import type { GenAiCall } from '../core/gen-ai';
import type { Settings } from '../core/settings';

/** How often usage is read again. Session files are only read where they grew. */
export const AI_USAGE_POLL_MS = 5000;
/** Low, so the item sits at the far right with the other assistants' items. */
const PRIORITY = 1;
const COMMANDS = [
  'logline.setAiUsageDetail',
  'logline.enableCodexUsage',
  'logline.enableClaudeUsage',
  'logline.showAgentSessions',
  'logline.logs.focus',
  'workbench.action.openSettings',
];

export interface AiUsageSources {
  config: Settings;
  /** The GenAI calls Logline retains: the same array until a call arrives or leaves. */
  calls(): readonly GenAiCall[];
  reader: { poll(): Promise<CodexUsage> };
  /** Claude Code's tokens of today. */
  claudeReader?: { poll(): Promise<ClaudeUsage> };
  /** Show the agent sessions captured in the Logs panel. */
  showAgentSessions?: () => void;
  now?: () => number;
}

/**
 * AI usage in the status bar: how much of Codex's plan limit is used, as a pie
 * and a percentage, with today's tokens and the app's own LLM calls behind a hover.
 */
export class AiUsageStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private usage: CodexUsage = NO_CODEX_USAGE;
  private claudeUsage: ClaudeUsage = NO_CLAUDE_USAGE;
  private reading?: Promise<void>;
  private app?: { calls: readonly GenAiCall[]; usage: AppUsage };
  /** What the item shows, so a poll that changes nothing leaves it alone instead of redrawing it. */
  private shown?: string;

  constructor(private readonly sources: AiUsageSources) {
    this.item = vscode.window.createStatusBarItem?.('logline.aiUsage', vscode.StatusBarAlignment.Right, PRIORITY);
    if (this.item) {
      this.item.name = 'Logline AI usage';
      this.item.command = 'logline.showAiUsage';
    }
    const register = (id: string, handler: (...args: any[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, handler));
    register('logline.showAiUsage', () => vscode.commands.executeCommand('logline.logs.focus'));
    register('logline.setAiUsageDetail', (detail?: unknown) => this.setDetail(detail));
    register('logline.enableCodexUsage', () => this.enableCodex());
    register('logline.enableClaudeUsage', () => this.enableClaude());
    register('logline.showAgentSessions', (agents?: unknown) =>
      this.showAgentSessions(
        Array.isArray(agents) ? agents.filter((agent): agent is string => typeof agent === 'string') : undefined,
      ),
    );
    const changed = vscode.workspace.onDidChangeConfiguration?.((event) => {
      if (event.affectsConfiguration('logline.aiUsage') || event.affectsConfiguration('logline.agentSessions'))
        void this.refresh();
    });
    if (changed) this.disposables.push(changed);
    this.timer = setInterval(() => void this.refresh(), AI_USAGE_POLL_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  private get codex(): boolean {
    return this.sources.config.get('aiUsage.codex', false);
  }

  private get claude(): boolean {
    return this.sources.config.get('aiUsage.claude', false);
  }

  /** Read usage again and show it. A read still under way is waited for, not repeated. */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async read(): Promise<void> {
    const enabled = this.sources.config.get('aiUsage.enabled', true);
    if (!enabled || !this.codex) this.usage = NO_CODEX_USAGE;
    else
      try {
        this.usage = await this.sources.reader.poll();
      } catch {
        /* keep what was read last */
      }
    if (!enabled || !this.claude || !this.sources.claudeReader) this.claudeUsage = NO_CLAUDE_USAGE;
    else
      try {
        this.claudeUsage = await this.sources.claudeReader.poll();
      } catch {
        /* keep what was read last */
      }
    this.render();
  }

  private render(): void {
    if (!this.item) return;
    const calls = this.sources.calls();
    if (this.app?.calls !== calls) this.app = { calls, usage: appUsage(calls) };
    const detail = this.sources.config.get<AiUsageDetail>('aiUsage.detail', 'medium');
    const text = this.sources.config.get('aiUsage.enabled', true)
      ? aiUsageText(this.usage, this.app.usage, detail, this.claudeUsage)
      : '';
    if (!text) {
      if (this.shown !== undefined) this.item.hide();
      this.shown = undefined;
      return;
    }
    const tooltip = aiUsageTooltip(this.usage, this.app.usage, {
      detail,
      codex: this.codex,
      ...(this.sources.claudeReader ? { claude: this.claude, claudeUsage: this.claudeUsage } : {}),
      now: (this.sources.now ?? Date.now)(),
    });
    const severity = aiUsageSeverity(this.usage);
    const shown = `${text}\n${severity}\n${tooltip}`;
    if (shown === this.shown) return;
    this.item.text = text;
    this.item.backgroundColor = severity && new vscode.ThemeColor(`statusBarItem.${severity}Background`);
    const markdown = new vscode.MarkdownString(tooltip, true);
    markdown.isTrusted = { enabledCommands: COMMANDS };
    markdown.supportHtml = true;
    this.item.tooltip = markdown;
    if (this.shown === undefined) this.item.show();
    this.shown = shown;
  }

  private async update(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('logline').update(key, value, vscode.ConfigurationTarget.Global);
  }

  /** Choose how much the status bar says: from the hover's links, or from a list. */
  async setDetail(detail?: unknown): Promise<void> {
    let level = AI_USAGE_DETAILS.find((known) => known === detail);
    if (!level) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Min', description: 'The fullest limit', level: 'min' as const },
          { label: 'Medium', description: 'The fullest limit, named', level: 'medium' as const },
          { label: 'Max', description: "The fullest limit, and today's tokens", level: 'max' as const },
        ],
        { title: 'AI usage in the status bar' },
      );
      level = picked?.level;
    }
    if (level) await this.update('aiUsage.detail', level);
  }

  async enableCodex(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'Show Codex usage?',
      {
        modal: true,
        detail:
          'Logline reads the session files Codex keeps under ~/.codex for the plan limits it records and the tokens of today. Nothing is sent anywhere.',
      },
      'Show Usage',
    );
    if (choice === 'Show Usage') await this.update('aiUsage.codex', true);
  }

  async enableClaude(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'Show Claude Code usage?',
      {
        modal: true,
        detail:
          'Logline reads the session files Claude Code keeps under ~/.claude/projects for the tokens of today. Claude Code does not record its plan limits there, so there is no percentage to show. Nothing is sent anywhere.',
      },
      'Show Usage',
    );
    if (choice === 'Show Usage') await this.update('aiUsage.claude', true);
  }

  /**
   * Open the agent sessions in the Logs panel, turning their capture on first
   * if the person agrees. `agents` names the ones found in this workspace,
   * such as the rail's offer of Claude Code; without it, both are named.
   */
  async showAgentSessions(agents?: string[]): Promise<void> {
    if (!this.sources.config.get('agentSessions.enabled', false)) {
      const choice = await vscode.window.showInformationMessage(
        'Show agent sessions as logs?',
        {
          modal: true,
          detail: `Logline reads the transcripts ${agentNames(agents)} on this machine, for sessions in this workspace from the last day, and shows each prompt, tool call, and reply beside your app's logs. Nothing is sent anywhere unless you share it with an agent.`,
        },
        'Show Sessions',
      );
      if (choice !== 'Show Sessions') return;
      await this.update('agentSessions.enabled', true);
    }
    this.sources.showAgentSessions?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** `Claude Code keeps`, `Claude Code and Codex keep`: who keeps the transcripts, as the dialog says it. */
export function agentNames(agents?: string[]): string {
  const names = agents?.length ? agents : ['Claude Code', 'Codex', 'Copilot'];
  return names.length === 1 ? `${names[0]} keeps` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} keep`;
}
