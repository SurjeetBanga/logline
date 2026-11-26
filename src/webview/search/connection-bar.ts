import { connectionKind, storeName } from '../../core/connection-types';
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
  | 'connectionServices'
  | 'connectionServiceLabel'
>;
type Preview = Extract<HostMessage, { type: 'connectionPreview' }>;
type Services = Extract<HostMessage, { type: 'connectionServices' }>;

const PREVIEW_DELAY_MS = 250;
// The services a connection lists are asked again after this long, or for another range; a failed answer sooner.
const SERVICES_TTL_MS = 5 * 60000;
const SERVICES_RETRY_MS = 30000;
const SERVICE_TERM = /^@?service:/i;
// A term that names the service in any way: negated, grouped, or as it is.
const ANY_SERVICE_TERM = /^[-!(]*@?service:/i;
// A boolean operator, or a group, makes which services a query searches more than one name.
const BOOLEAN = /^(?:OR|NOT)$|^[-!]?\(|\)$/i;

/** The query's terms, with a group such as `service:(a OR b)` kept as one term. */
function serviceTokens(text: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  for (const token of queryTokens(text)) {
    if (depth > 0) tokens[tokens.length - 1] += ` ${token}`;
    else if (SERVICE_TERM.test(token) && token.slice(token.indexOf(':') + 1).startsWith('(')) tokens.push(token);
    else {
      tokens.push(token);
      continue;
    }
    for (const char of token.startsWith('"') ? '' : token) depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    depth = Math.max(depth, 0);
  }
  return tokens;
}

/** A `service:` term's value without quotes, and whether it was quoted. */
function serviceValue(term: string): { value: string; quoted: boolean } {
  const value = term.slice(term.indexOf(':') + 1);
  if (!value.startsWith('"')) return { value, quoted: false };
  try {
    return { value: JSON.parse(value) as string, quoted: true };
  } catch {
    return { value: value.slice(1, -1), quoted: true };
  }
}

/** The `service:` value of a query, without quotes, or '' when it has none. */
export function serviceOf(text: string): string {
  const term = serviceTokens(text).find((token) => SERVICE_TERM.test(token));
  return term ? serviceValue(term).value : '';
}

/**
 * The one service a query names outright, or undefined when it names none, more
 * than one, a wildcard, or a group, or combines terms with OR or NOT.
 */
export function soleService(text: string): string | undefined {
  const tokens = serviceTokens(text);
  const terms = tokens.filter((token) => ANY_SERVICE_TERM.test(token));
  if (terms.length !== 1 || !SERVICE_TERM.test(terms[0])) return undefined;
  if (tokens.some((token) => token !== terms[0] && BOOLEAN.test(token))) return undefined;
  const { value, quoted } = serviceValue(terms[0]);
  // A quoted value is a name as it is; unquoted, `*` and `?` are wildcards and parentheses a group.
  return value && (quoted || !/[()*?]/.test(value)) ? value : undefined;
}

/** The query with its `service:` terms replaced by one for `service`, or removed when it is ''. */
export function withService(text: string, service: string): string {
  const kept = serviceTokens(text).filter((token) => !SERVICE_TERM.test(token));
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
  /** Apply a filter typed but not yet entered; false when it is not valid. */
  applyPending: () => boolean = () => true,
) {
  let connections: ConnectionView[] = [];
  let previewKey = '';
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which connection and range the listed services are for, and until when they stand. */
  let services: { key: string; until: number } | undefined;
  let servicesAsked = '';
  /** The services the list shows. */
  let listed: string[] = [];
  /** Whether the service box has focus, so a refresh leaves what is being typed alone. */
  let choosing = false;
  /** Whether the box was typed in, or cleared, since it was focused or a service chosen. */
  let edited = false;
  /** The search in the store's own syntax that the filter became, from the last preview. */
  let statement = '';
  const numbers = new Intl.NumberFormat();
  const selected = () => connections.find((connection) => connection.sourceId === state.selectedServer);

  // A database has rows, MongoDB documents, and a log service logs.
  const noun = (connection: ConnectionView, count: number) =>
    `${connectionKind(connection.type).noun}${count === 1 ? '' : 's'}`;

  /** Whether Run and Tail send the query typed in the store's own syntax, rather than the filter. */
  const native = (connection: ConnectionView) =>
    connectionKind(connection.type).native !== undefined && state.nativeOf(connection.type).on;
  /** What Run and Tail search: the filter, or the store's query as typed (all logs when it is empty). */
  const search = (connection: ConnectionView) =>
    native(connection)
      ? { query: query(), native: state.nativeOf(connection.type).query.trim() || '*' }
      : { query: query() };
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
    const store = storeName(connection.type);
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
    const kind = connectionKind(connection.type);
    elements.connectionSyntax.hidden = !kind.native || !connection.mapped;
    if (kind.native) {
      elements.connectionSyntax.textContent = kind.native.label;
      elements.connectionSyntax.title = kind.native.title;
    }
    elements.connectionSyntax.setAttribute('aria-pressed', String(native(connection)));
    elements.connectionNative.hidden = !native(connection);
    const typed = state.nativeOf(connection.type).query;
    if (elements.connectionNative.value !== typed) elements.connectionNative.value = typed;
    const listsServices = kind.services && connection.mapped;
    elements.connectionServiceLabel.hidden = !listsServices;
    if (listsServices) {
      requestServices(connection);
      showService(connection);
    }
    if (!connection.mapped) elements.connectionPreview.textContent = '';
    else if (native(connection)) {
      // Nothing to translate: the query goes as typed, and the filter only narrows what is shown.
      clearTimeout(previewTimer);
      previewKey = '';
      elements.connectionPreview.classList.remove('connection-error');
      elements.connectionPreview.textContent = `Run and Tail send the ${kind.label} query as typed; the filter above narrows what is shown.`;
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
    const options = answer.services.map(({ name, count }) => {
      const option = document.createElement('option');
      option.value = name;
      if (count !== undefined) option.textContent = `${name} · ${numbers.format(count)} logs`;
      return option;
    });
    elements.connectionServices.replaceChildren(...options);
    listed = answer.services.map((service) => service.name);
    const how = 'type to find one, or clear it for any service';
    elements.connectionService.title = answer.error
      ? `Could not list services: ${answer.error}`
      : answer.services.some((service) => service.count === undefined)
        ? `Search or tail one service's logs; ${how}`
        : `Search or tail one service's logs, listed by how many logs they had in the range; ${how}`;
    const connection = selected();
    if (connection) showService(connection);
  }

  /** The service the search names: the one in the store's query while that is sent, else the filter's. */
  const currentService = (connection: ConnectionView) =>
    serviceOf(native(connection) ? state.nativeOf(connection.type).query : query());

  /** Show the service the query names, unless someone is typing in the box. */
  function showService(connection: ConnectionView): void {
    if (choosing) return;
    const input = elements.connectionService;
    const service = currentService(connection);
    if (input.value !== service) input.value = service;
  }

  /** The service a typed value names: a listed one in any letter case, else the text as typed. */
  function resolveService(value: string): string {
    const typed = value.trim();
    const lower = typed.toLowerCase();
    return listed.find((name) => name.toLowerCase() === lower) ?? typed;
  }

  /**
   * While the store's query is sent, the filter only narrows what is shown, so a
   * `service:` left in it from before hides every row of another service. Drop it.
   */
  function alignFilter(connection: ConnectionView): void {
    if (!native(connection)) return;
    const sent = soleService(state.nativeOf(connection.type).query);
    const shown = soleService(query());
    // The filter matches a value anywhere in the field, ignoring case, so only a name the sent one lacks conflicts.
    // With OR, NOT, a wildcard, or a group on either side the filter may still match, and is left alone.
    if (sent !== undefined && shown !== undefined && !sent.toLowerCase().includes(shown.toLowerCase()))
      setQuery(withService(query(), ''));
  }

  function chooseService(service: string): void {
    const connection = selected();
    if (!connection) return;
    // The box may keep focus, so `choosing` stays set until it is left, and later typing is not overwritten.
    const input = elements.connectionService;
    edited = false;
    if (service !== currentService(connection)) {
      if (native(connection)) {
        state.setNative(connection.type, { query: withService(state.nativeOf(connection.type).query, service) });
        saveState();
        alignFilter(connection);
        render();
      } else if (applyPending()) setQuery(withService(query(), service));
    }
    input.value = currentService(connection);
    input.placeholder = input.value || 'Any service';
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
      statement = '';
      note.textContent = preview.error;
      note.title = '';
      return;
    }
    const kind = connectionKind(connection.type);
    statement = kind.native ? (preview.statement ?? '') : '';
    const local = preview.local.length ? ` · Filtered locally: ${preview.local.join(' ')}` : '';
    const sends = connection.sql ? 'Runs as' : `${kind.label} search`;
    note.textContent = preview.statement ? `${sends}: ${preview.statement}${local}` : '';
    note.title = preview.statement
      ? `${preview.statement}${preview.local.length ? `\n\nTerms SQL cannot express are applied to the fetched rows: ${preview.local.join(' ')}` : ''}`
      : '';
  }

  function run(): boolean {
    const connection = selected();
    if (!connection) return false;
    // A filter typed without pressing Enter is part of what Run searches, rather than silently left out.
    if (connection.mapped && !applyPending()) return true;
    alignFilter(connection);
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
  /** Whether the box holds the service chosen already, as Escape leaves it. */
  const unchanged = () => {
    const connection = selected();
    return !connection || elements.connectionService.value === currentService(connection);
  };
  // The box empties on focus so the whole list shows and typing searches it; the service stays as its placeholder.
  scope.listen(elements.connectionService, 'focus', () => {
    const connection = selected();
    // Focus that comes back with the window leaves what was being typed alone.
    if (!connection || choosing) return;
    choosing = true;
    edited = false;
    const input = elements.connectionService;
    input.placeholder = currentService(connection) || 'Any service';
    input.value = '';
  });
  scope.listen(elements.connectionService, 'blur', () => {
    // The window losing focus blurs the box but leaves it focused within the page: keep what is typed.
    if (document.activeElement === elements.connectionService) return;
    const connection = selected();
    // A box cleared by hand and left chooses any service. No change fires for it: focus emptied the box already.
    const cleared = edited && !elements.connectionService.value.trim() && !unchanged();
    choosing = false;
    edited = false;
    elements.connectionService.placeholder = 'Any service';
    if (cleared) chooseService('');
    if (connection) showService(connection);
  });
  scope.listen(elements.connectionService, 'input', (event) => {
    edited = true;
    // A suggestion picked from the list replaces the text, after any Enter that picked it chose what was typed.
    // Chromium marks that input as a replacement, or leaves its type empty, as for the clear button; typing has one.
    const type = (event as InputEvent).inputType;
    if ((type && type !== 'insertReplacementText') || unchanged()) return;
    const name = resolveService(elements.connectionService.value);
    if (listed.includes(name)) chooseService(name);
  });
  // Picking a suggestion, or typing a listed name in full, chooses that service; part of a name, as when
  // Run is clicked while searching the list, is left alone.
  scope.listen(elements.connectionService, 'change', () => {
    const value = elements.connectionService.value.trim();
    if (!value || unchanged()) return;
    const name = resolveService(value);
    if (listed.includes(name)) chooseService(name);
  });
  // The box's clear button.
  scope.listen(elements.connectionService, 'search', () => {
    if (edited && !elements.connectionService.value.trim() && !unchanged()) chooseService('');
  });
  scope.listen(elements.connectionService, 'keydown', (event) => {
    const keyboard = event as KeyboardEvent;
    // Enter that ends a composition belongs to the input method.
    if (keyboard.isComposing) return;
    if (keyboard.key === 'Enter') {
      event.preventDefault();
      const value = elements.connectionService.value;
      // Enter in a box cleared by hand chooses any service; in one only emptied by focus, it keeps the service.
      if (value.trim() || edited) chooseService(resolveService(value));
    } else if (keyboard.key === 'Escape') {
      event.preventDefault();
      // Put the service back first: leaving the box fires a change for whatever was typed.
      const connection = selected();
      if (connection) elements.connectionService.value = currentService(connection);
      edited = false;
      elements.connectionService.blur();
    }
  });
  scope.listen(elements.connectionSyntax, 'click', () => {
    const connection = selected();
    if (!connection) return;
    const on = !state.nativeOf(connection.type).on;
    // An empty query starts from what the filter searched, so turning it on keeps the same logs.
    const start = on && !state.nativeOf(connection.type).query.trim() && statement !== '*' ? { query: statement } : {};
    state.setNative(connection.type, { on, ...start });
    saveState();
    render();
    if (on) elements.connectionNative.focus();
  });
  scope.listen(elements.connectionNative, 'input', () => {
    const connection = selected();
    if (!connection) return;
    state.setNative(connection.type, { query: elements.connectionNative.value.slice(0, 2048) });
    saveState();
    render();
  });
  scope.listen(elements.connectionNative, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') run();
  });
  scope.listen(elements.connectionRun, 'click', () => run());
  scope.listen(elements.connectionTail, 'click', () => {
    const connection = selected();
    if (!connection || !applyPending()) return;
    alignFilter(connection);
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
      const last = connection.last;
      const filter = query().trim();
      // While the store's query is sent the filter only narrows what is shown, so rows fetched by the run
      // on show but none in the table are hidden by the filter: say so, rather than suggest there were none.
      // A run that sent the filter kept only rows that match it, so only one that sent the store's query counts.
      const hiddenByFilter =
        last?.native === true && (!state.selectedSession || state.selectedSession === last.sessionId);
      if (last && last.kept > 0 && filter && !last.running && hiddenByFilter)
        return `${numbers.format(last.kept)} ${noun(connection, last.kept)} fetched, but none match the filter ${filter}. Clear or change the filter to see them.`;
      if (last) return 'No matching rows. Change the filter or the range and press Run.';
      return connection.mapped
        ? `Choose a range and press Run to fetch ${connection.sql ? 'rows' : 'logs'} from ${connection.label}.`
        : `Use ${connection.language === 'mongo' ? 'Run query' : 'Run SQL'} to query ${connection.label}.`;
    },
  };
}
