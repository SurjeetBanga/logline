import type { CompareRequest, CompareSample, CompareView, Snapshot } from '../../protocol/messages';
import type { SignatureStatus } from '../../core/signature-compare';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
import type { TabRailItem } from '../tab-rail';
import type { WebviewApi } from '../types';

type Session = Snapshot['sessions'][number];
type Source = Snapshot['servers'][number];
type Row = CompareView['rows'][number];

const STATUS: Record<SignatureStatus, { label: string; className: string; title: string }> = {
  reproduced: {
    label: 'Reproduced',
    className: 'compare-reproduced',
    title: 'In production and in the newest local run',
  },
  fixed: {
    label: 'Fixed locally',
    className: 'compare-fixed',
    title: 'In production and an earlier local run, but not the newest',
  },
  notSeen: { label: 'Not seen locally', className: 'compare-muted', title: 'In production only' },
  new: { label: 'New', className: 'compare-new', title: 'Only in the newest local run' },
  localOnly: { label: 'Local only', className: 'compare-new', title: 'In local runs, not in production' },
};
// The rail's color for each status, matching the table's.
const STATUS_COLORS: Record<SignatureStatus, string> = {
  reproduced: 'var(--vscode-charts-red, #f14c4c)',
  fixed: 'var(--vscode-charts-green, #89d185)',
  notSeen: 'var(--vscode-descriptionForeground, #9d9d9d)',
  new: 'var(--vscode-charts-orange, #d18616)',
  localOnly: 'var(--vscode-charts-orange, #d18616)',
};
/** Changes in the newest local run are checked again at most this often. */
const REFRESH_MS = 2000;

/**
 * The Compare tab: the errors of a production run (fetched from a connection,
 * or an imported file) next to a local source's newest runs, with whether each
 * was reproduced, fixed, or is new. Choosing a row shows an event from each
 * side with the fields that differ.
 */
export function createCompare(
  elements: Elements,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    reveal(): void;
    visible(): boolean;
    formatTime(ms: number): string;
    /** Open an event's surrounding logs. */
    showContext(id: number): void;
    /** The rail beside the table: errors by status. */
    rail?(title: string, items: TabRailItem[]): void;
  },
) {
  // Which errors the table shows: every status, or one; and optionally only those from changed code.
  let status: SignatureStatus | 'all' = 'all';
  let changedOnly = false;
  let baselines: { value: string; label: string }[] = [];
  let locals: { id: string; label: string }[] = [];
  let signature = '';
  let view: CompareView | undefined;
  let selected: string | undefined;
  let newest = 0;
  let refresh: ReturnType<typeof setTimeout> | undefined;

  const baselineValue = (serverId: string, sessionId?: string) => JSON.stringify([serverId, sessionId ?? '']);

  function request(): CompareRequest | undefined {
    const baseline = elements.compareBaseline.value;
    const localServerId = elements.compareLocal.value;
    if (!baseline || !localServerId) return undefined;
    const [baselineServerId, baselineSessionId] = JSON.parse(baseline) as [string, string];
    return { baselineServerId, ...(baselineSessionId ? { baselineSessionId } : {}), localServerId };
  }

  function load(): void {
    clearTimeout(refresh);
    refresh = undefined;
    const message = request();
    if (!message) {
      elements.compareStatus.textContent = !baselines.length
        ? 'Fetch a run from a connection, or import a production log, to compare with.'
        : 'Run your app or tests locally, then choose them as Local to compare.';
      elements.compareHead.replaceChildren();
      elements.compareRows.replaceChildren();
      elements.compareDetail.hidden = true;
      return;
    }
    elements.compareStatus.textContent = 'Comparing…';
    api.postMessage({ type: 'compare', ...message });
  }

  function fillSelect(select: HTMLSelectElement, options: { value: string; label: string }[], keep: string): void {
    select.replaceChildren(
      ...options.map(({ value, label }) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    select.value = options.some((option) => option.value === keep) ? keep : (options[0]?.value ?? '');
  }

  /** The snapshot's runs and sources: production runs to compare against, and local sources to compare. */
  function update(sessions: Session[] = [], sources: Source[] = [], latest = 0): void {
    const runs = sessions
      .filter((session) => session.sourceKind === 'remote' || session.sourceKind === 'import')
      .sort((a, b) => b.startedAt - a.startedAt);
    baselines = runs.map((session) => ({
      value: baselineValue(session.serverId, session.id),
      label: `${session.server} · ${session.command || session.id}`,
    }));
    const local = new Set(
      sessions
        .filter((session) => session.sourceKind !== 'remote' && session.sourceKind !== 'import')
        .map((session) => session.serverId),
    );
    // Most recently active first, so the default is the app or tests just run.
    const lastStart = (id: string) =>
      Math.max(0, ...sessions.filter((session) => session.serverId === id).map((session) => session.startedAt));
    locals = sources
      .filter((source) => local.has(source.id))
      .sort((a, b) => lastStart(b.id) - lastStart(a.id))
      .map((source) => ({ id: source.id, label: source.label }));
    elements.compare.hidden = !baselines.length;
    const next = JSON.stringify([baselines, locals]);
    if (next !== signature) {
      signature = next;
      fillSelect(elements.compareBaseline, baselines, elements.compareBaseline.value);
      fillSelect(
        elements.compareLocal,
        locals.map((source) => ({ value: source.id, label: source.label })),
        elements.compareLocal.value,
      );
    }
    // New local output may change the counts; refresh while shown, not on every event.
    if (latest !== newest) {
      newest = latest;
      if (actions.visible() && view && !refresh) refresh = setTimeout(load, REFRESH_MS);
    }
  }

  /** Show the tab, comparing the given production run with a local source when named. */
  function open(target: Partial<CompareRequest> = {}): void {
    if (target.baselineServerId)
      elements.compareBaseline.value = baselineValue(target.baselineServerId, target.baselineSessionId);
    if (target.localServerId) elements.compareLocal.value = target.localServerId;
    selected = undefined;
    actions.reveal();
    load();
  }

  function hide(): void {
    clearTimeout(refresh);
    refresh = undefined;
  }

  function receive(message: { view?: CompareView; error?: string }) {
    if (message.error) elements.compareStatus.textContent = `Could not compare: ${message.error}`;
    else if (message.view) render(message.view);
  }

  /** A run's start, as `20:01`, or `20:01:35` when another run started in the same minute. */
  function runTime(time: string, minutes: string[]): string {
    const minute = time.slice(0, 5);
    const shared = minutes.filter((value) => value === minute).length > 1;
    return shared ? time.replace(/\.\d+$/, '') : minute;
  }

  function statusCell(row: Row): HTMLTableCellElement {
    const status = STATUS[row.status];
    const element = cell(status.label, `compare-status ${status.className}`);
    element.title = status.title;
    return element;
  }

  /** Errors by status, with counts, and whether to keep only those from changed code. */
  function railItems(next: CompareView | undefined): TabRailItem[] {
    const rows = next?.rows ?? [];
    const choose = (value: SignatureStatus | 'all') => () => {
      status = value;
      if (view) render(view);
    };
    const statuses = (Object.keys(STATUS) as SignatureStatus[]).filter((key) => rows.some((row) => row.status === key));
    return [
      {
        kind: 'item',
        key: 'all',
        label: 'All errors',
        icon: 'all',
        meta: rows.length.toLocaleString(),
        selected: status === 'all',
        onSelect: choose('all'),
      },
      ...(statuses.length ? [{ kind: 'group', label: 'By status' } as TabRailItem] : []),
      ...statuses.map((key): TabRailItem => ({
        kind: 'item',
        key,
        label: STATUS[key].label,
        meta: rows.filter((row) => row.status === key).length.toLocaleString(),
        color: STATUS_COLORS[key],
        selected: status === key,
        title: STATUS[key].title,
        onSelect: choose(key),
      })),
      { kind: 'group', label: 'Only' },
      {
        kind: 'item',
        key: 'changed',
        label: 'From your changes',
        meta: rows.filter((row) => row.changed).length.toLocaleString(),
        checked: changedOnly,
        title: 'Errors thrown from code changed since the last commit',
        onSelect: () => {
          changedOnly = !changedOnly;
          if (view) render(view);
        },
      },
    ];
  }

  function render(next: CompareView): void {
    view = next;
    // A status chosen in the rail that no error has any more falls back to all of them,
    // before the rail is drawn, so it marks what the table shows.
    if (status !== 'all' && !next.rows.some((row) => row.status === status)) status = 'all';
    actions.rail?.('Show', railItems(next));
    const rows = next.rows.filter(
      (row) => (status === 'all' || row.status === status) && (!changedOnly || row.changed),
    );
    const header = (text: string, title = '', className = '') => {
      const element = document.createElement('th');
      element.textContent = text;
      element.title = title;
      element.className = className;
      return element;
    };
    const minutes = next.runs.map((run) => (run.startedAt ? actions.formatTime(run.startedAt).slice(0, 5) : ''));
    elements.compareHead.replaceChildren(
      header('Error'),
      header('Production', next.baseline.label, 'compare-count'),
      ...next.runs.map((run, index) => {
        const time = run.startedAt ? actions.formatTime(run.startedAt) : '';
        // An earlier run is named by when it started, to the minute unless two share one; the title has the rest.
        const name = index === next.runs.length - 1 ? 'Latest' : runTime(time, minutes) || 'Run';
        return header(name, `${run.label}${time ? ` · ${time}` : ''}`, 'compare-count');
      }),
      header('Status'),
    );
    const errors = next.rows.length;
    elements.compareStatus.textContent = !errors
      ? `No errors in ${next.baseline.label} or the newest runs of ${next.local.label}.`
      : next.runs.length
        ? `${next.summary} · ${next.baseline.label} vs ${next.local.label}`
        : `${errors} production error${errors === 1 ? '' : 's'}. ${next.local.label} has no runs yet: run it to compare.`;
    if (rows.length < errors) elements.compareStatus.textContent += ` · ${rows.length} shown`;
    elements.compareRows.replaceChildren(
      ...rows.map((row) => {
        const element = document.createElement('tr');
        element.className = `compare-row${row.signature === selected ? ' selected' : ''}`;
        element.tabIndex = 0;
        element.dataset.signature = row.signature;
        const message = cell(row.pattern, 'compare-message');
        message.title = row.message;
        // From changed code: a tag by the error, where it is read, rather than more text in Status.
        if (row.changed) {
          const changed = document.createElement('span');
          changed.className = 'compare-changed';
          changed.textContent = 'changed';
          changed.title = `Thrown from code changed since the last commit${row.location ? `, at ${row.location}` : ''}, so most likely from your change`;
          message.prepend(changed);
        }
        element.append(
          message,
          cell(row.baseline || '–', 'compare-count'),
          ...row.runs.map((count) => cell(count || '–', 'compare-count')),
          statusCell(row),
        );
        const choose = () => {
          selected = selected === row.signature ? undefined : row.signature;
          render(next);
        };
        scope.listen(element, 'click', choose);
        scope.listen(element, 'keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose();
          }
        });
        return element;
      }),
    );
    const row = next.rows.find((candidate) => candidate.signature === selected);
    elements.compareDetail.hidden = !row;
    elements.compareDetail.replaceChildren(...(row ? [detail(row, next)] : []));
  }

  function side(title: string, sample: CompareSample | undefined): HTMLElement {
    const column = document.createElement('section');
    column.className = 'compare-side';
    const heading = document.createElement('h3');
    heading.textContent = title;
    column.append(heading);
    if (!sample) {
      const none = document.createElement('p');
      none.className = 'compare-none';
      none.textContent = 'Not seen here.';
      column.append(none);
      return column;
    }
    const list = document.createElement('dl');
    const add = (name: string, value: string | number | boolean | undefined, differs = false) => {
      const term = document.createElement('dt');
      term.textContent = name;
      const description = document.createElement('dd');
      description.textContent = String(value ?? '');
      if (differs) {
        term.className = description.className = 'compare-diff';
        description.title = 'Differs from the other side';
      }
      list.append(term, description);
    };
    add('time', sample.timestamp);
    add('level', sample.level);
    add('message', sample.message);
    for (const [name, value] of Object.entries(sample.fields)) add(name, value, sample.differs.includes(name));
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Surrounding logs';
    open.title = 'Show the logs around this event';
    scope.listen(open, 'click', () => actions.showContext(sample.id));
    column.append(list, open);
    return column;
  }

  function detail(row: Row, next: CompareView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'compare-sides';
    // The local event may come from an earlier run than the newest, which the source is named after.
    const run = next.runs.find((candidate) => candidate.id === row.samples.local?.sessionId);
    container.append(
      side(`Production · ${next.baseline.label}`, row.samples.baseline),
      side(
        `Local · ${run ? `${run.label}${run.startedAt ? ` · ${actions.formatTime(run.startedAt)}` : ''}` : next.local.label}`,
        row.samples.local,
      ),
    );
    return container;
  }

  scope.listen(elements.compareBaseline, 'change', () => open());
  scope.listen(elements.compareLocal, 'change', () => open());
  scope.track(() => clearTimeout(refresh));

  return {
    update,
    open,
    show: () => open(),
    hide,
    receive,
    /** Whether there is a production run to compare against. */
    available: () => baselines.length > 0,
  };
}
