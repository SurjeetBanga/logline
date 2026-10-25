import type { ConnectionView, Snapshot } from '../../protocol/messages';
import type { Elements } from '../dom';
import type { EventScope } from '../event-scope';
import type { ViewerState } from '../state';
import type { WebviewApi } from '../types';

type Server = Snapshot['servers'][number];
type Session = Snapshot['sessions'][number];
type RailElements = Pick<Elements, 'sourceRail' | 'railList' | 'railToggle' | 'railStopAll'>;

/** Below this width the rail starts collapsed, unless it was opened or collapsed by hand. */
export const NARROW_PANEL = 520;

const ICONS: Record<string, string> = {
  all: 'M8 2.5l5.5 3L8 8.5 2.5 5.5zM2.5 8.5l5.5 3 5.5-3M2.5 11.2l5.5 3 5.5-3',
  terminal: 'M2.5 4l3.5 3.5L2.5 11M8 12h5.5',
  task: 'M2.5 4.5l1.5 1.5 2.5-2.5M8.5 5h5M2.5 10.5l1.5 1.5 2.5-2.5M8.5 11h5',
  debug:
    'M5.5 6h5v4a2.5 2.5 0 0 1-5 0zM6.5 6V5a1.5 1.5 0 0 1 3 0v1M2.5 8.5h3M10.5 8.5h3M3 12.5l2.6-1.3M13 12.5l-2.6-1.3M3 4.5l2.6 1.5M13 4.5l-2.6 1.5',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  otel: 'M2 3.5h7M4 7.5h8M7 11.5h7',
  cloud: 'M4.5 12.5h7a2.5 2.5 0 0 0 .4-5A3.6 3.6 0 0 0 5 6.7a2.9 2.9 0 0 0-.5 5.8z',
  database:
    'M3 4c0-1 2.2-1.8 5-1.8s5 .8 5 1.8-2.2 1.8-5 1.8S3 5 3 4zM3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8',
  run: 'M5 3l7 5-7 5z',
  stop: 'M4.5 4.5h7v7h-7z',
  add: 'M8 3v10M3 8h10',
  remove: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
};

export function icon(name: string, size = 14): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.terminal);
  svg.append(path);
  return svg as SVGElement;
}

function span(className: string, text = ''): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function iconFor(server: Server): string {
  if (server.taskName || server.kind === 'task') return 'task';
  if (server.kind === 'debug') return 'debug';
  if (server.kind === 'import' || server.kind === 'file') return 'file';
  if (server.kind === 'otel') return 'otel';
  return 'terminal';
}

/** A source's name in the rail: its task, else its label. Status and details go in the tooltip. */
function sourceName(server: Server): string {
  return server.taskName ? `Task: ${server.taskName}` : server.label;
}

function sourceTitle(server: Server): string {
  return [
    sourceName(server),
    server.status === 'idle' ? undefined : server.status,
    server.taskType ? `Task type ${server.taskType}` : undefined,
    server.dependencies?.length
      ? `Dependencies: ${server.dependencies.join(', ')} (${server.dependencyState || 'unknown'})`
      : undefined,
    server.exitReason ? `Exit: ${server.exitReason}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

const noun = (connection: ConnectionView, count: number) =>
  `${connection.language === 'mongo' ? 'document' : connection.sql ? 'row' : 'log'}${count === 1 ? '' : 's'}`;

/** One line under a connection's name: what it is doing, or what it last fetched. */
export function connectionStatus(connection: ConnectionView, format: (value: number) => string): string {
  const last = connection.last;
  if (connection.tailing)
    return last?.error
      ? 'Tail interrupted'
      : `Tailing · ${format(last?.kept ?? 0)} ${noun(connection, last?.kept ?? 0)}`;
  if (last?.running) return 'Fetching…';
  if (last?.error) return 'Last fetch failed';
  if (last) return `${format(last.kept)} ${noun(connection, last.kept)}`;
  return connection.mapped
    ? 'Not fetched yet'
    : connection.language === 'mongo'
      ? 'No log collection · queries only'
      : 'No log table · SQL only';
}

/** What a run is called: its command, else its task or source, never its internal id. */
export function runName(session: Session): string {
  return session.command || (session.taskName ? `Task: ${session.taskName}` : '') || session.server || 'Run';
}

/**
 * The Sources rail: every local source and connection, with its status and
 * the runs of the selected one. Hovering a row offers Run and Stop; the
 * header has Stop all and collapses the rail to a strip of icons.
 */
export function createSourceRail(
  elements: RailElements,
  state: ViewerState,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    selectSource(id: string): void;
    selectRun(id: string): void;
    saveState(): void;
    /** The current filter, sent with a tail that is stopped. */
    query(): string;
    /** The rail was collapsed or opened, so the tabs' rail follows. */
    collapsedChanged?(): void;
  },
) {
  const numbers = new Intl.NumberFormat();
  const format = (value: number) => numbers.format(value);
  let servers: Server[] = [];
  let sessions: Session[] = [];
  let connections: ConnectionView[] = [];
  let signature = '';
  // Each row's remove action by source id, for the Delete key.
  const removers = new Map<string, () => void>();

  function collapsed(): boolean {
    return state.railCollapsed ?? window.innerWidth < NARROW_PANEL;
  }

  function applyCollapsed(): void {
    const value = collapsed();
    elements.sourceRail.classList[value ? 'add' : 'remove']('collapsed');
    elements.railToggle.setAttribute('aria-expanded', String(!value));
    const label = value ? 'Expand sources' : 'Collapse sources';
    elements.railToggle.setAttribute('aria-label', label);
    elements.railToggle.title = label;
  }

  function actionButton(kind: 'run' | 'stop' | 'remove', label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rail-action rail-${kind}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(kind, 13));
    scope.listen(button, 'click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function row(options: {
    id: string;
    name: string;
    icon: string;
    title: string;
    meta?: string;
    status?: string;
    statusClass?: string;
    dot?: string;
    agents?: boolean;
    actions?: HTMLElement[];
  }): HTMLElement {
    const selected = options.id === state.selectedServer;
    const wrapper = document.createElement('div');
    wrapper.className = `rail-row${selected ? ' selected' : ''}`;
    wrapper.dataset.sourceId = options.id;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'rail-select rail-focusable';
    select.dataset.sourceId = options.id;
    select.title = options.title;
    select.tabIndex = selected ? 0 : -1;
    select.setAttribute('aria-current', String(selected));
    const glyph = span('rail-glyph');
    glyph.append(icon(options.icon));
    select.append(glyph);
    const text = span('rail-text');
    text.append(span('rail-name', options.name));
    if (options.status)
      text.append(span(`rail-status${options.statusClass ? ` ${options.statusClass}` : ''}`, options.status));
    select.append(text);
    if (options.agents) {
      const badge = span('rail-agents', '✦');
      badge.title = 'Agents may fetch from this connection';
      select.append(badge);
    }
    if (options.meta) select.append(span('rail-meta', options.meta));
    if (options.dot) {
      const dot = span(`rail-dot ${options.dot}`);
      dot.setAttribute('aria-label', options.dot);
      select.append(dot);
    }
    scope.listen(select, 'click', () => actions.selectSource(options.id));
    wrapper.append(select);
    if (options.actions?.length) {
      wrapper.classList.add('has-actions');
      const group = span('rail-actions');
      group.append(...options.actions);
      wrapper.append(group);
    }
    return wrapper;
  }

  function serverRow(server: Server): HTMLElement {
    const running = server.status === 'running' || server.status === 'stopping';
    const rowActions: HTMLElement[] = [];
    if (server.configured && !running)
      rowActions.push(
        actionButton('run', `Run ${sourceName(server)}`, () => api.postMessage({ type: 'run', serverId: server.id })),
      );
    if (running && server.canStop)
      rowActions.push(
        actionButton('stop', `Stop ${sourceName(server)}`, () =>
          api.postMessage({ type: 'stop', serverId: server.id }),
        ),
      );
    const remove = () => api.postMessage({ type: 'removeSource', serverId: server.id });
    removers.set(server.id, remove);
    rowActions.push(
      actionButton(
        'remove',
        running && server.canStop
          ? `Stop and remove ${sourceName(server)}`
          : `Remove ${sourceName(server)} and its logs`,
        remove,
      ),
    );
    return row({
      id: server.id,
      name: sourceName(server),
      icon: iconFor(server),
      title: sourceTitle(server),
      meta: server.activeSessions > 1 ? `${server.activeSessions} active` : undefined,
      dot:
        server.status === 'running'
          ? 'running'
          : server.status === 'stopping'
            ? 'stopping'
            : server.status === 'failed'
              ? 'failed'
              : server.configured || server.status === 'exited'
                ? 'stopped'
                : undefined,
      actions: rowActions,
    });
  }

  function connectionRow(connection: ConnectionView): HTMLElement {
    const rowActions: HTMLElement[] = [];
    if (connection.tailing)
      rowActions.push(
        actionButton('stop', `Stop tailing ${connection.label}`, () =>
          api.postMessage({
            type: 'connectionTail',
            connectionId: connection.id,
            query: actions.query(),
            enabled: false,
          }),
        ),
      );
    const remove = () => api.postMessage({ type: 'removeConnection', connectionId: connection.id });
    removers.set(connection.sourceId, remove);
    rowActions.push(actionButton('remove', `Remove connection ${connection.label}…`, remove));
    const status = connectionStatus(connection, format);
    return row({
      id: connection.sourceId,
      name: connection.label,
      icon: connection.type === 'datadog' ? 'cloud' : 'database',
      title: `${connection.label} · ${status}`,
      status,
      statusClass: connection.tailing ? 'live' : connection.last?.error ? 'error' : undefined,
      dot: connection.tailing ? 'tailing' : undefined,
      agents: connection.agents,
      actions: rowActions,
    });
  }

  function runRows(): HTMLElement {
    const group = document.createElement('div');
    group.className = 'rail-runs';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Runs');
    const all = runButton('', sessions.length ? `All runs · ${sessions.length}` : 'All runs', '');
    group.append(all);
    // Runs of one command, the usual case, are told apart by when they started; the
    // source's row above already names the command. Different commands keep their names,
    // and so do a connection's or an import's runs, which are named by what they fetched.
    const byTime =
      new Set(sessions.map(runName)).size <= 1 &&
      !sessions.some((session) => session.sourceKind === 'remote' || session.sourceKind === 'import');
    for (const session of sessions) {
      const wrapper = document.createElement('div');
      wrapper.className = 'run-option-row';
      const started = session.startedAt
        ? new Date(session.startedAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            ...(byTime ? { second: '2-digit' } : {}),
          })
        : '';
      const stateText = session.status === 'running' ? 'running' : session.exitReason || session.status;
      const button = byTime
        ? runButton(session.id, started || runName(session), stateText)
        : runButton(session.id, runName(session), [started, stateText].filter(Boolean).join(' · '));
      button.title = [
        runName(session),
        session.cwd,
        session.captureStatus && `Capture: ${session.captureStatus}`,
        session.captureReason,
      ]
        .filter(Boolean)
        .join(' · ');
      wrapper.append(button);
      if ((session.status === 'running' || session.status === 'stopping') && session.canStop === true) {
        const stop = actionButton(
          'stop',
          session.status === 'stopping'
            ? 'This run is stopping'
            : session.sourceKind === 'file'
              ? 'Stop following this file'
              : session.sourceKind === 'debug'
                ? 'Stop this debug session'
                : 'Stop this run',
          () => api.postMessage({ type: 'stop', serverId: session.serverId, sessionId: session.id }),
        );
        stop.classList.add('run-stop');
        stop.dataset.runId = session.id;
        stop.disabled = session.status !== 'running';
        wrapper.append(stop);
      }
      group.append(wrapper);
    }
    return group;
  }

  function runButton(id: string, label: string, meta: string): HTMLButtonElement {
    const selected = id === state.selectedSession;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-select rail-focusable';
    button.dataset.runId = id;
    button.tabIndex = -1;
    button.setAttribute('aria-current', String(selected));
    button.append(span('rail-name', label));
    if (meta) button.append(span('rail-meta', meta));
    scope.listen(button, 'click', () => actions.selectRun(id));
    return button;
  }

  function group(label: string, extra?: HTMLElement): HTMLElement {
    const heading = document.createElement('div');
    heading.className = 'rail-group';
    heading.append(span('rail-group-label', label));
    if (extra) heading.append(extra);
    return heading;
  }

  function addButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'railAddConnection';
    button.className = 'rail-action rail-add';
    button.setAttribute('aria-label', 'Add connection');
    button.title = 'Add a Datadog, Postgres, MySQL, MongoDB, or SQLite connection';
    button.append(icon('add', 13));
    scope.listen(button, 'click', () => api.postMessage({ type: 'addConnection' }));
    return button;
  }

  function render(): void {
    removers.clear();
    const focusedSource = (document.activeElement as HTMLElement | undefined)?.dataset?.sourceId;
    const focusedRun = (document.activeElement as HTMLElement | undefined)?.dataset?.runId;
    const connectionIds = new Set(connections.map((connection) => connection.sourceId));
    const local = servers.filter((server) => !connectionIds.has(server.id));
    const active = servers.reduce((sum, server) => sum + (server.activeSessions || 0), 0);
    const children: HTMLElement[] = [
      row({
        id: '',
        name: 'All sources',
        icon: 'all',
        title: 'Show logs from every source',
        meta: active ? `${active} active` : undefined,
      }),
    ];
    const withRuns = (element: HTMLElement, id: string) => {
      children.push(element);
      if (id && id === state.selectedServer && sessions.length) children.push(runRows());
    };
    if (local.length) children.push(group('Local'));
    for (const server of local) withRuns(serverRow(server), server.id);
    const add = addButton();
    children.push(group('Connections', add));
    if (connections.length)
      for (const connection of connections) withRuns(connectionRow(connection), connection.sourceId);
    else {
      const empty = document.createElement('div');
      empty.className = 'rail-empty';
      const text = document.createElement('p');
      text.textContent = 'Search Datadog, Postgres, MySQL, MongoDB, or SQLite logs next to your local runs.';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail-empty-add';
      button.textContent = 'Add connection';
      scope.listen(button, 'click', () => api.postMessage({ type: 'addConnection' }));
      empty.append(text, button);
      children.push(empty);
    }
    elements.railList.replaceChildren(...children);
    const running =
      servers.some((server) => server.canStop && (server.status === 'running' || server.status === 'stopping')) ||
      connections.some((connection) => connection.tailing);
    elements.railStopAll.hidden = !running;
    const focus = [...elements.railList.querySelectorAll<HTMLElement>('.rail-focusable')].find((node) =>
      focusedRun !== undefined ? node.dataset.runId === focusedRun : node.dataset.sourceId === focusedSource,
    );
    if (focusedSource !== undefined || focusedRun !== undefined) focus?.focus();
  }

  function key(): string {
    return JSON.stringify([
      state.selectedServer,
      state.selectedSession,
      servers.map((server) => [
        server.id,
        server.label,
        server.status,
        server.activeSessions,
        server.taskName,
        server.taskType,
        server.dependencies,
        server.dependencyState,
        server.exitReason,
        server.configured,
        server.kind,
        server.canStop,
      ]),
      sessions.map((session) => [
        session.id,
        session.command,
        session.status,
        session.startedAt,
        session.exitReason,
        session.captureStatus,
        session.canStop,
      ]),
      connections.map((connection) => [
        connection.sourceId,
        connection.label,
        connection.type,
        connection.mapped,
        connection.agents,
        connection.tailing,
        connection.last?.kept,
        connection.last?.running,
        connection.last?.error,
      ]),
    ]);
  }

  /** Render again only when something the rail shows changed. */
  function refresh(force = false): void {
    const next = key();
    if (!force && next === signature) return;
    signature = next;
    render();
  }

  scope.listen(elements.railToggle, 'click', () => {
    state.railCollapsed = !collapsed();
    applyCollapsed();
    actions.saveState();
    actions.collapsedChanged?.();
  });
  scope.listen(elements.railStopAll, 'click', () => {
    api.postMessage({ type: 'stop' });
    for (const connection of connections)
      if (connection.tailing)
        api.postMessage({
          type: 'connectionTail',
          connectionId: connection.id,
          query: actions.query(),
          enabled: false,
        });
  });
  scope.listen(elements.railList, 'keydown', (event) => {
    // Delete removes the focused source, like the terminal list.
    if (event.key === 'Delete') {
      const id = (document.activeElement as HTMLElement | undefined)?.dataset?.sourceId;
      if (id) removers.get(id)?.();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const items = [...elements.railList.querySelectorAll<HTMLElement>('.rail-focusable')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  });
  // An automatic choice follows the panel's width; one made by hand stays.
  scope.listen(window, 'resize', () => {
    if (state.railCollapsed === undefined) applyCollapsed();
  });
  applyCollapsed();

  return {
    /** The rail's data from a snapshot; sessions are those of the selected source. */
    update(next: { servers?: Server[]; sessions?: Session[]; connections?: ConnectionView[] }): void {
      if (next.servers) servers = next.servers;
      if (next.sessions) sessions = next.sessions;
      if (next.connections) connections = next.connections;
      refresh();
    },
    /** The selection changed: show it, and the runs of the newly selected source. */
    selectionChanged(nextSessions?: Session[]): void {
      if (nextSessions) sessions = nextSessions;
      refresh();
    },
    servers: () => servers,
    sessions: () => sessions,
    collapsed,
    applyCollapsed,
  };
}
