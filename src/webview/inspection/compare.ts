import type { CompareRequest, CompareSample, CompareView, Snapshot } from '../../protocol/messages';
import type { SignatureStatus } from '../../core/signature-compare';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
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
  },
) {
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

  function statusCell(row: Row): HTMLTableCellElement {
    const status = STATUS[row.status];
    const element = cell(status.label, `compare-status ${status.className}`);
    element.title = status.title;
    if (row.changed) {
      const changed = document.createElement('span');
      changed.className = 'compare-changed';
      changed.textContent = ` · changed${row.location ? `: ${row.location}` : ''}`;
      changed.title = 'Thrown from code changed since the last commit, so most likely from your change';
      element.append(changed);
    }
    return element;
  }

  function render(next: CompareView): void {
    view = next;
    const header = (text: string, title = '') => {
      const element = document.createElement('th');
      element.textContent = text;
      element.title = title;
      return element;
    };
    elements.compareHead.replaceChildren(
      header('Error'),
      header('Production', next.baseline.label),
      ...next.runs.map((run, index) =>
        header(
          index === next.runs.length - 1 ? 'Latest run' : run.startedAt ? actions.formatTime(run.startedAt) : 'Run',
          `${run.label}${run.startedAt ? ` · ${actions.formatTime(run.startedAt)}` : ''}`,
        ),
      ),
      header('Status'),
    );
    const errors = next.rows.length;
    elements.compareStatus.textContent = !errors
      ? `No errors in ${next.baseline.label} or the newest runs of ${next.local.label}.`
      : next.runs.length
        ? `${next.summary} · ${next.baseline.label} vs ${next.local.label}`
        : `${errors} production error${errors === 1 ? '' : 's'}. ${next.local.label} has no runs yet: run it to compare.`;
    elements.compareRows.replaceChildren(
      ...next.rows.map((row) => {
        const element = document.createElement('tr');
        element.className = `compare-row${row.signature === selected ? ' selected' : ''}`;
        element.tabIndex = 0;
        element.dataset.signature = row.signature;
        const message = cell(row.pattern, 'compare-message');
        message.title = row.message;
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
    container.append(
      side(`Production · ${next.baseline.label}`, row.samples.baseline),
      side(`Local · ${next.local.label}`, row.samples.local),
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
