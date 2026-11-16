import type { SpanDetail, TraceHotspot, TraceLog, TraceRow, TraceView } from '../../core/traces';
import type { Elements } from '../dom';
import { cell } from '../dom';
import { icon, renderEventFields } from './details';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';

export function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const REFRESH_MS = 5000;

/** One trace's waterfall, in the inspector beside the list of traces: spans across services with their logs interleaved. */
export function createTraceView(
  elements: Elements,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    showContext(id: number): void;
    applyQuery(query: string): void;
    openAiCall(traceId: string, spanId: string): void;
    /** Shows the waterfall of a trace in the inspector, under a title. */
    inspect(title: string, traceId: string): void;
    /** Whether the inspector shows a trace. */
    inspecting(): boolean;
  },
) {
  let current: string | undefined;
  /** What the retained spans and logs were when the host last described them; a change means the waterfall is behind. */
  let basis: string | undefined;
  let pending = false;
  let loadedAt = -Infinity;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  /** What the rows on screen were drawn from, so an unchanged trace is not drawn again. */
  let shown: string | undefined;
  /** The trace on screen, drawn again when a span opens or closes. */
  let trace: TraceView | undefined;
  /** The span whose details show under its row, and what the host said of it: nothing yet, the span, or that it is gone. */
  let selected: string | undefined;
  let detail: SpanDetail | 'loading' | 'missing' | { error: string } = 'loading';

  function load() {
    if (!current) return;
    pending = true;
    loadedAt = Date.now();
    api.postMessage({ type: 'trace', traceId: current });
  }

  function show(traceId: string) {
    current = traceId.toLowerCase();
    shown = undefined;
    trace = undefined;
    selected = undefined;
    elements.traceStatus.textContent = 'Loading…';
    elements.traceRows.replaceChildren();
    elements.traceHotspots.hidden = true;
    actions.inspect(`Trace ${current.length > 12 ? `${current.slice(0, 8)}…${current.slice(-4)}` : current}`, current);
    load();
  }

  /** Follows the retained spans and logs: an open trace loads again once they change, as its later spans arrive. */
  function update(next: string) {
    const changed = basis !== undefined && next !== basis;
    basis = next;
    if (!changed || !current || refresh) return;
    refresh = setTimeout(
      () => {
        refresh = undefined;
        if (actions.inspecting() && !pending) load();
      },
      Math.max(0, loadedAt + REFRESH_MS - Date.now()),
    );
  }

  /** The host could not read the trace: say so in place of a waterfall that would never load. */
  function fail(traceId: string | undefined, message: string) {
    if (!actions.inspecting() || traceId !== current) return;
    pending = false;
    shown = undefined;
    elements.traceStatus.textContent = `Could not load this trace: ${message}`;
  }

  scope.track(() => clearTimeout(refresh));

  /** Forgets the trace when the inspector closes, so a late reply for it is ignored. */
  function hide() {
    current = undefined;
    shown = undefined;
    trace = undefined;
    selected = undefined;
    pending = false;
    clearTimeout(refresh);
    refresh = undefined;
    elements.traceRows.replaceChildren();
    elements.traceHotspotList.replaceChildren();
    elements.traceHotspots.hidden = true;
  }

  // A hotspot leads to the first span of its operation in the waterfall.
  scope.listen(elements.traceHotspotList, 'click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('.trace-hotspot');
    const span =
      button &&
      trace?.spans.find((span) => span.service === button.dataset.service && span.name === button.dataset.name);
    if (!span) return;
    // The span opens too, so what took the time can be read where the hotspot leads.
    if (selected !== span.spanId) select(span.spanId);
    const row = spanRows().find((row) => row.dataset.spanId === span.spanId);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('trace-flash');
    void row.offsetWidth; // restart the animation when the same hotspot is chosen again
    row.classList.add('trace-flash');
  });
  scope.listen(elements.traceFilter, 'click', () => {
    if (!current) return;
    actions.applyQuery(`traceId:${current}`);
  });
  scope.listen(elements.traceRows, 'click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('.trace-genai');
    if (chip?.dataset.spanId && current) {
      actions.openAiCall(current, chip.dataset.spanId);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>('.trace-log-button');
    if (button) {
      actions.showContext(Number(button.dataset.id));
      return;
    }
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-span-action]')?.dataset.spanAction;
    if (action && current && selected) {
      if (action === 'logs') actions.applyQuery(`traceId:${current} spanId:${selected}`);
      else api.postMessage({ type: 'copySpan', traceId: current, spanId: selected, whole: action === 'copy' });
      return;
    }
    // Text in a span's details can be selected and copied without closing them.
    if ((event.target as HTMLElement).closest('.trace-detail')) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('.trace-span');
    if (row?.dataset.spanId) toggle(row.dataset.spanId);
  });
  scope.listen(elements.traceCopyId, 'click', () => {
    if (current) api.postMessage({ type: 'copySpan', traceId: current });
  });
  // One span row is a tab stop; the arrow keys move between them and Enter or Space opens one.
  scope.listen(elements.traceRows, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    const row = event.target as HTMLElement;
    if (!row.classList?.contains('trace-span')) return;
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (row.dataset.spanId) toggle(row.dataset.spanId);
      return;
    }
    const rows = spanRows();
    const index = rows.indexOf(row);
    const next =
      key === 'ArrowDown'
        ? rows[index + 1]
        : key === 'ArrowUp'
          ? rows[index - 1]
          : key === 'Home'
            ? rows[0]
            : key === 'End'
              ? rows.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    row.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });

  const spanRows = () => [...elements.traceRows.querySelectorAll<HTMLElement>('.trace-span')];

  /** Opens a span's details under its row, asking the host for all of its attributes and events. */
  function select(spanId: string | undefined) {
    selected = spanId;
    detail = 'loading';
    if (spanId && current) api.postMessage({ type: 'span', traceId: current, spanId });
    draw(spanId);
  }

  /** Opens a span, or closes the one that is open. */
  function toggle(spanId: string) {
    const reopen = spanId !== selected;
    select(reopen ? spanId : undefined);
    if (!reopen)
      spanRows()
        .find((row) => row.dataset.spanId === spanId)
        ?.focus();
  }

  function receiveSpan(message: { traceId: string; spanId: string; detail?: SpanDetail }) {
    if (!actions.inspecting() || message.traceId !== current || message.spanId !== selected) return;
    detail = message.detail ?? 'missing';
    draw();
  }

  /** The host could not read the span: say so where its details would be. */
  function failSpan(traceId: string | undefined, spanId: string | undefined, message: string) {
    if (!actions.inspecting() || traceId !== current || spanId !== selected) return;
    detail = { error: message };
    draw();
  }

  function receive(next: TraceView) {
    if (!actions.inspecting() || next.traceId !== current) return;
    pending = false;
    // Most refreshes find the trace as it was; leaving the rows alone keeps tooltips, focus, and scroll steady.
    const signature = `${next.traceId}:${next.spans.length}:${next.omitted}:${next.errors}:${next.durationMs}:${next.logs.length}:${next.logs.at(-1)?.id ?? ''}`;
    if (signature === shown) return;
    shown = signature;
    trace = next;
    // A span that has left the trace, as the oldest do when the store is full, takes its details with it.
    if (selected && !next.spans.some((span) => span.spanId === selected)) selected = undefined;
    draw();
  }

  /** Draws the trace; `focus` names a span row to focus, and otherwise the row holding focus keeps it. */
  function draw(focus?: string) {
    if (!trace) return;
    const held = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.trace-span');
    const focusId = focus ?? (held && elements.traceRows.contains(held) ? held.dataset.spanId : undefined);
    elements.traceStatus.textContent = summary(trace);
    // With one span, self time says nothing the waterfall does not.
    const shownHotspots = trace.spans.length + trace.omitted > 1 ? trace.hotspots : [];
    const top = shownHotspots[0]?.selfMs ?? 0;
    elements.traceHotspotList.replaceChildren(...shownHotspots.map((hotspot) => hotspotItem(hotspot, top)));
    elements.traceHotspots.hidden = !shownHotspots.length;
    const total = Math.max(trace.durationMs, 0.001);
    const logsBySpan = new Map<string, TraceLog[]>();
    const unattached: TraceLog[] = [];
    const spanIds = new Set(trace.spans.map((span) => span.spanId));
    for (const log of trace.logs) {
      if (log.spanId && spanIds.has(log.spanId))
        logsBySpan.set(log.spanId, [...(logsBySpan.get(log.spanId) ?? []), log]);
      else unattached.push(log);
    }
    const rows: HTMLTableRowElement[] = [];
    // The open span is the tab stop, and otherwise the first.
    const tabStop = selected ?? trace.spans[0]?.spanId;
    for (const span of trace.spans) {
      const row = spanRow(span, total);
      row.tabIndex = span.spanId === tabStop ? 0 : -1;
      row.setAttribute('aria-expanded', String(span.spanId === selected));
      if (span.spanId === selected) row.classList.add('selected');
      rows.push(row);
      if (span.spanId === selected) rows.push(spanDetails(span, detail));
      for (const log of logsBySpan.get(span.spanId) ?? []) rows.push(logRow(log, total, span.depth + 1));
    }
    if (unattached.length) {
      if (trace.spans.length) {
        const heading = document.createElement('tr');
        heading.className = 'trace-section';
        const label = cell('Logs not linked to a received span');
        label.colSpan = 5;
        heading.append(label);
        rows.push(heading);
      }
      for (const log of unattached) rows.push(logRow(log, total, 0));
    }
    elements.traceRows.replaceChildren(...rows);
    if (focusId) rows.find((row) => row.dataset.spanId === focusId)?.focus();
  }

  return {
    show,
    hide,
    update,
    fail,
    receive,
    receiveSpan,
    failSpan,
    get open() {
      return actions.inspecting();
    },
  };
}

function summary(trace: TraceView): string {
  if (!trace.spans.length && !trace.logs.length) {
    return 'No spans or retained logs have this trace id. Start the OpenTelemetry receiver from the status icon, or Add logs in the Sources rail, to collect spans from instrumented apps.';
  }
  if (!trace.spans.length) {
    return `${trace.logs.length} retained log${trace.logs.length === 1 ? '' : 's'} with this trace id over ${formatDuration(trace.durationMs)}. No spans were received for it.`;
  }
  const spans = trace.spans.length + trace.omitted;
  const parts = [
    `${trace.services.length} service${trace.services.length === 1 ? '' : 's'}`,
    `${spans} span${spans === 1 ? '' : 's'}`,
    formatDuration(trace.durationMs),
    trace.errors ? `${trace.errors} error${trace.errors === 1 ? '' : 's'}` : 'no errors',
    `${trace.logs.length} log${trace.logs.length === 1 ? '' : 's'}`,
  ];
  return `${parts.join(' · ')} · Highlighted spans are the critical path${trace.omitted ? ` · First ${trace.spans.length} spans shown` : ''}`;
}

function hotspotItem(hotspot: TraceHotspot, top: number): HTMLLIElement {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `trace-hotspot${hotspot.errors ? ' trace-hotspot-error' : ''}`;
  button.dataset.service = hotspot.service;
  button.dataset.name = hotspot.name;
  const percent = Math.round(hotspot.share * 100);
  const calls = hotspot.count > 1 ? ` across ${hotspot.count} spans` : '';
  button.title =
    `${hotspot.name} in ${hotspot.service} spent ${formatDuration(hotspot.selfMs)} itself${calls}, ${percent}% of all self time` +
    `${hotspot.errors ? `. ${hotspot.errors} failed` : ''}. Show in waterfall.`;
  const name = document.createElement('span');
  name.className = 'trace-hotspot-name';
  const service = document.createElement('span');
  service.className = 'trace-hotspot-service';
  service.textContent = ` · ${hotspot.service}${hotspot.count > 1 ? ` · ×${hotspot.count}` : ''}`;
  name.append(document.createTextNode(`${hotspot.errors ? '⚠ ' : ''}${hotspot.name}`), service);
  const track = document.createElement('span');
  track.className = 'trace-track';
  const bar = document.createElement('span');
  bar.className = 'trace-bar';
  bar.style.width = `${Math.max(1, (hotspot.selfMs / Math.max(top, 0.001)) * 100)}%`;
  track.append(bar);
  const time = document.createElement('span');
  time.className = 'trace-hotspot-time';
  time.textContent = `${formatDuration(hotspot.selfMs)} · ${percent}%`;
  button.append(name, track, time);
  item.append(button);
  return item;
}

function timeline(
  offset: number,
  duration: number | undefined,
  total: number,
  className: string,
): HTMLTableCellElement {
  const container = cell('', 'trace-timeline');
  const track = document.createElement('div');
  track.className = 'trace-track';
  const mark = document.createElement('div');
  mark.className = className;
  // Positions are set through the CSSOM, which the webview's style policy allows.
  mark.style.left = `${Math.min(100, Math.max(0, (offset / total) * 100))}%`;
  if (duration !== undefined) mark.style.width = `${Math.max(0.4, Math.min(100, (duration / total) * 100))}%`;
  track.append(mark);
  container.append(track);
  return container;
}

function spanRow(span: TraceRow, total: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = `trace-span${span.error ? ' trace-error' : ''}${span.critical ? ' trace-critical' : ''}`;
  row.dataset.service = span.service;
  row.dataset.name = span.name;
  row.dataset.spanId = span.spanId;
  const name = cell('', 'trace-name');
  const label = document.createElement('span');
  label.className = 'trace-indent';
  label.style.paddingInlineStart = `${Math.min(span.depth, 24) * 14}px`;
  label.textContent = `${span.error ? '⚠ ' : ''}${span.name}`;
  name.append(label);
  // A GenAI span opens its conversation from a chip marked with the AI calls icon. The chip adds what the
  // row leaves out: the model or tool when the name does not say it, a call's tokens, and an agent run's
  // model calls; a tool run's chip is the icon alone.
  if (span.genAi) {
    const content = document.createElement('div');
    content.className = 'trace-name-content';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'trace-genai';
    chip.dataset.spanId = span.spanId;
    const { label: subjectLabel, modelCalls } = span.genAi;
    const subject = subjectLabel.replace(/^tool · /, '');
    const details = [
      modelCalls && `${modelCalls.calls} ${modelCalls.calls === 1 ? 'call' : 'calls'}`,
      tokenUsage(modelCalls ?? span.genAi),
    ].filter((fact): fact is string => !!fact);
    const facts = [...(span.name.includes(subject) ? [] : [subjectLabel]), ...details];
    const text = document.createElement('span');
    text.className = 'trace-genai-text';
    text.textContent = facts.join(' · ');
    chip.append(icon('aiCall'), ...(facts.length ? [text] : []));
    if (!facts.length) chip.classList.add('icon-only');
    chip.setAttribute('aria-label', `Open ${subjectLabel} in AI calls`);
    chip.title = `${[subjectLabel, ...details].join(', ')}. Open this call in AI calls.`;
    content.append(label, chip);
    name.replaceChildren(content);
  }
  // The name is often cut to fit; the rest of the span is in its details, a click away.
  name.title = `${span.name} (${span.kind}). Show this span's attributes and events.`;
  const bar = timeline(span.offsetMs, span.durationMs, total, 'trace-bar');
  bar.setAttribute('aria-label', `Starts at +${formatDuration(span.offsetMs)}`);
  row.append(
    name,
    cell(span.service, 'trace-service'),
    bar,
    cell(formatDuration(span.durationMs), 'trace-duration'),
    cell(formatDuration(span.selfMs), 'trace-duration trace-self'),
  );
  return row;
}

/** A span's details, in a row under its own: what the waterfall has no room for. */
function spanDetails(
  span: TraceRow,
  detail: SpanDetail | 'loading' | 'missing' | { error: string },
): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'trace-detail';
  const content = cell('', 'trace-detail-cell');
  content.colSpan = 5;
  const paragraph = (text: string, className: string) => {
    const element = document.createElement('p');
    element.className = className;
    element.textContent = text;
    return element;
  };
  const heading = (text: string) => {
    const element = document.createElement('h4');
    element.textContent = text;
    return element;
  };
  const known = typeof detail === 'object' && 'spanId' in detail ? detail : undefined;
  content.append(
    paragraph(
      [
        span.service,
        span.kind,
        `${formatDuration(span.durationMs)}, ${formatDuration(span.selfMs)} of it its own`,
        `starts at +${formatDuration(span.offsetMs)}`,
        known?.scope,
      ]
        .filter(Boolean)
        .join(' · '),
      'trace-detail-facts',
    ),
  );
  if (span.statusMessage) content.append(paragraph(`Error: ${span.statusMessage}`, 'trace-detail-error'));
  const buttons = document.createElement('div');
  buttons.className = 'trace-detail-actions';
  for (const [action, label, title] of [
    ['logs', 'Show this span’s logs', 'Show every retained event with this span id'],
    ['copyId', 'Copy span ID', 'Copy this span’s id to the clipboard'],
    ['copy', 'Copy span', 'Copy this span as JSON, redacted like exports'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.spanAction = action;
    button.textContent = label;
    button.title = title;
    buttons.append(button);
  }
  content.append(buttons);
  if (!known) {
    content.append(
      paragraph(
        detail === 'loading'
          ? 'Loading…'
          : detail === 'missing'
            ? 'This span is no longer retained.'
            : `Could not load this span: ${(detail as { error: string }).error}`,
        'trace-detail-note',
      ),
    );
  } else {
    const attributes: [string, unknown][] = [
      ['span id', known.spanId],
      ...(known.parentSpanId ? ([['parent span id', known.parentSpanId]] as [string, unknown][]) : []),
      ...Object.entries(known.attributes),
    ];
    content.append(heading('Attributes'), renderEventFields(attributes, { label: 'Span attributes' })!);
    if (known.events.length) content.append(heading(`Events · ${known.events.length}`));
    for (const event of known.events) {
      content.append(
        paragraph(`+${formatDuration(Math.max(0, event.offsetMs))} · ${event.name}`, 'trace-detail-event'),
      );
      const fields = Object.entries(event.attributes);
      if (fields.length) content.append(renderEventFields(fields, { label: `Attributes of ${event.name}` })!);
    }
  }
  row.append(content);
  return row;
}

const tokenFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compactTokens = (value: number | undefined) => (value === undefined ? '–' : tokenFormat.format(value));

/** `1.2K → 86 tok`; a call that failed before answering has input tokens only. */
function tokenUsage({ inputTokens, outputTokens }: { inputTokens?: number; outputTokens?: number }): string {
  if (inputTokens !== undefined && outputTokens !== undefined)
    return `${compactTokens(inputTokens)} → ${compactTokens(outputTokens)} tok`;
  if (inputTokens !== undefined) return `${compactTokens(inputTokens)} tok in`;
  if (outputTokens !== undefined) return `${compactTokens(outputTokens)} tok out`;
  return '';
}

function logRow(log: TraceLog, total: number, depth: number): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'trace-log';
  const name = cell('', 'trace-name');
  const button = document.createElement('button');
  button.className = 'trace-log-button';
  button.dataset.id = String(log.id);
  const indent = Math.min(depth, 24) * 14;
  button.style.marginInlineStart = `${indent}px`;
  // The message is cut to what is left of the cell after its indent, so the button never runs past it.
  button.style.maxWidth = `calc(100% - ${indent}px)`;
  button.title = 'Show surrounding logs';
  const level = document.createElement('span');
  level.className = `level ${log.level}`;
  level.textContent = log.level;
  button.append(level, document.createTextNode(` ${log.message}`));
  name.append(button);
  row.append(
    name,
    cell(log.server ?? '', 'trace-service'),
    timeline(log.offsetMs ?? 0, undefined, total, 'trace-log-mark'),
    cell(
      log.offsetMs === undefined ? '' : `${log.offsetMs < 0 ? '−' : '+'}${formatDuration(Math.abs(log.offsetMs))}`,
      'trace-duration',
    ),
    cell('', 'trace-self'),
  );
  return row;
}
