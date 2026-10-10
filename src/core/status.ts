// Logline: Show Status. Each part of Logline that can be off, waiting, or
// broken, with what it is doing and the one step that fixes or starts it.

export interface StatusInput {
  receiver: {
    /** Running for this window, from the setting or the Start command. */
    running: boolean;
    endpoint?: string;
    /** The port asked for at the last start. */
    requestedPort?: number;
    port: number;
    error?: string;
    injectEnvironment: boolean;
    traces: number;
    metricSeries: number;
  };
  agents: {
    /** logline.externalAgents: whether MCP clients can reach this window. */
    enabled: boolean;
    bridgeRunning: boolean;
    /** MCP clients that called recently. */
    clients: string[];
    /** Agents whose skills folder has the Logline skills. */
    skills: string[];
    sharing: { active: boolean; scope?: 'all' | 'selected'; sources: number };
    /** Whether GitHub Copilot Chat is installed, for the Copilot tools and Ask Copilot. */
    copilot: boolean;
  };
  capture: {
    terminal: { state: 'off' | 'waiting' | 'capturing' | 'attention'; detail: string };
    debugSessions: boolean;
    /** Commands, tasks, and followed files running now. */
    running: number;
  };
  retention: { events: number; bytes: number; maxBytes: number; discarded: number; persist: boolean };
  editor: { lenses: boolean; doctor: 'off' | 'security' | 'all'; findings: number; changedFiles?: number };
}

export type StatusState = 'ok' | 'off' | 'problem';

/** A command and its arguments, run when the item is chosen. */
export interface StatusAction {
  label: string;
  command: string;
  args?: unknown[];
}

export interface StatusItem {
  area: string;
  state: StatusState;
  summary: string;
  /** Why, and what the action changes. */
  detail?: string;
  action?: StatusAction;
}

const setting = (label: string, id: string): StatusAction => ({
  label,
  command: 'workbench.action.openSettings',
  args: [id],
});
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function statusItems(input: StatusInput): StatusItem[] {
  const { receiver, agents, capture, retention, editor } = input;
  const items: StatusItem[] = [];

  if (receiver.error && !receiver.running)
    items.push({
      area: 'OpenTelemetry receiver',
      state: 'problem',
      summary: receiver.error,
      detail: `Another process may be using port ${receiver.port}, often a collector or another Logline window. Choose a free port or stop the other process.`,
      action: setting('Change the receiver port', 'logline.otlp.port'),
    });
  else if (receiver.running) {
    // While running, an error means the asked-for port was taken and another one is in use.
    const received = `${plural(receiver.traces, 'trace')}, ${receiver.metricSeries.toLocaleString()} metric series`;
    items.push(
      receiver.error
        ? {
            area: 'OpenTelemetry receiver',
            state: 'problem',
            summary: receiver.error,
            detail: `Apps Logline starts are pointed at the new port, but apps configured for port ${receiver.requestedPort ?? receiver.port} send their telemetry to whatever is using it. Free the port or set logline.otlp.port.`,
            action: setting('Change the receiver port', 'logline.otlp.port'),
          }
        : {
            area: 'OpenTelemetry receiver',
            state: 'ok',
            summary: `Receiving on ${receiver.endpoint} · ${received}`,
            detail: receiver.injectEnvironment
              ? 'New servers, tasks, debug sessions, and terminals send their telemetry here.'
              : 'Environment injection is off: set OTEL_EXPORTER_OTLP_ENDPOINT in your apps yourself.',
            action: { label: 'Stop the receiver', command: 'logline.stopOtlpReceiver' },
          },
    );
  } else
    items.push({
      area: 'OpenTelemetry receiver',
      state: 'off',
      summary: 'Not running',
      detail: 'Start it to receive logs, traces, and metrics from instrumented apps without a collector.',
      action: { label: 'Start the receiver', command: 'logline.startOtlpReceiver' },
    });

  if (!agents.enabled)
    items.push({
      area: 'Claude Code and Codex',
      state: 'off',
      summary: 'Off: logline.externalAgents is false',
      detail:
        'MCP clients cannot reach this window. Turn the setting on to use Logline from Claude Code, Codex, or other MCP clients.',
      action: setting('Turn on external agents', 'logline.externalAgents'),
    });
  else if (!agents.bridgeRunning)
    items.push({
      area: 'Claude Code and Codex',
      state: 'problem',
      summary: 'Not accepting MCP clients',
      detail:
        'The local connection for agents did not start. Reload the window to try again; the Logline output in the developer tools console says why.',
      action: { label: 'Reload window', command: 'workbench.action.reloadWindow' },
    });
  else if (agents.clients.length)
    items.push({
      area: 'Claude Code and Codex',
      state: 'ok',
      summary: `Used recently by ${agents.clients.join(', ')}`,
      detail: agents.skills.length
        ? `Logline skills are installed for ${agents.skills.join(' and ')}.`
        : 'Connect again to add the Logline skills: verify a change, triage errors, explain a slow request.',
      action: { label: 'Connect another agent', command: 'logline.connectAgent' },
    });
  else
    items.push({
      area: 'Claude Code and Codex',
      state: 'off',
      summary: agents.skills.length ? `Set up for ${agents.skills.join(' and ')}; no calls yet` : 'No agent connected',
      detail: agents.skills.length
        ? 'Restart the agent if it was open while you connected it, then ask it about the logs.'
        : 'Register the Logline MCP server and skills with Claude Code or Codex.',
      action: { label: 'Connect Claude Code or Codex', command: 'logline.connectAgent' },
    });

  items.push(
    agents.sharing.active
      ? {
          area: 'Sharing with agents',
          state: 'ok',
          summary:
            agents.sharing.scope === 'all'
              ? `Sharing all sources and new runs (${plural(agents.sharing.sources, 'source')})`
              : `Sharing ${plural(agents.sharing.sources, 'selected source')}`,
          detail: 'Agents read redacted logs from these sources only.',
          action: { label: 'Stop sharing', command: 'logline.stopSharing' },
        }
      : {
          area: 'Sharing with agents',
          state: 'off',
          summary: 'Nothing shared',
          detail: 'Agents can only read logs you share. Until then their Logline tools report that nothing is shared.',
          action: { label: 'Share logs with agent', command: 'logline.shareWithAgent' },
        },
  );

  if (!agents.copilot)
    items.push({
      area: 'GitHub Copilot',
      state: 'off',
      summary: 'Not installed',
      detail:
        'Ask Copilot and Fix with Copilot need GitHub Copilot Chat. Everything else works without it, and Claude Code or Codex can read shared logs instead.',
    });

  const terminal = capture.terminal;
  items.push({
    area: 'Terminal capture',
    state: terminal.state === 'attention' ? 'problem' : terminal.state === 'off' ? 'off' : 'ok',
    summary: terminal.state === 'off' ? 'Off' : terminal.detail,
    detail:
      terminal.state === 'off'
        ? 'Turn it on to capture commands you run in VS Code terminals without wrapping them.'
        : terminal.state === 'attention'
          ? terminal.detail
          : undefined,
    action:
      terminal.state === 'off'
        ? { label: 'Enable terminal capture', command: 'logline.enableTerminalCapture' }
        : { label: 'Manage terminal capture', command: 'logline.manageTerminalCapture' },
  });
  if (!capture.debugSessions)
    items.push({
      area: 'Debug sessions',
      state: 'off',
      summary: 'Not captured',
      detail: 'Debug Console output from F5 sessions does not reach the Logs panel.',
      action: setting('Capture debug sessions', 'logline.captureDebugSessions'),
    });

  const full = retention.maxBytes > 0 && retention.bytes >= retention.maxBytes * 0.9;
  items.push({
    area: 'Retention',
    state: full && retention.discarded ? 'problem' : 'ok',
    summary: `${retention.events.toLocaleString()} events · ${mb(retention.bytes)} of ${mb(retention.maxBytes)}${retention.discarded ? ` · ${retention.discarded.toLocaleString()} discarded` : ''}`,
    detail:
      full && retention.discarded
        ? 'The oldest events are being dropped to stay within logline.maxMemoryMb. Raise it to keep more history.'
        : retention.persist
          ? 'Captured output is also written to .logline/latest.log.'
          : undefined,
    action: full && retention.discarded ? setting('Raise the memory limit', 'logline.maxMemoryMb') : undefined,
  });

  items.push(
    editor.lenses
      ? {
          area: 'Log lenses and log doctor',
          state: 'ok',
          summary: `Lenses on · log doctor ${editor.doctor === 'off' ? 'off' : `${editor.doctor === 'security' ? 'security checks only' : 'on'}, ${plural(editor.findings, 'finding')}`}`,
          action: editor.findings
            ? { label: 'Open the log health report', command: 'logline.showLogHealth' }
            : undefined,
        }
      : {
          area: 'Log lenses and log doctor',
          state: 'off',
          summary: 'Lenses off',
          detail:
            'Without lenses, events are not matched to the statements that logged them: no hit counts, Break here, statement checks, or My changes from log statements.',
          action: setting('Turn on log lenses', 'logline.logLenses'),
        },
  );

  items.push(
    editor.changedFiles === undefined
      ? {
          area: 'My changes',
          state: 'off',
          summary: 'Not a git repository, or the Git extension is off',
          detail: 'My changes and changed:true need the built-in Git extension and a repository.',
        }
      : {
          area: 'My changes',
          state: 'ok',
          summary: `${plural(editor.changedFiles, 'file')} changed since the last commit`,
        },
  );
  if (capture.running)
    items.unshift({
      area: 'Capture',
      state: 'ok',
      summary: `${capture.running.toLocaleString()} running: commands, tasks, and followed files`,
    });
  return items;
}

/** Plain text for an issue report or a message. */
export function statusText(items: readonly StatusItem[], version: string): string {
  const marks: Record<StatusState, string> = { ok: '✓', off: '–', problem: '!' };
  return [
    `Logline ${version} status`,
    ...items.map(
      (item) => `${marks[item.state]} ${item.area}: ${item.summary}${item.detail ? `\n    ${item.detail}` : ''}`,
    ),
  ].join('\n');
}
