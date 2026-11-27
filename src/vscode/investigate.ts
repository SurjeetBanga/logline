import * as vscode from 'vscode';
import type { AgentShareStatus } from '../core/agent-types';
import { InvestigationWatch, investigationPrompt, type InvestigationTarget } from '../core/investigation';
import { groupErrors } from '../core/log-analysis';
import type { LogStore } from '../core/log-store';
import type { SessionSummary } from '../core/types';
import {
  agentsWithSkills,
  copilotAvailable,
  hostAgent,
  installedAgentCli,
  promptCommand,
  type Agent,
} from './agent-setup';
import { counted, type Usage } from './usage';

export type InvestigateAgent = 'copilot' | Agent | 'copy';
/** Where Investigate was started: Analyze, an open event, the editor, the Command Palette, or Investigate Again. */
export type InvestigateFrom = 'analyze' | 'inspector' | 'editor' | 'palette' | 'again';

export interface InvestigatorSources {
  store: Pick<LogStore, 'find' | 'eventsAfter' | 'all' | 'newestFirst'>;
  runs(): Iterable<SessionSummary>;
  shareStatus(): AgentShareStatus;
  /**
   * Share with agents, with the usual warning; resolves when the user has answered. With an
   * anchor, its run alone; with runs, those runs.
   */
  share(sourceIds: string[], anchor?: number, sessionIds?: string[]): Promise<void>;
  /** Open Copilot's chat with a prompt. */
  openChat(prompt: string): Promise<boolean>;
  showQuery(query: string): Promise<void>;
  globalState: Pick<vscode.Memento, 'get' | 'update'>;
  usage?: Usage;
  /** The agents connected with their skills, by name; for tests. */
  connected?: () => string[];
}

const LAST_AGENT_KEY = 'logline.investigateAgent';
const NAMES: Record<InvestigateAgent, string> = {
  copilot: 'GitHub Copilot',
  claude: 'Claude Code',
  codex: 'Codex',
  copy: 'Copy prompt for another agent',
};
// Errors watched for a fix at a time; an older watch gives way.
const MAX_WATCHES = 5;
// Captured events are checked at most this often, as the Logs panel refreshes.
const CHECK_DELAY_MS = 500;

/**
 * Investigate: hands one error to an agent the user has, with the evidence
 * it needs to start, then watches the runs that follow and says whether the
 * error is gone.
 */
export class Investigator implements vscode.Disposable {
  private readonly watches: InvestigationWatch[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly sources: InvestigatorSources) {
    this.disposables.push(
      vscode.commands.registerCommand(
        'logline.investigate',
        counted(sources.usage, 'logline.investigate', (target?: unknown) =>
          isTarget(target) ? this.investigate(target, undefined, 'editor') : this.pickError(),
        ),
      ),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file' || !this.watches.length) return;
        // Events logged before the save are read as before it.
        this.check();
        const last = this.newestId();
        for (const watch of this.watches) watch.saved(Date.now(), last);
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** The agents Investigate can hand an error to here, most recently used first. */
  agents(): InvestigateAgent[] {
    const connected = (this.sources.connected ?? agentsWithSkills)();
    const agents: InvestigateAgent[] = [];
    if (copilotAvailable()) agents.push('copilot');
    if (connected.includes(NAMES.claude)) agents.push('claude');
    if (connected.includes(NAMES.codex)) agents.push('codex');
    agents.push('copy');
    const last = this.sources.globalState.get<InvestigateAgent>(LAST_AGENT_KEY);
    return last && agents.includes(last) ? [last, ...agents.filter((agent) => agent !== last)] : agents;
  }

  /** Hand an error to an agent; resolves to the agent chosen, or undefined when nothing was handed over. */
  async investigate(
    target: InvestigationTarget,
    agent?: InvestigateAgent,
    from: InvestigateFrom = 'editor',
  ): Promise<InvestigateAgent | undefined> {
    const event = this.sources.store.find(target.eventId);
    if (!event) {
      void vscode.window.showInformationMessage('Logline: That error is no longer in the retained logs.');
      return undefined;
    }
    target = { ...target, serverId: target.serverId ?? event.serverId };
    let status = this.sources.shareStatus();
    const shared = () => !target.serverId || status.sources.some((source) => source.id === target.serverId);
    if (target.serverId && !(status.active && shared())) {
      if (!status.active) await this.sources.share([target.serverId], target.eventId);
      else if (status.scope !== 'all') {
        // Add the error's run to what is shared already, so the agent can read the event it starts from.
        const runs = status.sources.flatMap((source) => source.runs.map((run) => run.id));
        await this.sources.share([...status.sources.map((source) => source.id), target.serverId], undefined, [
          ...runs,
          event.sessionId ?? '*',
        ]);
      }
      status = this.sources.shareStatus();
    }
    if (!status.active || !status.shareId || !shared()) return undefined;
    agent ??= await this.chooseAgent();
    if (!agent) return undefined;
    await this.sources.globalState.update(LAST_AGENT_KEY, agent);
    const prompt = investigationPrompt(target, {
      shareId: status.shareId,
      runs: status.sources.flatMap((source) => source.runs.map((run) => run.id)),
      skill: agent === 'claude' ? '/logline-triage' : agent === 'codex' ? '$logline-triage' : undefined,
    });
    this.sources.usage?.record('investigate', { agent, from, ci: target.ci !== undefined });
    if (agent === 'copilot') {
      if (!(await this.sources.openChat(prompt))) return undefined;
    } else if (agent === 'claude' || agent === 'codex') {
      const terminal = vscode.window.createTerminal({
        name: `Logline · ${NAMES[agent]}`,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      terminal.show();
      terminal.sendText(promptCommand(agent, prompt, undefined, installedAgentCli(agent)));
    } else {
      await vscode.env.clipboard.writeText(prompt);
      const host = hostAgent();
      void vscode.window.showInformationMessage(
        `Logline: The investigation prompt was copied. Paste it into ${host ? `${host.name}'s` : "your agent's"} chat; agents connected to Logline can read the shared logs.`,
      );
    }
    this.watch(target);
    return agent;
  }

  /** Check for new events soon; captured events arrive in bursts. */
  schedule(delay = CHECK_DELAY_MS): void {
    if (!this.watches.length || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.check();
    }, delay);
    this.timer.unref?.();
  }

  /** Look at the runs after each investigation for whether its error is gone. */
  check(): void {
    if (!this.watches.length) return;
    const runs = [...this.sources.runs()];
    for (const watch of [...this.watches]) {
      const outcome = watch.check(runs, (afterId) => this.sources.store.eventsAfter(afterId));
      if (!outcome) continue;
      this.watches.splice(this.watches.indexOf(watch), 1);
      const name = shortMessage(watch.target.message);
      if (outcome.state === 'fixed') {
        this.sources.usage?.record('investigate_outcome', { fixed: true });
        const others = outcome.errors
          ? ` It logged ${outcome.errors.toLocaleString()} other ${outcome.errors === 1 ? 'error' : 'errors'}.`
          : ' No other errors were logged.';
        void vscode.window.showInformationMessage(
          `Logline: Fixed locally. ${name} did not happen in ${outcome.events.toLocaleString()} events from ${outcome.run.server} since the change.${others}`,
        );
      } else {
        this.sources.usage?.record('investigate_outcome', { fixed: false });
        void vscode.window
          .showWarningMessage(
            `Logline: Still failing. ${name} happened ${outcome.occurrences === 1 ? 'again' : `${outcome.occurrences.toLocaleString()} more times`} in ${outcome.run.server}.`,
            'Show Error',
            'Investigate Again',
          )
          .then((action) => {
            if (action === 'Show Error') void this.sources.showQuery(`id:${outcome.eventId}`);
            if (action === 'Investigate Again')
              void this.investigate(
                { ...watch.target, eventId: outcome.eventId, count: outcome.occurrences },
                undefined,
                'again',
              );
          });
      }
    }
  }

  private watch(target: InvestigationTarget): void {
    // Without a source there is no run to tell the fix by.
    if (!target.serverId) return;
    const existing = this.watches.findIndex(
      (watch) => watch.target.message === target.message && watch.target.serverId === target.serverId,
    );
    if (existing !== -1) this.watches.splice(existing, 1);
    this.watches.push(new InvestigationWatch(target, Date.now(), this.newestId()));
    if (this.watches.length > MAX_WATCHES) this.watches.shift();
  }

  private newestId(): number {
    return this.sources.store.newestFirst().next().value?.id ?? 0;
  }

  private async chooseAgent(): Promise<InvestigateAgent | undefined> {
    const agents = this.agents();
    if (agents.length === 1) return agents[0];
    const picked = await vscode.window.showQuickPick(
      agents.map((agent) => ({
        label: NAMES[agent],
        description:
          agent === 'copilot'
            ? 'Opens chat in agent mode'
            : agent === 'copy'
              ? 'For the agent in this editor or another tool'
              : 'Starts it in a terminal',
        agent,
      })),
      { title: 'Investigate with', placeHolder: 'Choose the agent to hand this error to' },
    );
    return picked?.agent;
  }

  // From the Command Palette: choose one of the error groups in the retained logs.
  private async pickError(): Promise<InvestigateAgent | undefined> {
    const groups = groupErrors(this.sources.store.all()).slice(0, 30);
    if (!groups.length) {
      void vscode.window.showInformationMessage('Logline: No errors in the retained logs to investigate.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: shortMessage(group.message, 100),
        description: `${group.count.toLocaleString()}×${group.location ? ` · ${group.location}` : ''}`,
        group,
      })),
      { title: 'Investigate an error', placeHolder: 'Choose the error to hand to an agent' },
    );
    if (!picked) return undefined;
    const { group } = picked;
    return this.investigate(
      {
        message: group.message,
        eventId: group.sampleIds[group.sampleIds.length - 1],
        query: group.query,
        count: group.count,
        location: group.location,
      },
      undefined,
      'palette',
    );
  }
}

function shortMessage(message: string, limit = 80): string {
  const line = message.split('\n')[0].trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function isTarget(value: unknown): value is InvestigationTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as InvestigationTarget).message === 'string' &&
    Number.isSafeInteger((value as InvestigationTarget).eventId)
  );
}
