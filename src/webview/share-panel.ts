import type { AgentSetupView, ConnectionView, Snapshot } from '../protocol/messages';
import type { Elements } from './dom';
import type { EventScope } from './event-scope';
import type { WebviewApi } from './types';

type ShareElements = Pick<
  Elements,
  | 'shareAgent'
  | 'shareMenuButton'
  | 'sharePanel'
  | 'shareState'
  | 'shareScopeAll'
  | 'shareScopeRuns'
  | 'shareRunsHint'
  | 'shareSpecificRuns'
  | 'shareAgentList'
  | 'shareProduction'
  | 'shareConnectionList'
  | 'shareToggle'
  | 'statusAction'
>;

interface AgentRow {
  name: string;
  detail: string;
  state?: { text: string; tone: 'ready' | 'muted' };
  connect?: 'claude' | 'codex';
}

/** Each agent, with whether it can read what is shared and how to set it up when it cannot. */
export function agentRows(setup: AgentSetupView | undefined, readers: string[] = []): AgentRow[] {
  const rows: AgentRow[] = [
    setup?.copilot === false
      ? {
          name: 'GitHub Copilot',
          detail: 'Install GitHub Copilot Chat to use it',
          state: { text: 'Not installed', tone: 'muted' },
        }
      : {
          name: 'GitHub Copilot',
          detail: 'Built in · reads shared logs from agent chat',
          state: { text: 'Ready', tone: 'ready' },
        },
  ];
  for (const [name, agent] of [
    ['Claude Code', 'claude'],
    ['Codex', 'codex'],
  ] as const) {
    if (setup && !setup.external)
      rows.push({
        name,
        detail: 'Turn on logline.externalAgents to connect it',
        state: { text: 'Off', tone: 'muted' },
      });
    else if (readers.includes(name))
      rows.push({
        name,
        detail: 'Read shared logs in the last few minutes',
        state: { text: 'Reading', tone: 'ready' },
      });
    else if (setup?.connected.includes(name))
      rows.push({ name, detail: 'Set up · reads what you share', state: { text: 'Connected', tone: 'ready' } });
    else rows.push({ name, detail: 'Not set up in this editor yet', connect: agent });
  }
  return rows;
}

/**
 * Share with agent as a split button: the button starts and stops sharing,
 * and its arrow opens a panel with what agents can read, which agents are
 * set up, and which connections they may fetch from.
 */
export function createSharePanel(
  elements: ShareElements,
  api: WebviewApi,
  scope: EventScope,
  createPopover: (
    container: HTMLElement,
    button: HTMLElement,
    panel: HTMLElement,
  ) => { open(): void; close(restore?: boolean): void },
) {
  let sharing = false;
  let scopeAll = true;
  let signature = '';
  const popover = createPopover(
    elements.shareMenuButton.closest<HTMLElement>('.popover-container')!,
    elements.shareMenuButton,
    elements.sharePanel,
  );

  function agentList(rows: AgentRow[]): HTMLElement[] {
    return rows.map((row) => {
      const item = document.createElement('div');
      item.className = 'share-agent';
      const text = document.createElement('span');
      text.className = 'share-agent-text';
      const name = document.createElement('span');
      name.className = 'share-agent-name';
      name.textContent = row.name;
      const detail = document.createElement('span');
      detail.className = 'share-hint';
      detail.textContent = row.detail;
      text.append(name, detail);
      item.append(text);
      if (row.state) {
        const state = document.createElement('span');
        state.className = `share-agent-state ${row.state.tone}`;
        state.textContent = row.state.text;
        item.append(state);
      }
      if (row.connect) {
        const agent = row.connect;
        const connect = document.createElement('button');
        connect.type = 'button';
        connect.className = 'share-connect';
        connect.textContent = 'Connect…';
        connect.title = `Register Logline's MCP server and skills with ${row.name}`;
        scope.listen(connect, 'click', () => {
          popover.close();
          api.postMessage({ type: 'connectAgent', agent });
        });
        item.append(connect);
      }
      return item;
    });
  }

  function connectionList(connections: ConnectionView[]): HTMLElement[] {
    return connections.map((connection) => {
      const item = document.createElement('div');
      item.className = 'share-connection';
      const name = document.createElement('span');
      name.className = 'share-agent-name';
      name.textContent = connection.label;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'share-allow';
      toggle.setAttribute('aria-pressed', String(connection.agents));
      toggle.textContent = connection.agents ? 'Allowed' : 'Allow';
      toggle.title = connection.agents
        ? `Agents may fetch logs from ${connection.label}. Click to stop them.`
        : `Let agents you share with fetch logs from ${connection.label}`;
      scope.listen(toggle, 'click', () =>
        api.postMessage({ type: 'connectionAgents', connectionId: connection.id, enabled: !connection.agents }),
      );
      item.append(name, toggle);
      return item;
    });
  }

  // The button and Start sharing both share what the panel's scope says.
  const toggleSharing = () => {
    if (sharing) api.postMessage({ type: 'stopSharing' });
    else if (scopeAll) api.postMessage({ type: 'shareWithAgent' });
    else api.postMessage({ type: 'shareWithAgent', chooseRuns: true });
  };
  scope.listen(elements.shareAgent, 'click', toggleSharing);
  scope.listen(elements.shareToggle, 'click', toggleSharing);
  // Everything takes effect at once while sharing; otherwise it is what Start sharing shares.
  scope.listen(elements.shareScopeAll, 'change', () => {
    scopeAll = true;
    elements.shareSpecificRuns.hidden = true;
    if (sharing) api.postMessage({ type: 'shareWithAgent' });
  });
  scope.listen(elements.shareScopeRuns, 'change', () => {
    scopeAll = false;
    elements.shareSpecificRuns.hidden = false;
    if (sharing) api.postMessage({ type: 'shareWithAgent', chooseRuns: true });
  });
  scope.listen(elements.shareSpecificRuns, 'click', () =>
    api.postMessage({ type: 'shareWithAgent', chooseRuns: true }),
  );
  scope.listen(elements.statusAction, 'click', () => {
    popover.close();
    api.postMessage({ type: 'showStatus' });
  });

  return {
    open: () => popover.open(),
    update(data: Pick<Snapshot, 'agentSharing' | 'agentSetup' | 'agentClients' | 'connections'>): void {
      const status = data.agentSharing;
      sharing = Boolean(status?.active);
      const runs = sharing
        ? status.sources.reduce((sum, source) => sum + (source.runs?.length ?? source.sessions), 0)
        : 0;
      if (sharing) scopeAll = status.scope !== 'selected';
      elements.shareState.textContent = sharing
        ? scopeAll
          ? 'On · everything'
          : `On · ${runs} run${runs === 1 ? '' : 's'}`
        : 'Off';
      elements.shareState.classList[sharing ? 'add' : 'remove']('on');
      elements.shareScopeAll.checked = scopeAll;
      elements.shareScopeRuns.checked = !scopeAll;
      elements.shareSpecificRuns.hidden = scopeAll;
      elements.shareRunsHint.textContent =
        sharing && !scopeAll
          ? `${runs} run${runs === 1 ? '' : 's'} shared; later commands stay private`
          : 'Choose runs; later commands stay private';
      elements.shareToggle.textContent = sharing ? 'Stop sharing' : 'Start sharing';
      elements.shareToggle.classList[sharing ? 'remove' : 'add']('primary');
      elements.shareMenuButton.classList[sharing ? 'add' : 'remove']('sharing');
      // Agents fetch with a search, so a database without a mapped log table cannot be offered.
      const connections = (data.connections ?? []).filter((connection) => connection.mapped);
      const next = JSON.stringify([
        data.agentSetup,
        data.agentClients,
        connections.map((connection) => [connection.id, connection.label, connection.agents]),
      ]);
      if (next === signature) return;
      signature = next;
      elements.shareAgentList.replaceChildren(...agentList(agentRows(data.agentSetup, data.agentClients)));
      elements.shareProduction.hidden = !connections.length;
      elements.shareConnectionList.replaceChildren(...connectionList(connections));
    },
  };
}
