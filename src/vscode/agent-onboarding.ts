import * as vscode from 'vscode';
import type { AgentOnboardingStep, OnboardingAgent } from '../core/usage-events';
import { copilotAvailable, hostAgent, type HostAgent } from './agent-setup';

/** Set once the one-step agent setup was offered on this profile, whatever the answer. */
export const AGENT_OFFER_KEY = 'logline.agentOnboarding.offered';
/** How long after startup the offer comes, so it never competes with the window opening. */
export const AGENT_OFFER_DELAY_MS = 20_000;

const AGENT_EXTENSIONS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' } as const;

/** The agent someone most likely debugs with here, and what to call it. */
export interface DetectedAgent {
  kind: OnboardingAgent;
  name: string;
}

/**
 * The agent to set up: the editor's own (Cursor, Windsurf, Kiro) first, then an
 * installed Claude Code or Codex extension, then Copilot.
 */
export function detectAgent(
  host: HostAgent | undefined = hostAgent(),
  installed: (id: string) => boolean = (id) => Boolean(vscode.extensions?.getExtension?.(id)),
  copilot: () => boolean = copilotAvailable,
): DetectedAgent | undefined {
  if (host) return { kind: 'host', name: host.name };
  if (installed(AGENT_EXTENSIONS.claude)) return { kind: 'claude', name: 'Claude Code' };
  if (installed(AGENT_EXTENSIONS.codex)) return { kind: 'codex', name: 'Codex' };
  // A host that cannot list extensions gets no offer: Copilot is only a guess there.
  if (typeof vscode.extensions?.getExtension === 'function' && copilot()) return { kind: 'copilot', name: 'Copilot' };
  return undefined;
}

export interface AgentOnboardingOptions {
  memento: Pick<vscode.Memento, 'get' | 'update'>;
  /** Whether agents already read this window's logs, or will on their own: then there is nothing to offer. */
  ready: () => boolean;
  /** Turn capture on, connect the agent, and share. */
  setUp: (agent: DetectedAgent) => Promise<void>;
  detect?: () => DetectedAgent | undefined;
  record?: (step: AgentOnboardingStep, agent: OnboardingAgent) => void;
  delayMs?: number;
}

/**
 * Offers, once per profile, to let the agent found in this editor read the
 * app's logs: the one job a terminal cannot do, behind what was four steps.
 */
export class AgentOnboarding implements vscode.Disposable {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: AgentOnboardingOptions) {}

  /** Offer a while into the session. */
  start(): void {
    if (this.options.memento.get<boolean>(AGENT_OFFER_KEY)) return;
    this.timer = setTimeout(() => void this.offer(), this.options.delayMs ?? AGENT_OFFER_DELAY_MS);
    this.timer.unref?.();
  }

  /** Offer now if it was never offered and an agent is here; returns whether it asked. */
  async offer(): Promise<boolean> {
    const { memento, record } = this.options;
    if (memento.get<boolean>(AGENT_OFFER_KEY) || this.options.ready()) return false;
    const agent = (this.options.detect ?? detectAgent)();
    if (!agent) return false;
    await Promise.resolve(memento.update(AGENT_OFFER_KEY, true)).catch(() => undefined);
    record?.('offered', agent.kind);
    const answer = await vscode.window.showInformationMessage(
      `Let ${agent.name} read your app's logs while it debugs? Logline captures your terminals and shares their logs with it, with common credentials redacted, in this window and later ones.`,
      'Set Up',
      'Not Now',
    );
    if (answer !== 'Set Up') {
      record?.(answer === 'Not Now' ? 'declined' : 'dismissed', agent.kind);
      return true;
    }
    record?.('accepted', agent.kind);
    await this.options.setUp(agent);
    return true;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** What to ask the agent once it can read the logs. */
export const AGENT_FIRST_PROMPT = 'Check the Logline logs for errors.';

/** The closing message of the setup: what was done, and the two things left to the user. */
export function setupSummary(agent: DetectedAgent, options: { restart: boolean; cmd: boolean }): string {
  return [
    `Logline is set up for ${agent.name}.`,
    options.restart ? `Restart ${agent.name} so it loads Logline.` : '',
    options.cmd
      ? 'Command Prompt cannot be captured: run your app in PowerShell or Git Bash, or with Logline: Run Command.'
      : 'Run your app in a terminal as usual.',
    `Then ask ${agent.name}: "${AGENT_FIRST_PROMPT}"`,
  ]
    .filter(Boolean)
    .join(' ');
}
