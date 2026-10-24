import type { ConnectionView, HostMessage } from '../../protocol/messages';
import type { getElements } from '../dom';
import type { EventScope } from '../event-scope';
import type { ViewerState } from '../state';
import type { WebviewApi } from '../types';

type Elements = Pick<
  ReturnType<typeof getElements>,
  | 'connectionBar'
  | 'connectionRange'
  | 'connectionRun'
  | 'connectionTail'
  | 'connectionSql'
  | 'connectionPreview'
  | 'connectionResult'
  | 'connectionCompare'
  | 'connectionLink'
  | 'connectionAgents'
>;
type Preview = Extract<HostMessage, { type: 'connectionPreview' }>;

const PREVIEW_DELAY_MS = 250;

/**
 * The controls shown while a connection is the selected source: a time range,
 * Run, Tail, and Run SQL. Nothing is fetched until Run or Tail is pressed. A
 * preview shows the SQL the filter becomes, and which terms only Logline can
 * apply; the result line says how many rows the last fetch brought back.
 */
export function createConnectionBar(
  elements: Elements,
  state: ViewerState,
  api: WebviewApi,
  scope: EventScope,
  query: () => string,
  saveState: () => void,
  /** Compare a run of the connection with local runs. */
  compare: (baselineServerId: string, baselineSessionId: string) => void,
) {
  let connections: ConnectionView[] = [];
  let previewKey = '';
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const numbers = new Intl.NumberFormat();
  const selected = () => connections.find((connection) => connection.sourceId === state.selectedServer);

  // A database has rows; Datadog has logs.
  const noun = (connection: ConnectionView, count: number) =>
    `${connection.sql ? 'row' : 'log'}${count === 1 ? '' : 's'}`;

  function resultText(connection: ConnectionView): string {
    const last = connection.last;
    if (!last)
      return connection.mapped
        ? 'Choose a range and press Run. Nothing is fetched until you do.'
        : 'No log table is mapped. Use Run SQL to query it.';
    const rows = `${numbers.format(last.kept)} ${noun(connection, last.kept)}`;
    if (last.kind === 'tail')
      return !last.running
        ? `Tail stopped · ${rows}`
        : last.error
          ? `Tail interrupted: ${last.error}`
          : `Tailing · ${rows}`;
    if (last.running) return 'Fetching…';
    if (last.error) return `Failed: ${last.error}`;
    const of = last.total !== undefined && last.total > last.fetched ? ` of ${numbers.format(last.total)}` : '';
    const kept = last.kept < last.fetched ? ` · ${numbers.format(last.kept)} match the filter` : '';
    const time = last.elapsedMs !== undefined ? ` · ${numbers.format(last.elapsedMs)} ms` : '';
    return `Fetched ${numbers.format(last.fetched)}${of} ${noun(connection, last.fetched)}${kept}${time} · read-only`;
  }

  function render(): void {
    const connection = selected();
    elements.connectionBar.hidden = !connection;
    if (!connection) {
      clearTimeout(previewTimer);
      previewKey = '';
      return;
    }
    const busy = connection.last?.running === true && connection.last.kind !== 'tail';
    elements.connectionRange.value = state.connectionRange;
    elements.connectionRange.disabled = !connection.mapped;
    elements.connectionRun.disabled = !connection.mapped || busy;
    elements.connectionRun.title = connection.mapped
      ? `Fetch the newest rows from ${connection.label} in this range that match the filter`
      : 'Map a log table to search it; Run SQL works without one';
    elements.connectionTail.disabled = !connection.mapped;
    elements.connectionTail.setAttribute('aria-pressed', String(connection.tailing));
    elements.connectionTail.textContent = connection.tailing ? 'Stop tail' : 'Tail';
    elements.connectionTail.title = connection.tailing
      ? 'Stop reading new rows'
      : 'Show the newest matching rows, then keep reading rows as they are added';
    elements.connectionResult.textContent = resultText(connection);
    // The run to compare: the one selected in the run picker, else the latest.
    elements.connectionCompare.hidden = !connection.last || connection.last.kind === 'tail';
    elements.connectionSql.hidden = !connection.sql;
    elements.connectionAgents.hidden = !connection.mapped;
    elements.connectionAgents.setAttribute('aria-pressed', String(!!connection.agents));
    elements.connectionAgents.textContent = connection.agents ? 'Agents allowed' : 'Allow agents';
    elements.connectionAgents.title = connection.agents
      ? 'Agents you share logs with can fetch logs from this connection. Click to stop them.'
      : 'Let agents you share logs with fetch logs from this connection';
    elements.connectionLink.hidden = connection.type !== 'datadog';
    elements.connectionResult.title = connection.last?.statement ?? '';
    elements.connectionResult.classList[connection.last?.error ? 'add' : 'remove']('connection-error');
    if (!connection.mapped) elements.connectionPreview.textContent = '';
    else requestPreview(connection);
  }

  function requestPreview(connection = selected()): void {
    if (!connection?.mapped) return;
    const message = {
      type: 'connectionPreview' as const,
      connectionId: connection.id,
      query: query(),
      range: state.connectionRange,
    };
    const key = JSON.stringify(message);
    if (key === previewKey) return;
    previewKey = key;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => api.postMessage(message), PREVIEW_DELAY_MS);
  }

  function receivePreview(preview: Preview): void {
    const connection = selected();
    const { type, connectionId, query, range } = preview;
    if (!connection || JSON.stringify({ type, connectionId, query, range }) !== previewKey) return;
    const note = elements.connectionPreview;
    note.classList[preview.error ? 'add' : 'remove']('connection-error');
    if (preview.error) {
      note.textContent = preview.error;
      note.title = '';
      return;
    }
    const local = preview.local.length ? ` · Filtered locally: ${preview.local.join(' ')}` : '';
    const sends = connection.sql ? 'Runs as' : 'Datadog search';
    note.textContent = preview.statement ? `${sends}: ${preview.statement}${local}` : '';
    note.title = preview.statement
      ? `${preview.statement}${preview.local.length ? `\n\nTerms SQL cannot express are applied to the fetched rows: ${preview.local.join(' ')}` : ''}`
      : '';
  }

  function run(): boolean {
    const connection = selected();
    if (!connection) return false;
    if (connection.mapped)
      api.postMessage({
        type: 'connectionFetch',
        connectionId: connection.id,
        query: query(),
        range: state.connectionRange,
      });
    else api.postMessage({ type: 'connectionSql', connectionId: connection.id });
    return true;
  }

  scope.listen(elements.connectionRange, 'change', () => {
    state.connectionRange = elements.connectionRange.value;
    saveState();
    requestPreview();
  });
  scope.listen(elements.connectionRun, 'click', () => run());
  scope.listen(elements.connectionTail, 'click', () => {
    const connection = selected();
    if (connection)
      api.postMessage({
        type: 'connectionTail',
        connectionId: connection.id,
        query: query(),
        enabled: !connection.tailing,
      });
  });
  scope.listen(elements.connectionCompare, 'click', () => {
    const connection = selected();
    const run = state.selectedSession || connection?.last?.sessionId;
    if (connection && run) compare(connection.sourceId, run);
  });
  scope.listen(elements.connectionAgents, 'click', () => {
    const connection = selected();
    if (connection)
      api.postMessage({ type: 'connectionAgents', connectionId: connection.id, enabled: !connection.agents });
  });
  scope.listen(elements.connectionLink, 'click', () => {
    const connection = selected();
    if (connection) api.postMessage({ type: 'connectionLink', connectionId: connection.id });
  });
  scope.listen(elements.connectionSql, 'click', () => {
    const connection = selected();
    if (connection) api.postMessage({ type: 'connectionSql', connectionId: connection.id });
  });
  scope.track(() => clearTimeout(previewTimer));

  return {
    update(list: ConnectionView[] | undefined): void {
      connections = list ?? [];
      render();
    },
    render,
    receivePreview,
    /** The filter changed: refresh the preview of the SQL it becomes. */
    queryChanged: () => requestPreview(),
    /** Fetch from the selected connection; false when no connection is selected. */
    run,
    connections: () => connections,
    /** What the empty table says while a connection is selected, or undefined for other sources. */
    emptyText(): string | undefined {
      const connection = selected();
      if (!connection) return undefined;
      if (connection.last) return 'No matching rows. Change the filter or the range and press Run.';
      return connection.mapped
        ? `Choose a range and press Run to fetch ${connection.sql ? 'rows' : 'logs'} from ${connection.label}.`
        : `Use Run SQL to query ${connection.label}.`;
    },
  };
}
