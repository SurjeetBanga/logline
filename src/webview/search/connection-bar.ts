import { queryTokens } from '../../core/query-tokens';
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
  | 'connectionSyntax'
  | 'connectionNative'
  | 'connectionService'
  | 'connectionServiceLabel'
>;
type Preview = Extract<HostMessage, { type: 'connectionPreview' }>;
type Services = Extract<HostMessage, { type: 'connectionServices' }>;

const PREVIEW_DELAY_MS = 250;
// The services a connection lists are asked again after this long, or for another range; a failed answer sooner.
const SERVICES_TTL_MS = 5 * 60000;
const SERVICES_RETRY_MS = 30000;
const SERVICE_TERM = /^@?service:/i;

/** The `service:` value of a query, without quotes, or '' when it has none. */
export function serviceOf(text: string): string {
  const term = queryTokens(text).find((token) => SERVICE_TERM.test(token));
  if (!term) return '';
  const value = term.slice(term.indexOf(':') + 1);
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

/** The query with its `service:` terms replaced by one for `service`, or removed when it is ''. */
export function withService(text: string, service: string): string {
  const kept = queryTokens(text).filter((token) => !SERVICE_TERM.test(token));
  if (service) kept.push(`service:${/[\s"():]/.test(service) ? JSON.stringify(service) : service}`);
  return kept.join(' ');
}

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
  /** Replace the filter, such as with a service chosen in the list. */
  setQuery: (query: string) => void,
) {
  let connections: ConnectionView[] = [];
  let previewKey = '';
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which connection and range the listed services are for, and until when they stand. */
  let services: { key: string; until: number } | undefined;
  let servicesAsked = '';
  /** The services the list shows. */
  let listed: string[] = [];
  /** The Datadog search the filter became, from the last preview. */
  let statement = '';
  const numbers = new Intl.NumberFormat();
  const selected = () => connections.find((connection) => connection.sourceId === state.selectedServer);

  // A database has rows; Datadog has logs.
  const noun = (connection: ConnectionView, count: number) =>
    `${connection.language === 'mongo' ? 'document' : connection.sql ? 'row' : 'log'}${count === 1 ? '' : 's'}`;

  /** Whether Run and Tail send the Datadog query as typed, rather than the filter. */
  const native = (connection: ConnectionView) => connection.type === 'datadog' && state.datadogSyntax;
  /** What Run and Tail search: the filter, or the Datadog query as typed (all logs when it is empty). */
  const search = (connection: ConnectionView) =>
    native(connection) ? { query: query(), native: state.datadogQuery.trim() || '*' } : { query: query() };
  /** Whether the connection is tailing something other than what Run and Tail would search now. */
  const retargets = (connection: ConnectionView) => {
    const tail = connection.tail;
    if (!connection.tailing || !tail) return false;
    const now = search(connection);
    return tail.query !== (now.native ?? now.query) || tail.native !== native(connection);
  };

  function resultText(connection: ConnectionView): string {
    const last = connection.last;
    if (!last)
      return connection.mapped
        ? 'Choose a range and press Run. Nothing is fetched until you do.'
        : connection.language === 'mongo'
          ? 'No log collection is mapped. Use Run query to query it.'
          : 'No log table is mapped. Use Run SQL to query it.';
    const rows = `${numbers.format(last.kept)} ${noun(connection, last.kept)}`;
    if (last.kind === 'tail') {
      const following = last.query?.trim() || 'all logs';
      return !last.running
        ? `Tail of ${following} stopped · ${rows}`
        : last.error
          ? `Tail of ${following} interrupted: ${last.error}`
          : `Tailing ${following} · ${rows}`;
    }
    if (last.running)
      return last.firstMs !== undefined
        ? `Showing the newest ${numbers.format(last.kept)} ${noun(connection, last.kept)} · reading the rest…`
        : 'Fetching…';
    if (last.error) return `Failed: ${last.error}`;
    const of = last.total !== undefined && last.total > last.fetched ? ` of ${numbers.format(last.total)}` : '';
    const kept = last.kept < last.fetched ? ` · ${numbers.format(last.kept)} match the filter` : '';
    // Where the time went: waiting for the store, or showing what it returned.
    const store = connection.type === 'datadog' ? 'Datadog' : connection.language === 'mongo' ? 'MongoDB' : 'database';
    const ms = (value: number) => `${numbers.format(value)} ms`;
    const time = [
      last.elapsedMs !== undefined ? ` · ${store} ${ms(last.elapsedMs)}` : '',
      last.processMs !== undefined ? ` · shown in ${ms(last.processMs)}` : '',
      last.firstMs !== undefined ? ` · first rows after ${ms(last.firstMs)}` : '',
    ].join('');
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
    const busy = connection.last?.running === true && connection.last.kind === 'fetch';
    elements.connectionRange.value = state.connectionRange;
    elements.connectionRange.disabled = !connection.mapped;
    // Run while a search runs replaces it, so a changed filter need not wait for the old one.
    elements.connectionRun.disabled = !connection.mapped;
    elements.connectionRun.title = !connection.mapped
      ? 'Map a log table to search it; Run SQL works without one'
      : busy
        ? 'Stop the search that is running, and fetch with this filter instead'
        : `Fetch the newest rows from ${connection.label} in this range that match the filter`;
    elements.connectionTail.disabled = !connection.mapped;
    elements.connectionTail.setAttribute('aria-pressed', String(connection.tailing));
    // A tail follows the filter it started with; once the filter changes, Tail follows the new one instead.
    const retarget = retargets(connection);
    elements.connectionTail.textContent = retarget ? 'Tail this filter' : connection.tailing ? 'Stop tail' : 'Tail';
    elements.connectionTail.title = retarget
      ? `Stop following ${connection.tail?.query.trim() || 'all logs'} and follow this filter instead`
      : connection.tailing
        ? 'Stop reading new rows'
        : 'Show the newest matching rows, then keep reading rows as they are added';
    elements.connectionResult.textContent = resultText(connection);
    // The run to compare: the one selected in the run picker, else the latest.
    elements.connectionCompare.hidden = !connection.last || connection.last.kind === 'tail';
    elements.connectionSql.hidden = !connection.sql;
    elements.connectionSql.textContent = connection.language === 'mongo' ? 'Run query…' : 'Run SQL…';
    elements.connectionSql.title =
      connection.language === 'mongo'
        ? 'Run a read-only filter or pipeline you type, in JSON'
        : 'Run a read-only SELECT you type';
    elements.connectionAgents.hidden = !connection.mapped;
    elements.connectionAgents.setAttribute('aria-pressed', String(!!connection.agents));
    elements.connectionAgents.textContent = connection.agents ? 'Agents allowed' : 'Allow agents';
    elements.connectionAgents.title = connection.agents
      ? 'Agents you share logs with can fetch logs from this connection. Click to stop them.'
      : 'Let agents you share logs with fetch logs from this connection';
    elements.connectionLink.hidden = connection.type !== 'datadog';
    elements.connectionResult.title = connection.last?.statement ?? '';
    elements.connectionResult.classList[connection.last?.error ? 'add' : 'remove']('connection-error');
    const datadog = connection.type === 'datadog' && connection.mapped;
    elements.connectionSyntax.hidden = !datadog;
    elements.connectionSyntax.setAttribute('aria-pressed', String(native(connection)));
    elements.connectionNative.hidden = !native(connection);
    if (elements.connectionNative.value !== state.datadogQuery) elements.connectionNative.value = state.datadogQuery;
    elements.connectionServiceLabel.hidden = !datadog;
    if (datadog) {
      requestServices(connection);
      showService(connection);
    }
    if (!connection.mapped) elements.connectionPreview.textContent = '';
    else if (native(connection)) {
      // Nothing to translate: the query goes as typed, and the filter only narrows what is shown.
      clearTimeout(previewTimer);
      previewKey = '';
      elements.connectionPreview.classList.remove('connection-error');
      elements.connectionPreview.textContent =
        'Run and Tail send the Datadog query as typed; the filter above narrows what is shown.';
      elements.connectionPreview.title = '';
    } else requestPreview(connection);
  }

  function requestServices(connection: ConnectionView): void {
    const key = `${connection.id}\n${state.connectionRange}`;
    if ((services?.key === key && Date.now() < services.until) || servicesAsked === key) return;
    servicesAsked = key;
    api.postMessage({ type: 'connectionServices', connectionId: connection.id, range: state.connectionRange });
  }

  function receiveServices(answer: Services): void {
    const key = `${answer.connectionId}\n${answer.range}`;
    if (key !== servicesAsked) return;
    servicesAsked = '';
    services = { key, until: Date.now() + (answer.error ? SERVICES_RETRY_MS : SERVICES_TTL_MS) };
    const select = elements.connectionService;
    const any = document.createElement('option');
    any.value = '';
    any.textContent = 'Any service';
    const options = answer.services.map(({ name, count }) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = `${name} · ${numbers.format(count)}`;
      return option;
    });
    select.replaceChildren(any, ...options);
    listed = answer.services.map((service) => service.name);
    select.title = answer.error
      ? `Could not list services: ${answer.error}`
      : "Search or tail one service's logs; services are listed by how many logs they had in the range";
    const connection = selected();
    if (connection) showService(connection);
  }

  /** Show the service the query names in the list; one the list lacks is added, so it still shows. */
  function showService(connection: ConnectionView): void {
    const service = serviceOf(native(connection) ? state.datadogQuery : query());
    const select = elements.connectionService;
    if (service && !listed.includes(service)) {
      const option = document.createElement('option');
      option.value = service;
      option.textContent = service;
      select.append(option);
      listed.push(service);
    }
    select.value = service;
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
    statement = connection.type === 'datadog' ? (preview.statement ?? '') : '';
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
        ...search(connection),
        range: state.connectionRange,
      });
    else api.postMessage({ type: 'connectionSql', connectionId: connection.id });
    return true;
  }

  scope.listen(elements.connectionRange, 'change', () => {
    state.connectionRange = elements.connectionRange.value;
    saveState();
    render();
  });
  scope.listen(elements.connectionService, 'change', () => {
    const connection = selected();
    if (!connection) return;
    const service = elements.connectionService.value;
    if (native(connection)) {
      state.datadogQuery = withService(state.datadogQuery, service);
      saveState();
      render();
    } else setQuery(withService(query(), service));
  });
  scope.listen(elements.connectionSyntax, 'click', () => {
    state.datadogSyntax = !state.datadogSyntax;
    // An empty Datadog query starts from what the filter searched, so turning it on keeps the same logs.
    if (state.datadogSyntax && !state.datadogQuery.trim() && statement !== '*') state.datadogQuery = statement;
    saveState();
    render();
    if (state.datadogSyntax) elements.connectionNative.focus();
  });
  scope.listen(elements.connectionNative, 'input', () => {
    state.datadogQuery = elements.connectionNative.value.slice(0, 2048);
    saveState();
    render();
  });
  scope.listen(elements.connectionNative, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') run();
  });
  scope.listen(elements.connectionRun, 'click', () => run());
  scope.listen(elements.connectionTail, 'click', () => {
    const connection = selected();
    if (connection)
      api.postMessage({
        type: 'connectionTail',
        connectionId: connection.id,
        ...search(connection),
        enabled: !connection.tailing || retargets(connection),
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
    receiveServices,
    /** The filter changed: refresh the preview of the SQL it becomes, and whether Tail follows it. */
    queryChanged: render,
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
        : `Use ${connection.language === 'mongo' ? 'Run query' : 'Run SQL'} to query ${connection.label}.`;
    },
  };
}
