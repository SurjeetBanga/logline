import { spanDurationMs, type AttrValue, type Attributes, type Span } from './otlp';

// Reads LLM calls, tool executions, and agent runs from spans that follow the
// OpenTelemetry GenAI semantic conventions, plus the older forms many
// instrumentations still emit: `gen_ai.system`, `gen_ai.usage.prompt_tokens`,
// OpenLLMetry's flattened `gen_ai.prompt.0.content`, and message span events.

/** What a GenAI span did: called a model, ran a tool, ran an agent, or something else. */
export type GenAiKind = 'model' | 'tool' | 'agent' | 'other';

export interface GenAiCall {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** `gen_ai.operation.name`, such as `chat`, `execute_tool`, or `invoke_agent`. */
  operation: string;
  kind: GenAiKind;
  name: string;
  service: string;
  provider?: string;
  /** The model that answered, else the model that was asked. */
  model?: string;
  agent?: string;
  tool?: string;
  conversationId?: string;
  startMs: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from the provider's cache, included in `inputTokens`. */
  cachedTokens?: number;
  finishReasons?: string[];
  error: boolean;
  errorMessage?: string;
  /** Whether prompts, responses, or tool payloads were recorded; SDKs leave them out unless asked. */
  hasContent: boolean;
}

export type GenAiPartKind = 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'other';
export interface GenAiPart {
  kind: GenAiPartKind;
  text?: string;
  /** A tool's name, or the type of an unrecognized part. */
  name?: string;
  /** A tool call id, which links a call to its result. */
  id?: string;
  /** Arguments or a result, as JSON text when structured. */
  value?: string;
  /** Text or value was cut for display. */
  truncated?: boolean;
}
export interface GenAiMessage {
  /** `system`, `user`, `assistant`, `tool`, or `tools` for the definitions offered to the model. */
  role: string;
  /** Output messages are the model's response. */
  output?: boolean;
  parts: GenAiPart[];
}

export interface GenAiModelTotals {
  model: string;
  provider?: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  p50Ms: number;
  p95Ms: number;
}
export interface GenAiToolTotals {
  tool: string;
  calls: number;
  errors: number;
  p95Ms: number;
}
export interface GenAiSummary {
  /** Newest first, up to the limit. */
  calls: GenAiCall[];
  /** Every GenAI span retained, beyond the limit too. */
  total: number;
  modelCalls: number;
  toolCalls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Latency of model calls. */
  p50Ms?: number;
  p95Ms?: number;
  models: GenAiModelTotals[];
  tools: GenAiToolTotals[];
}

/** How a tool call requested by a model went, from its `execute_tool` span. */
export interface GenAiToolRun {
  spanId: string;
  tool?: string;
  durationMs: number;
  error: boolean;
  errorMessage?: string;
  result?: string;
  truncated?: boolean;
}
export interface GenAiCallDetail {
  call: GenAiCall;
  messages: GenAiMessage[];
  /** By tool call id. */
  toolRuns: Record<string, GenAiToolRun>;
  /** The model calls of the same conversation (or trace), oldest first, with this call's position. */
  conversation: { spanId: string; traceId: string }[];
  position: number;
}

const MODEL_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings', 'completion']);
const AGENT_OPERATIONS = new Set(['invoke_agent', 'create_agent']);
const KNOWN_OPERATIONS = new Set([
  ...MODEL_OPERATIONS,
  ...AGENT_OPERATIONS,
  'execute_tool',
  'retrieval',
  'fetch_response',
]);
/** Characters of one part kept for display. */
export const PART_LIMIT = 16 * 1024;

const str = (value: AttrValue | undefined): string | undefined =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined;
function num(value: AttrValue | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
const first = (attributes: Attributes, ...keys: string[]) => {
  for (const key of keys) if (attributes[key] !== undefined && attributes[key] !== null) return attributes[key];
  return undefined;
};

/** The span's GenAI operation, or undefined when it is not a GenAI span. */
export function genAiOperation(span: Span): string | undefined {
  const attributes = span.attributes;
  const named = str(attributes['gen_ai.operation.name']);
  if (named) return named;
  let genAi = false;
  for (const key in attributes)
    if (key.startsWith('gen_ai.')) {
      genAi = true;
      break;
    }
  const requestType = str(attributes['llm.request.type']);
  if (!genAi && !requestType) return undefined;
  // Instrumentations without the attribute still name spans `{operation} {model}`.
  const word = span.name.split(/[\s.]/, 1)[0].toLowerCase();
  if (KNOWN_OPERATIONS.has(word)) return word;
  if (requestType) return requestType === 'completion' ? 'text_completion' : requestType;
  if (attributes['gen_ai.tool.name'] !== undefined) return 'execute_tool';
  if (attributes['gen_ai.agent.name'] !== undefined && attributes['gen_ai.request.model'] === undefined)
    return 'invoke_agent';
  return attributes['gen_ai.request.model'] !== undefined ? 'chat' : 'other';
}

export function genAiKind(operation: string): GenAiKind {
  if (MODEL_OPERATIONS.has(operation)) return 'model';
  if (operation === 'execute_tool') return 'tool';
  if (AGENT_OPERATIONS.has(operation)) return 'agent';
  return 'other';
}

function hasContent(span: Span): boolean {
  for (const key in span.attributes)
    if (
      key === 'gen_ai.input.messages' ||
      key === 'gen_ai.output.messages' ||
      key === 'gen_ai.system_instructions' ||
      key === 'gen_ai.tool.call.arguments' ||
      key === 'gen_ai.tool.call.result' ||
      key === 'gen_ai.prompt' ||
      key === 'gen_ai.completion' ||
      key.startsWith('gen_ai.prompt.') ||
      key.startsWith('gen_ai.completion.')
    )
      return true;
  return span.events.some((event) => event.name.startsWith('gen_ai.') && Object.keys(event.attributes).length > 0);
}

function finishReasons(value: AttrValue | undefined): string[] | undefined {
  const reasons = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? (parseJson(value, (parsed) => (Array.isArray(parsed) ? parsed.map(String) : undefined)) ?? [value])
      : undefined;
  return reasons?.length ? reasons : undefined;
}

/** One GenAI span as a row; undefined when it is not one. */
export function readGenAiCall(span: Span): GenAiCall | undefined {
  const operation = genAiOperation(span);
  if (!operation) return undefined;
  const a = span.attributes;
  const flatFinish = str(a['gen_ai.completion.0.finish_reason']);
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    operation,
    kind: genAiKind(operation),
    name: span.name,
    service: span.service,
    provider: str(first(a, 'gen_ai.provider.name', 'gen_ai.system')),
    model: str(first(a, 'gen_ai.response.model', 'gen_ai.request.model', 'llm.response.model', 'llm.request.model')),
    agent: str(a['gen_ai.agent.name']),
    tool: str(a['gen_ai.tool.name']),
    conversationId: str(a['gen_ai.conversation.id']),
    startMs: span.startMs,
    durationMs: spanDurationMs(span),
    inputTokens: num(first(a, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.usage.prompt_tokens')),
    outputTokens: num(
      first(a, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.usage.completion_tokens'),
    ),
    cachedTokens: num(first(a, 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens')),
    finishReasons: finishReasons(a['gen_ai.response.finish_reasons']) ?? (flatFinish ? [flatFinish] : undefined),
    error: span.status.code === 2,
    errorMessage: span.status.message ?? str(a['error.type']),
    hasContent: hasContent(span),
  };
}

function parseJson<T>(text: string, map: (value: unknown) => T | undefined): T | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return undefined;
  try {
    return map(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/** A structured attribute, or JSON text that holds one. */
function structured(value: AttrValue | undefined): unknown {
  if (typeof value === 'string') return parseJson(value, (parsed) => parsed) ?? value;
  return value;
}

function clip(text: string): { text: string; truncated?: boolean } {
  return text.length > PART_LIMIT ? { text: text.slice(0, PART_LIMIT), truncated: true } : { text };
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function textPart(kind: GenAiPartKind, value: unknown): GenAiPart {
  const { text, truncated } = clip(asText(value));
  return { kind, text, ...(truncated ? { truncated } : {}) };
}

function valuePart(part: Omit<GenAiPart, 'value'>, value: unknown): GenAiPart {
  // Arguments often arrive as JSON text; show them pretty-printed like structured ones.
  const shown = typeof value === 'string' ? (parseJson(value, (parsed) => parsed) ?? value) : value;
  const { text, truncated } = clip(asText(shown));
  return { ...part, value: text, ...(truncated ? { truncated } : {}) };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

function readPart(value: unknown): GenAiPart | undefined {
  if (typeof value === 'string') return textPart('text', value);
  const part = record(value);
  if (!part) return undefined;
  const type = typeof part.type === 'string' ? part.type : undefined;
  if (type === 'text' || (!type && part.content !== undefined)) return textPart('text', part.content);
  if (type === 'reasoning' || type === 'thinking') return textPart('reasoning', part.content ?? part.text);
  if (type === 'tool_call' || type === 'function_call')
    return valuePart(
      { kind: 'tool_call', name: typeof part.name === 'string' ? part.name : undefined, id: idOf(part.id) },
      part.arguments,
    );
  if (type === 'tool_call_response' || type === 'tool_result')
    return valuePart({ kind: 'tool_result', id: idOf(part.id) }, part.response ?? part.result ?? part.content);
  return valuePart({ kind: 'other', name: type ?? 'part' }, part.content ?? part.uri ?? part);
}

const idOf = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** One message in the current shape (`role` and `parts`) or the older chat shape (`role`, `content`, `tool_calls`). */
function readMessage(value: unknown, output: boolean): GenAiMessage | undefined {
  const message = record(value);
  if (!message)
    return typeof value === 'string'
      ? { role: output ? 'assistant' : 'user', output, parts: [textPart('text', value)] }
      : undefined;
  const role = typeof message.role === 'string' ? message.role : output ? 'assistant' : 'user';
  const parts: GenAiPart[] = [];
  if (Array.isArray(message.parts)) for (const part of message.parts) pushPart(parts, readPart(part));
  else if (Array.isArray(message.content)) for (const part of message.content) pushPart(parts, readPart(part));
  else if (message.content !== undefined && message.content !== null && message.content !== '')
    parts.push(
      role === 'tool'
        ? valuePart({ kind: 'tool_result', id: idOf(message.tool_call_id) }, message.content)
        : textPart('text', message.content),
    );
  if (Array.isArray(message.tool_calls))
    for (const call of message.tool_calls) {
      const item = record(call);
      const fn = record(item?.function);
      if (item)
        parts.push(
          valuePart(
            {
              kind: 'tool_call',
              name: typeof (fn?.name ?? item.name) === 'string' ? String(fn?.name ?? item.name) : undefined,
              id: idOf(item.id),
            },
            fn?.arguments ?? item.arguments,
          ),
        );
    }
  return parts.length ? { role, output, parts } : undefined;
}

function pushPart(parts: GenAiPart[], part: GenAiPart | undefined) {
  if (part) parts.push(part);
}

function readMessages(value: AttrValue | undefined, output: boolean): GenAiMessage[] {
  const parsed = structured(value);
  if (parsed === undefined || parsed === null) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item) => readMessage(item, output)).filter((message): message is GenAiMessage => !!message);
}

/** OpenLLMetry's `gen_ai.prompt.0.role`, `gen_ai.prompt.0.content`, `gen_ai.completion.0.tool_calls.0.name`, …. */
function flatMessages(attributes: Attributes, prefix: 'prompt' | 'completion'): GenAiMessage[] {
  const pattern = new RegExp(`^gen_ai\\.${prefix}\\.(\\d+)\\.(.+)$`);
  const byIndex = new Map<number, Json>();
  for (const key in attributes) {
    const match = pattern.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = byIndex.get(index) ?? {};
    entry[match[2]] = attributes[key];
    byIndex.set(index, entry);
  }
  const messages: GenAiMessage[] = [];
  for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
    const entry = byIndex.get(index)!;
    const calls: Json[] = [];
    for (const [key, value] of Object.entries(entry)) {
      const call = /^tool_calls\.(\d+)\.(name|arguments|id)$/.exec(key);
      if (!call) continue;
      const slot = Number(call[1]);
      calls[slot] ??= {};
      calls[slot][call[2]] = value;
    }
    const message = readMessage(
      { role: entry.role, content: entry.content, tool_call_id: entry.tool_call_id, tool_calls: calls.filter(Boolean) },
      prefix === 'completion',
    );
    if (message) messages.push(message);
  }
  return messages;
}

const EVENT_ROLES: Record<string, string> = {
  'gen_ai.system.message': 'system',
  'gen_ai.user.message': 'user',
  'gen_ai.assistant.message': 'assistant',
  'gen_ai.tool.message': 'tool',
};

/** Messages recorded as span events, the convention before messages moved to span attributes. */
function eventMessages(span: Span): GenAiMessage[] {
  const messages: GenAiMessage[] = [];
  for (const event of span.events) {
    const a = event.attributes;
    if (event.name === 'gen_ai.content.prompt' || event.name === 'gen_ai.content.completion') {
      const output = event.name === 'gen_ai.content.completion';
      messages.push(...readMessages(a[output ? 'gen_ai.completion' : 'gen_ai.prompt'], output));
      continue;
    }
    const role = EVENT_ROLES[event.name];
    if (role) {
      const content = structured(first(a, 'gen_ai.event.content', 'content'));
      const message = readMessage(record(content) ? { role, ...record(content) } : { role, content }, false);
      if (message) messages.push(message);
    } else if (event.name === 'gen_ai.choice') {
      const content = record(structured(first(a, 'gen_ai.event.content', 'message')));
      const message = readMessage(record(content?.message) ?? content, true);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function systemMessage(value: AttrValue | undefined): GenAiMessage | undefined {
  const parsed = structured(value);
  if (parsed === undefined || parsed === null || parsed === '') return undefined;
  const parts = (Array.isArray(parsed) ? parsed : [parsed])
    .map((part) => readPart(part))
    .filter((part): part is GenAiPart => !!part);
  return parts.length ? { role: 'system', parts } : undefined;
}

function toolDefinitions(value: AttrValue | undefined): GenAiMessage | undefined {
  const parsed = structured(value);
  if (!Array.isArray(parsed) || !parsed.length) return undefined;
  const parts = parsed.map((tool) => {
    const item = record(tool);
    const fn = record(item?.function);
    const name = fn?.name ?? item?.name;
    return valuePart({ kind: 'other', name: typeof name === 'string' ? name : 'tool' }, tool);
  });
  return { role: 'tools', parts };
}

/** The conversation one span recorded: system instructions, input, output, and the tools offered. */
export function genAiMessages(span: Span): GenAiMessage[] {
  const a = span.attributes;
  const messages: GenAiMessage[] = [];
  const system = systemMessage(a['gen_ai.system_instructions']);
  if (system) messages.push(system);
  const input = readMessages(first(a, 'gen_ai.input.messages', 'gen_ai.prompt'), false);
  const output = readMessages(first(a, 'gen_ai.output.messages', 'gen_ai.completion'), true);
  messages.push(...input, ...output);
  if (!input.length && !output.length) {
    messages.push(...flatMessages(a, 'prompt'), ...flatMessages(a, 'completion'));
    if (messages.length === (system ? 1 : 0)) messages.push(...eventMessages(span));
  }
  // A tool execution records its call and result instead of messages.
  if (a['gen_ai.tool.call.arguments'] !== undefined || a['gen_ai.tool.call.result'] !== undefined) {
    const id = str(a['gen_ai.tool.call.id']);
    const tool = str(a['gen_ai.tool.name']);
    if (a['gen_ai.tool.call.arguments'] !== undefined)
      messages.push({
        role: 'assistant',
        parts: [valuePart({ kind: 'tool_call', name: tool, id }, a['gen_ai.tool.call.arguments'])],
      });
    if (a['gen_ai.tool.call.result'] !== undefined)
      messages.push({
        role: 'tool',
        output: true,
        parts: [valuePart({ kind: 'tool_result', name: tool, id }, a['gen_ai.tool.call.result'])],
      });
  }
  const tools = toolDefinitions(a['gen_ai.tool.definitions']);
  if (tools) messages.push(tools);
  return messages;
}

function percentile(sorted: number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/**
 * GenAI calls across retained traces: the newest calls, totals per model and
 * per tool, and token counts.
 */
export function summarizeGenAi(traces: Iterable<[string, readonly Span[]]>, limit = 500): GenAiSummary {
  const calls: GenAiCall[] = [];
  for (const [, spans] of traces)
    for (const span of spans) {
      const call = readGenAiCall(span);
      if (call) calls.push(call);
    }
  calls.sort((a, b) => b.startMs - a.startMs);
  const models = new Map<string, GenAiModelTotals & { durations: number[] }>();
  const tools = new Map<string, GenAiToolTotals & { durations: number[] }>();
  const modelDurations: number[] = [];
  let modelCalls = 0,
    toolCalls = 0,
    errors = 0,
    inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0;
  for (const call of calls) {
    if (call.error) errors++;
    if (call.kind === 'model') {
      modelCalls++;
      modelDurations.push(call.durationMs);
      inputTokens += call.inputTokens ?? 0;
      outputTokens += call.outputTokens ?? 0;
      cachedTokens += call.cachedTokens ?? 0;
      const key = call.model ?? 'unknown model';
      const totals = models.get(key) ?? {
        model: key,
        provider: call.provider,
        calls: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        p50Ms: 0,
        p95Ms: 0,
        durations: [],
      };
      totals.calls++;
      if (call.error) totals.errors++;
      totals.inputTokens += call.inputTokens ?? 0;
      totals.outputTokens += call.outputTokens ?? 0;
      totals.cachedTokens += call.cachedTokens ?? 0;
      totals.durations.push(call.durationMs);
      models.set(key, totals);
    } else if (call.kind === 'tool') {
      toolCalls++;
      const key = call.tool ?? call.name;
      const totals = tools.get(key) ?? { tool: key, calls: 0, errors: 0, p95Ms: 0, durations: [] };
      totals.calls++;
      if (call.error) totals.errors++;
      totals.durations.push(call.durationMs);
      tools.set(key, totals);
    }
  }
  modelDurations.sort((a, b) => a - b);
  return {
    calls: calls.slice(0, limit),
    total: calls.length,
    modelCalls,
    toolCalls,
    errors,
    inputTokens,
    outputTokens,
    cachedTokens,
    ...(modelDurations.length
      ? { p50Ms: percentile(modelDurations, 0.5), p95Ms: percentile(modelDurations, 0.95) }
      : {}),
    models: [...models.values()]
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
      .map(({ durations, ...totals }) => {
        durations.sort((a, b) => a - b);
        return { ...totals, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) };
      }),
    tools: [...tools.values()]
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool))
      .map(({ durations, ...totals }) => {
        durations.sort((a, b) => a - b);
        return { ...totals, p95Ms: percentile(durations, 0.95) };
      }),
  };
}

/**
 * One call with its conversation, the outcome of the tools it asked for, and
 * where it sits among the model calls of the same conversation.
 *
 * @param conversationSpans Spans to look in for the rest of the conversation: its trace, or every retained span.
 */
export function genAiCallDetail(
  trace: readonly Span[],
  spanId: string,
  conversationSpans: Iterable<Span> = trace,
): GenAiCallDetail | undefined {
  const span = trace.find((item) => item.spanId === spanId);
  const call = span && readGenAiCall(span);
  if (!span || !call) return undefined;
  const toolRuns: Record<string, GenAiToolRun> = {};
  for (const item of trace) {
    const id = str(item.attributes['gen_ai.tool.call.id']);
    if (!id || genAiOperation(item) !== 'execute_tool') continue;
    const result = item.attributes['gen_ai.tool.call.result'];
    const shown = result === undefined ? undefined : clip(asText(structured(result)));
    toolRuns[id] = {
      spanId: item.spanId,
      tool: str(item.attributes['gen_ai.tool.name']),
      durationMs: spanDurationMs(item),
      error: item.status.code === 2,
      errorMessage: item.status.message,
      ...(shown ? { result: shown.text, ...(shown.truncated ? { truncated: true } : {}) } : {}),
    };
  }
  const sameConversation = (other: GenAiCall) =>
    call.conversationId ? other.conversationId === call.conversationId : other.traceId === call.traceId;
  const conversation: GenAiCall[] = [];
  for (const item of call.conversationId ? conversationSpans : trace) {
    const other = readGenAiCall(item);
    if (other && other.kind === call.kind && sameConversation(other)) conversation.push(other);
  }
  conversation.sort((a, b) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId));
  return {
    call,
    messages: genAiMessages(span),
    toolRuns,
    conversation: conversation.map((item) => ({ traceId: item.traceId, spanId: item.spanId })),
    position: conversation.findIndex((item) => item.spanId === call.spanId && item.traceId === call.traceId),
  };
}

const ROLE_TITLES: Record<string, string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  tools: 'Tools available',
};

/** A message's heading: output messages are the response. */
export function roleTitle(message: GenAiMessage): string {
  if (message.output && message.role === 'assistant') return 'Response';
  return ROLE_TITLES[message.role] ?? message.role.charAt(0).toUpperCase() + message.role.slice(1);
}

/** A call and its conversation as Markdown, for pasting into an issue or an agent chat. */
export function genAiMarkdown(detail: GenAiCallDetail): string {
  const { call } = detail;
  const facts = [
    call.provider,
    call.agent && `agent ${call.agent}`,
    `${Math.round(call.durationMs)} ms`,
    call.inputTokens !== undefined &&
      `${call.inputTokens} input tokens${call.cachedTokens ? ` (${call.cachedTokens} cached)` : ''}`,
    call.outputTokens !== undefined && `${call.outputTokens} output tokens`,
    call.finishReasons?.length && `finish ${call.finishReasons.join(', ')}`,
    call.error && `error${call.errorMessage ? `: ${call.errorMessage}` : ''}`,
  ].filter(Boolean);
  const lines = [`# ${call.name}`, '', facts.join(' · '), '', `Trace \`${call.traceId}\`, span \`${call.spanId}\``];
  const fence = (text: string) => {
    const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
    return [ticks, text, ticks].join('\n');
  };
  for (const message of detail.messages) {
    lines.push('', `## ${roleTitle(message)}`);
    for (const part of message.parts) {
      if (part.kind === 'text') lines.push('', part.text ?? '');
      else if (part.kind === 'reasoning') lines.push('', '_Reasoning_', '', part.text ?? '');
      else if (part.kind === 'tool_call') {
        lines.push(
          '',
          `Tool call \`${part.name ?? 'tool'}\`${part.id ? ` (${part.id})` : ''}`,
          '',
          fence(part.value ?? ''),
        );
        const run = part.id ? detail.toolRuns[part.id] : undefined;
        if (run?.result !== undefined) lines.push('', 'Result', '', fence(run.result));
      } else if (part.kind === 'tool_result')
        lines.push('', `Tool result${part.id ? ` (${part.id})` : ''}`, '', fence(part.value ?? ''));
      else lines.push('', `\`${part.name ?? 'part'}\``, '', fence(part.value ?? part.text ?? ''));
    }
  }
  return lines.join('\n') + '\n';
}
