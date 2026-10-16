import type { GenAiCall, GenAiCallDetail, GenAiMessage, GenAiPart, GenAiSummary } from '../../core/gen-ai';
import { roleTitle } from '../../core/gen-ai';
import type { Snapshot } from '../../protocol/messages';
import type { Elements } from '../dom';
import { cell } from '../dom';
import type { EventScope } from '../event-scope';
import type { WebviewApi } from '../types';
import { formatDuration } from './trace';

const REFRESH_MS = 5000;
// Short blocks open by default; long ones start collapsed so the conversation stays readable.
const OPEN_BELOW_CHARACTERS = 600;
const KIND_GLYPHS: Record<GenAiCall['kind'], string> = { model: '◆', tool: '⚙', agent: '▸', other: '·' };
// A response cut short by a limit or a filter reads as a warning.
const CUT_SHORT = new Set(['length', 'max_tokens', 'content_filter', 'max_output_tokens']);
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

function tokens(value: number | undefined, short = false): string {
  if (value === undefined) return '–';
  return short && value >= 10000 ? compact.format(value) : whole.format(value);
}

/** What a call is, in a few words: `chat claude-sonnet-5-5`, `tool get_weather`, `agent planner`. */
export function callLabel(call: GenAiCall): string {
  if (call.kind === 'tool') return `tool ${call.tool ?? call.name}`;
  if (call.kind === 'agent') return `agent ${call.agent ?? call.name}`;
  return call.model ? `${call.operation} ${call.model}` : call.name;
}

/**
 * The AI calls tab: LLM calls, tool executions, and agent runs from
 * OpenTelemetry GenAI spans, with totals per model. Opening a call shows its
 * conversation, with each tool call's result beside it.
 */
export function createAiCalls(
  elements: Elements,
  api: WebviewApi,
  scope: EventScope,
  actions: {
    showTrace(traceId: string): void;
    formatTime(ms: number): string;
    /** Shows the list, or one call, in place of the table. */
    revealList(): void;
    revealCall(): void;
    listVisible(): boolean;
    callVisible(): boolean;
  },
) {
  let summary: GenAiSummary | undefined;
  let revision: number | undefined;
  let pending = false;
  let loadedAt = -Infinity;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let current: { traceId: string; spanId: string } | undefined;
  let detail: GenAiCallDetail | undefined;

  function load() {
    if (pending) return;
    pending = true;
    loadedAt = Date.now();
    api.postMessage({ type: 'aiCalls' });
  }

  // Agents call models in bursts, so a shown list refreshes at most once per interval.
  function refreshSoon() {
    if (refresh) return;
    refresh = setTimeout(
      () => {
        refresh = undefined;
        if (actions.listVisible()) load();
      },
      Math.max(0, loadedAt + REFRESH_MS - Date.now()),
    );
  }

  function show() {
    elements.aiCallsStatus.textContent = 'Loading…';
    actions.revealList();
    load();
  }

  /** Stops refreshing once another view is shown. */
  function hide() {
    clearTimeout(refresh);
    refresh = undefined;
  }

  function open(traceId: string, spanId: string) {
    current = { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase() };
    detail = undefined;
    elements.aiCallTitle.textContent = 'AI call';
    elements.aiCallStatus.textContent = 'Loading…';
    elements.aiCallTranscript.replaceChildren();
    elements.aiCallNavigation.hidden = true;
    actions.revealCall();
    api.postMessage({ type: 'aiCall', ...current });
  }

  /** Forgets the call when another view is shown, so a late reply for it is ignored. */
  function close() {
    current = undefined;
    detail = undefined;
    elements.aiCallTranscript.replaceChildren();
  }

  function openRow(target: EventTarget | null) {
    const row = (target as HTMLElement | null)?.closest<HTMLElement>('[data-span-id]');
    if (row?.dataset.traceId && row.dataset.spanId) open(row.dataset.traceId, row.dataset.spanId);
  }
  scope.listen(elements.aiCallRows, 'click', (event) => openRow(event.target));
  scope.listen(elements.aiCallRows, 'keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    event.preventDefault();
    openRow(event.target);
  });
  // A model's row narrows the list to its calls.
  scope.listen(elements.aiModelRows, 'click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    elements.aiCallsFilter.value = row.dataset.model;
    render();
  });
  scope.listen(elements.aiCallsFilter, 'input', render);
  scope.listen(elements.aiCallsKind, 'change', render);
  scope.listen(elements.aiCallsErrorsOnly, 'change', render);
  scope.listen(elements.aiCallBack, 'click', show);
  scope.listen(elements.aiCallTrace, 'click', () => {
    if (current) actions.showTrace(current.traceId);
  });
  scope.listen(elements.aiCallCopy, 'click', () => {
    if (current) api.postMessage({ type: 'copyAiCall', ...current });
  });
  const step = (offset: number) => {
    const target = detail?.conversation[detail.position + offset];
    if (target) open(target.traceId, target.spanId);
  };
  scope.listen(elements.aiCallPrevious, 'click', () => step(-1));
  scope.listen(elements.aiCallNext, 'click', () => step(1));

  /** The snapshot's call count: shows the tab and keeps the shown list current. */
  function update(calls: Snapshot['aiCalls']) {
    elements.aiCalls.hidden = !calls;
    elements.aiCallCount.textContent = calls ? whole.format(calls.calls) : '';
    elements.aiCalls.title = calls
      ? `${whole.format(calls.calls)} LLM calls, tool executions, and agent runs from OpenTelemetry. Show their models, tokens, and conversations.`
      : '';
    const changed = calls?.revision !== revision;
    revision = calls?.revision;
    if (changed && actions.listVisible()) refreshSoon();
  }

  function receive(list: GenAiSummary) {
    pending = false;
    summary = list;
    if (actions.listVisible()) render();
  }

  function receiveCall(message: { traceId: string; spanId: string; detail?: GenAiCallDetail }) {
    if (!actions.callVisible() || message.traceId !== current?.traceId || message.spanId !== current.spanId) return;
    if (!message.detail) {
      elements.aiCallStatus.textContent = 'This call is no longer retained.';
      return;
    }
    detail = message.detail;
    renderCall(message.detail);
  }

  function shown(calls: GenAiCall[]): GenAiCall[] {
    const kind = elements.aiCallsKind.value;
    const errorsOnly = elements.aiCallsErrorsOnly.checked;
    const terms = elements.aiCallsFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return calls.filter((call) => {
      if (kind && call.kind !== kind) return false;
      if (errorsOnly && !call.error) return false;
      if (!terms.length) return true;
      const text = [call.name, call.model, call.tool, call.agent, call.provider, call.service, call.operation]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }

  function render() {
    if (!summary) return;
    if (!summary.total) {
      elements.aiCallsStatus.textContent =
        'No AI calls yet. Apps instrumented with the OpenTelemetry GenAI conventions send their LLM calls, tool executions, and agent runs to the receiver.';
      elements.aiCallsTiles.replaceChildren();
      elements.aiModelRows.replaceChildren();
      elements.aiCallRows.replaceChildren();
      return;
    }
    const rows = shown(summary.calls);
    elements.aiCallsStatus.textContent =
      `${whole.format(summary.total)} AI ${summary.total === 1 ? 'call' : 'calls'}` +
      (summary.errors ? ` · ${whole.format(summary.errors)} failed` : '') +
      (summary.total > summary.calls.length ? ` · newest ${whole.format(summary.calls.length)} listed` : '') +
      (rows.length < summary.calls.length ? ` · ${whole.format(rows.length)} match` : '') +
      ' · Choose one to read its conversation';
    elements.aiCallsTiles.replaceChildren(...tiles(summary));
    elements.aiModelRows.replaceChildren(...summary.models.map(modelRow));
    elements.aiModelsTable.hidden = !summary.models.length;
    elements.aiCallRows.replaceChildren(...rows.map(callRow));
  }

  function callRow(call: GenAiCall): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.className = `ai-call-row${call.error ? ' trace-error' : ''}`;
    row.dataset.traceId = call.traceId;
    row.dataset.spanId = call.spanId;
    row.tabIndex = 0;
    const label = callLabel(call);
    row.setAttribute('aria-label', `${label}, ${formatDuration(call.durationMs)}${call.error ? ', failed' : ''}`);
    const operation = cell(`${KIND_GLYPHS[call.kind]} ${label}`, 'trace-name ai-operation');
    operation.title = [call.name, call.provider, call.service, call.errorMessage && `Error: ${call.errorMessage}`]
      .filter(Boolean)
      .join('\n');
    const usage = cell(
      call.inputTokens === undefined && call.outputTokens === undefined
        ? ''
        : `${tokens(call.inputTokens, true)} → ${tokens(call.outputTokens, true)}`,
      'ai-tokens',
    );
    if (call.cachedTokens) usage.title = `${tokens(call.cachedTokens)} of the input tokens were cached`;
    const finish = cell((call.finishReasons ?? []).join(', '), 'ai-finish');
    if (call.finishReasons?.some((reason) => CUT_SHORT.has(reason))) {
      finish.classList.add('ai-cut-short');
      finish.title = 'The response was cut short by a limit or a filter';
    }
    row.append(
      cell(actions.formatTime(call.startMs), 'time'),
      operation,
      cell(call.agent ?? '', 'ai-agent'),
      usage,
      cell(formatDuration(call.durationMs), 'trace-duration'),
      finish,
    );
    return row;
  }

  function renderCall(view: GenAiCallDetail) {
    const { call } = view;
    elements.aiCallTitle.textContent = `${KIND_GLYPHS[call.kind]} ${callLabel(call)}`;
    elements.aiCallTitle.title = `${call.name}\nTrace ${call.traceId}\nSpan ${call.spanId}`;
    elements.aiCallStatus.textContent = [
      call.provider,
      call.agent && `agent ${call.agent}`,
      formatDuration(call.durationMs),
      (call.inputTokens !== undefined || call.outputTokens !== undefined) &&
        `${tokens(call.inputTokens)} in${call.cachedTokens ? ` (${tokens(call.cachedTokens)} cached)` : ''} → ${tokens(call.outputTokens)} out`,
      call.finishReasons?.length && `finish ${call.finishReasons.join(', ')}`,
      call.error && `failed${call.errorMessage ? `: ${call.errorMessage}` : ''}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const count = view.conversation.length;
    elements.aiCallNavigation.hidden = count < 2;
    elements.aiCallPosition.textContent = `${view.position + 1} of ${count}`;
    elements.aiCallPrevious.disabled = view.position <= 0;
    elements.aiCallNext.disabled = view.position >= count - 1;
    if (!view.messages.length) {
      const note = document.createElement('p');
      note.className = 'ai-empty';
      note.textContent = call.hasContent
        ? 'This call recorded content Logline does not recognize.'
        : 'This call has no message content. Most SDKs leave prompts and responses out unless you turn on content capture, for example OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true.';
      elements.aiCallTranscript.replaceChildren(note);
      return;
    }
    elements.aiCallTranscript.replaceChildren(...view.messages.map((message) => messageBlock(message, view)));
  }

  return {
    show,
    hide,
    open,
    close,
    update,
    receive,
    receiveCall,
  };
}

function tile(label: string, value: string, detail?: string) {
  const element = document.createElement('div');
  element.className = 'analysis-tile';
  const name = document.createElement('span');
  name.className = 'tile-label';
  name.textContent = label;
  const number = document.createElement('strong');
  number.className = 'tile-value';
  number.textContent = value;
  element.append(name, number);
  if (detail) {
    const note = document.createElement('span');
    note.className = 'tile-detail';
    note.textContent = detail;
    element.append(note);
  }
  return element;
}

function tiles(summary: GenAiSummary): HTMLElement[] {
  const modelErrors = summary.models.reduce((sum, model) => sum + model.errors, 0);
  const toolErrors = summary.tools.reduce((sum, tool) => sum + tool.errors, 0);
  const cached = summary.inputTokens ? Math.round((summary.cachedTokens / summary.inputTokens) * 100) : 0;
  return [
    tile(
      'Model calls',
      whole.format(summary.modelCalls),
      modelErrors ? `${whole.format(modelErrors)} failed` : undefined,
    ),
    tile(
      'Tokens',
      `${tokens(summary.inputTokens, true)} → ${tokens(summary.outputTokens, true)}`,
      cached ? `${cached}% of input cached` : 'input → output',
    ),
    ...(summary.p50Ms !== undefined
      ? [tile('Latency', `p50 ${formatDuration(summary.p50Ms)}`, `p95 ${formatDuration(summary.p95Ms!)}`)]
      : []),
    tile('Tool calls', whole.format(summary.toolCalls), toolErrors ? `${whole.format(toolErrors)} failed` : undefined),
  ];
}

function modelRow(model: GenAiSummary['models'][number]): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.className = 'ai-model-row';
  row.dataset.model = model.model;
  row.title = `Show only ${model.model}`;
  const name = cell(model.model, 'trace-name');
  if (model.provider) {
    const provider = document.createElement('span');
    provider.className = 'ai-provider';
    provider.textContent = ` · ${model.provider}`;
    name.append(provider);
  }
  row.append(
    name,
    cell(whole.format(model.calls), 'ai-number'),
    cell(tokens(model.inputTokens, true), 'ai-number'),
    cell(tokens(model.outputTokens, true), 'ai-number'),
    cell(formatDuration(model.p95Ms), 'trace-duration'),
    cell(model.errors ? whole.format(model.errors) : '', model.errors ? 'ai-number ai-errors' : 'ai-number'),
  );
  return row;
}

function block(summary: string, body: HTMLElement[], open: boolean, className = 'ai-block'): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = className;
  details.open = open;
  const heading = document.createElement('summary');
  heading.textContent = summary;
  details.append(heading, ...body);
  return details;
}

function pre(text: string): HTMLElement {
  const element = document.createElement('pre');
  element.className = 'ai-code';
  element.textContent = text;
  return element;
}

function cutNote(): HTMLElement {
  const note = document.createElement('p');
  note.className = 'ai-cut';
  note.textContent = 'Showing the first 16 KB.';
  return note;
}

function partBlock(part: GenAiPart, detail: GenAiCallDetail): HTMLElement {
  const length = (part.text ?? part.value ?? '').length;
  const open = length < OPEN_BELOW_CHARACTERS;
  const cut = part.truncated ? [cutNote()] : [];
  if (part.kind === 'text') {
    const text = document.createElement('div');
    text.className = 'ai-text';
    text.textContent = part.text ?? '';
    if (!cut.length) return text;
    const wrapper = document.createElement('div');
    wrapper.append(text, ...cut);
    return wrapper;
  }
  if (part.kind === 'reasoning') return block('Reasoning', [pre(part.text ?? ''), ...cut], open);
  if (part.kind === 'tool_call') {
    const run = part.id ? detail.toolRuns[part.id] : undefined;
    const outcome = run ? ` · ${run.error ? 'failed' : 'ok'} · ${formatDuration(run.durationMs)}` : '';
    const body = [pre(part.value ?? ''), ...cut];
    if (run?.result !== undefined) {
      const label = document.createElement('p');
      label.className = 'ai-result-label';
      label.textContent = run.error && run.errorMessage ? `Result · ${run.errorMessage}` : 'Result';
      body.push(label, pre(run.result), ...(run.truncated ? [cutNote()] : []));
    }
    const details = block(`Tool call ${part.name ?? 'tool'}${outcome}`, body, open, 'ai-block ai-tool');
    if (run?.error) details.classList.add('ai-failed');
    return details;
  }
  if (part.kind === 'tool_result')
    return block(`Tool result${part.name ? ` ${part.name}` : ''}`, [pre(part.value ?? ''), ...cut], open);
  return block(part.name ?? 'Part', [pre(part.value ?? part.text ?? ''), ...cut], false);
}

function messageBlock(message: GenAiMessage, detail: GenAiCallDetail): HTMLElement {
  const article = document.createElement('article');
  article.className = `ai-message ai-role-${message.role.replace(/[^a-z]/gi, '')}${message.output ? ' ai-output' : ''}`;
  const heading = document.createElement('h4');
  heading.textContent = roleTitle(message);
  // Instructions and the tools on offer matter less than the exchange, so they start collapsed.
  if (message.role === 'system') {
    const lines = message.parts.reduce((sum, part) => sum + (part.text ?? part.value ?? '').split('\n').length, 0);
    article.append(
      block(
        `System instructions (${lines} ${lines === 1 ? 'line' : 'lines'})`,
        message.parts.map((part) => partBlock(part, detail)),
        false,
        'ai-block ai-system',
      ),
    );
    return article;
  }
  if (message.role === 'tools') {
    article.append(
      block(
        `${message.parts.length} ${message.parts.length === 1 ? 'tool' : 'tools'} available`,
        message.parts.map((part) => block(part.name ?? 'tool', [pre(part.value ?? '')], false)),
        false,
        'ai-block ai-system',
      ),
    );
    return article;
  }
  article.append(heading, ...message.parts.map((part) => partBlock(part, detail)));
  return article;
}
