import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  genAiCallDetail,
  genAiMarkdown,
  genAiMessages,
  readGenAiCall,
  roleTitle,
  summarizeGenAi,
  PART_LIMIT,
} from './gen-ai';
import { readLogs, readSpans, spanLine, type Attributes, type Span } from './otlp';
import { buildTrace, SpanStore } from './traces';

const TRACE = 'a'.repeat(32);

function span(spanId: string, name: string, attributes: Attributes, extra: Partial<Span> = {}): Span {
  return {
    traceId: TRACE,
    spanId,
    name,
    kind: 3,
    startMs: 1000,
    endMs: 2000,
    service: 'agent',
    attributes,
    events: [],
    status: { code: 0 },
    ...extra,
  };
}

// The OTLP/JSON shape an exporter sends, so values go through the receiver's own decoding.
const value = (item: unknown): unknown =>
  typeof item === 'string'
    ? { stringValue: item }
    : typeof item === 'number'
      ? { intValue: String(item) }
      : Array.isArray(item)
        ? { arrayValue: { values: item.map(value) } }
        : { kvlistValue: { values: Object.entries(item as object).map(([key, v]) => ({ key, value: value(v) })) } };
const otlp = (attributes: Record<string, unknown>, name = 'chat claude-sonnet-5-5') =>
  readSpans({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: '1'.repeat(16),
                name,
                kind: 3,
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '3400000000',
                attributes: Object.entries(attributes).map(([key, v]) => ({ key, value: value(v) })),
              },
            ],
          },
        ],
      },
    ],
  })[0];

test('a chat span in the current conventions reads as a model call with its conversation', () => {
  const chat = otlp({
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.request.model': 'claude-sonnet-5-5',
    'gen_ai.response.model': 'claude-sonnet-5-5-20260901',
    'gen_ai.agent.name': 'planner',
    'gen_ai.conversation.id': 'conv-1',
    'gen_ai.usage.input_tokens': 1204,
    'gen_ai.usage.output_tokens': 340,
    'gen_ai.usage.cache_read.input_tokens': 800,
    'gen_ai.response.finish_reasons': ['tool_calls'],
    // Recorded as JSON text, which the conventions allow when structured values are not supported.
    'gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: 'You plan trips.' }]),
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'What should I pack for Paris?' }] }],
    'gen_ai.output.messages': [
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'Check the forecast first.' },
          { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } },
        ],
        finish_reason: 'tool_calls',
      },
    ],
  });
  assert.deepEqual(
    { ...readGenAiCall(chat), startMs: undefined },
    {
      traceId: TRACE,
      spanId: '1'.repeat(16),
      parentSpanId: undefined,
      operation: 'chat',
      kind: 'model',
      name: 'chat claude-sonnet-5-5',
      service: 'agent',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5-20260901',
      agent: 'planner',
      tool: undefined,
      conversationId: 'conv-1',
      startMs: undefined,
      durationMs: 2400,
      inputTokens: 1204,
      outputTokens: 340,
      cachedTokens: 800,
      finishReasons: ['tool_calls'],
      error: false,
      errorMessage: undefined,
      hasContent: true,
    },
  );
  const messages = genAiMessages(chat);
  assert.deepEqual(
    messages.map((message) => [roleTitle(message), message.parts.map((part) => part.kind)]),
    [
      ['System', ['text']],
      ['User', ['text']],
      ['Response', ['reasoning', 'tool_call']],
    ],
  );
  assert.equal(messages[1].parts[0].text, 'What should I pack for Paris?');
  const call = messages[2].parts[1];
  assert.deepEqual([call.name, call.id, JSON.parse(call.value!)], ['get_weather', 'call_1', { city: 'Paris' }]);
});

test('long prompts survive ingest while other attributes are still cut, and stay out of table rows', () => {
  const prompt = 'x'.repeat(20_000);
  const chat = otlp({
    'gen_ai.operation.name': 'chat',
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: prompt }] }],
    'http.url': 'y'.repeat(20_000),
  });
  const parts = (chat.attributes['gen_ai.input.messages'] as Attributes[])[0].parts as Attributes[];
  assert.equal((parts[0].content as string).length, 20_000, 'content keeps up to 64 KiB');
  assert.equal((chat.attributes['http.url'] as string).length, 4096);
  const shown = genAiMessages(chat)[0].parts[0];
  assert.equal(shown.text!.length, PART_LIMIT, 'display cuts a part');
  assert.equal(shown.truncated, true);
  // Text is prepared before it is cut, so a secret across the cut is still recognized.
  const secret = 'ghp_' + 'a'.repeat(36);
  const crossing = otlp({
    'gen_ai.operation.name': 'chat',
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'x'.repeat(90) + secret }] }],
  });
  const redacted = genAiMessages(crossing, { text: (text) => text.replaceAll(secret, '[REDACTED]'), limit: 100 });
  assert.equal(redacted[0].parts[0].text, 'x'.repeat(90) + '[REDACTED]');
  const line = JSON.parse(spanLine(chat));
  assert.equal(line['gen_ai.input.messages'], undefined, 'the table row leaves prompts to the AI calls view');
  assert.equal(line['gen_ai.operation.name'], 'chat');
});

test('message events keep long content, and log records keep the usual limit', () => {
  const prompt = 'x'.repeat(20_000);
  const [evented] = readSpans({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: '1'.repeat(16),
                name: 'chat gpt-4o',
                startTimeUnixNano: '1000000000',
                attributes: [{ key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } }],
                events: [
                  { name: 'gen_ai.user.message', attributes: [{ key: 'content', value: { stringValue: prompt } }] },
                  { name: 'retry', attributes: [{ key: 'content', value: { stringValue: prompt } }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal((evented.events[0].attributes.content as string).length, 20_000);
  assert.equal((evented.events[1].attributes.content as string).length, 4096, 'other events keep the usual limit');
  const [log] = readLogs({
    resourceLogs: [
      {
        scopeLogs: [
          { logRecords: [{ attributes: [{ key: 'gen_ai.input.messages', value: { stringValue: prompt } }] }] },
        ],
      },
    ],
  });
  assert.equal((log.attributes['gen_ai.input.messages'] as string).length, 4096);
});

test('older conventions and flattened messages still read as calls and conversations', () => {
  const legacy = span('2'.repeat(16), 'openai.chat', {
    'gen_ai.system': 'openai',
    'gen_ai.request.model': 'gpt-4o-mini',
    'gen_ai.usage.prompt_tokens': '880',
    'gen_ai.usage.completion_tokens': 4096,
    'gen_ai.prompt.0.role': 'system',
    'gen_ai.prompt.0.content': 'Be brief.',
    'gen_ai.prompt.1.role': 'user',
    'gen_ai.prompt.1.content': 'Weather in Oslo?',
    'gen_ai.completion.0.role': 'assistant',
    'gen_ai.completion.0.finish_reason': 'length',
    'gen_ai.completion.0.tool_calls.0.id': 'c9',
    'gen_ai.completion.0.tool_calls.0.name': 'get_weather',
    'gen_ai.completion.0.tool_calls.0.arguments': '{"city":"Oslo"}',
  });
  const call = readGenAiCall(legacy)!;
  assert.deepEqual(
    [call.operation, call.provider, call.model, call.inputTokens, call.outputTokens, call.finishReasons],
    ['chat', 'openai', 'gpt-4o-mini', 880, 4096, ['length']],
  );
  const messages = genAiMessages(legacy);
  assert.deepEqual(
    messages.map((message) => [message.role, message.parts.map((part) => part.text ?? part.name)]),
    [
      ['system', ['Be brief.']],
      ['user', ['Weather in Oslo?']],
      ['assistant', ['get_weather']],
    ],
  );
  assert.equal(JSON.parse(messages[2].parts[0].value!).city, 'Oslo', 'JSON arguments are pretty-printed');

  // Messages as span events, the convention before they moved to attributes.
  const evented = span(
    '3'.repeat(16),
    'chat gpt-4o',
    { 'gen_ai.operation.name': 'chat' },
    {
      events: [
        { timeMs: 1000, name: 'gen_ai.user.message', attributes: { content: 'Hi' } },
        {
          timeMs: 1500,
          name: 'gen_ai.choice',
          attributes: { message: JSON.stringify({ role: 'assistant', content: 'Hello!' }) },
        },
      ],
    },
  );
  assert.equal(readGenAiCall(evented)!.hasContent, true);
  assert.deepEqual(
    genAiMessages(evented).map((message) => [roleTitle(message), message.parts[0].text]),
    [
      ['User', 'Hi'],
      ['Response', 'Hello!'],
    ],
  );
  // The older chat shape: content strings and tool_calls.
  const chatShape = span('4'.repeat(16), 'chat', {
    'gen_ai.operation.name': 'chat',
    'gen_ai.input.messages': JSON.stringify([
      { role: 'user', content: 'List files' },
      { role: 'user', content: [{ type: 'text', text: 'in src' }] },
      { role: 'tool', tool_call_id: 't1', content: '["a.ts"]' },
    ]),
  });
  assert.deepEqual(
    genAiMessages(chatShape).map((message) => message.parts.map((part) => [part.kind, part.id ?? part.text])),
    [[['text', 'List files']], [['text', 'in src']], [['tool_result', 't1']]],
  );
  assert.equal(readGenAiCall(span('5'.repeat(16), 'GET /health', { 'http.route': '/health' })), undefined);
});

test('without content capture a call keeps its numbers and says it has no content', () => {
  const call = readGenAiCall(
    span('6'.repeat(16), 'chat gpt-4o', {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 12,
    }),
  )!;
  assert.equal(call.hasContent, false);
  assert.equal(call.inputTokens, 12);
});

function agentRun(): Span[] {
  const at = (start: number, end: number) => ({ startMs: start, endMs: end });
  return [
    span(
      'a0'.padEnd(16, '0'),
      'invoke_agent planner',
      { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'planner' },
      at(0, 5000),
    ),
    span(
      'a1'.padEnd(16, '0'),
      'chat claude-sonnet-5-5',
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-5-5',
        'gen_ai.usage.input_tokens': 1000,
        'gen_ai.usage.output_tokens': 100,
        'gen_ai.output.messages': [
          { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{}' }] },
        ],
      },
      { ...at(10, 2410), parentSpanId: 'a0'.padEnd(16, '0') },
    ),
    span(
      'a2'.padEnd(16, '0'),
      'execute_tool get_weather',
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': 'get_weather',
        'gen_ai.tool.call.id': 'call_1',
        'gen_ai.tool.call.result': { high: 14, rain: 0.7 },
      },
      { ...at(2420, 2600), parentSpanId: 'a0'.padEnd(16, '0') },
    ),
    span(
      'a3'.padEnd(16, '0'),
      'chat claude-sonnet-5-5',
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-5-5',
        'gen_ai.usage.input_tokens': 1600,
        'gen_ai.usage.output_tokens': 200,
      },
      { ...at(2610, 4510), parentSpanId: 'a0'.padEnd(16, '0'), status: { code: 2, message: 'overloaded' } },
    ),
    span(
      'a4'.padEnd(16, '0'),
      'chat gpt-4o-mini',
      { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-4o-mini' },
      at(4600, 4700),
    ),
  ];
}

test('the summary totals calls, tokens, and latency per model and tool, newest first', () => {
  const summary = summarizeGenAi([[TRACE, agentRun()]], 3);
  assert.equal(summary.total, 5);
  assert.deepEqual(
    summary.calls.map((call) => call.spanId.slice(0, 2)),
    ['a4', 'a3', 'a2'],
    'newest first, limited',
  );
  assert.deepEqual(
    [summary.modelCalls, summary.toolCalls, summary.errors, summary.inputTokens, summary.outputTokens],
    [3, 1, 1, 2600, 300],
  );
  assert.deepEqual(
    summary.models.map((model) => [model.model, model.calls, model.errors, model.inputTokens, model.p95Ms]),
    [
      ['claude-sonnet-5-5', 2, 1, 2600, 2400],
      ['gpt-4o-mini', 1, 0, 0, 100],
    ],
  );
  assert.deepEqual(summary.tools, [{ tool: 'get_weather', calls: 1, errors: 0, p95Ms: 180 }]);
  assert.equal(summary.p50Ms, 1900);
});

test('a call shows the result of the tools it asked for and where it sits in its conversation', () => {
  const spans = agentRun();
  const detail = genAiCallDetail(spans, 'a1'.padEnd(16, '0'))!;
  assert.deepEqual(detail.toolRuns.call_1, {
    spanId: 'a2'.padEnd(16, '0'),
    tool: 'get_weather',
    durationMs: 180,
    error: false,
    errorMessage: undefined,
    result: JSON.stringify({ high: 14, rain: 0.7 }, null, 2),
  });
  assert.deepEqual(
    detail.conversation.map((item) => item.spanId.slice(0, 2)),
    ['a1', 'a3', 'a4'],
    'the model calls of the same trace, oldest first',
  );
  assert.equal(detail.position, 0);
  assert.equal(genAiCallDetail(spans, 'nope'), undefined);
  // With a conversation id, the conversation spans traces.
  const other = span(
    'b1'.padEnd(16, '0'),
    'chat',
    { 'gen_ai.operation.name': 'chat', 'gen_ai.conversation.id': 'c' },
    { traceId: 'b'.repeat(32), startMs: 0 },
  );
  const later = span(
    'c1'.padEnd(16, '0'),
    'chat',
    { 'gen_ai.operation.name': 'chat', 'gen_ai.conversation.id': 'c' },
    { traceId: 'c'.repeat(32), startMs: 9000 },
  );
  const joined = genAiCallDetail([later], later.spanId, {
    conversationCalls: [other, later].map((item) => readGenAiCall(item)!),
  })!;
  assert.deepEqual([joined.conversation.length, joined.position], [2, 1]);

  const markdown = genAiMarkdown(detail);
  assert.match(markdown, /^# chat claude-sonnet-5-5\n/);
  assert.match(markdown, /1000 input tokens · 100 output tokens/);
  assert.match(markdown, /Tool call `get_weather` \(call_1\)/);
  assert.match(markdown, /Result\n\n```\n\{\n {2}"high": 14/);
  // Content with backticks gets a longer fence, so it cannot close it early.
  const fenced = genAiMarkdown({
    ...detail,
    messages: [{ role: 'tool', parts: [{ kind: 'tool_result', value: 'a ``` b' }] }],
  });
  assert.match(fenced, /````\na ``` b\n````/);
});

test('the span store counts GenAI spans as they arrive and leave, and the waterfall labels them', () => {
  const store = new SpanStore(3);
  const spans = agentRun();
  for (const item of spans.slice(0, 3)) store.add(item);
  assert.equal(store.genAiCount, 3);
  const revision = store.genAiRevision;
  store.add(span('fe'.padEnd(16, '0'), 'GET /', { 'http.route': '/' }));
  assert.equal(store.genAiCount, 2, 'an evicted GenAI span is no longer counted');
  assert.equal(store.genAiRevision, revision + 1, 'evicting a GenAI span changes the GenAI revision');
  store.add(span('ff'.padEnd(16, '0'), 'GET /', { 'http.route': '/' }));
  store.add(span('fd'.padEnd(16, '0'), 'GET /', { 'http.route': '/' }));
  store.add(span('fc'.padEnd(16, '0'), 'GET /', { 'http.route': '/' }));
  const settled = store.genAiRevision;
  store.add(span('fb'.padEnd(16, '0'), 'GET /', { 'http.route': '/' }));
  assert.equal(store.genAiRevision, settled, 'other spans leave it alone');
  store.clear();
  assert.equal(store.genAiCount, 0);
  const rows = buildTrace(TRACE, spans).spans;
  assert.deepEqual(
    rows.map((row) => row.genAi),
    [
      // An agent run totals the model calls beneath it.
      { kind: 'agent', label: 'planner', modelCalls: { calls: 2, inputTokens: 2600, outputTokens: 300 } },
      { kind: 'model', label: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 100 },
      { kind: 'tool', label: 'tool · get_weather' },
      { kind: 'model', label: 'claude-sonnet-5-5', inputTokens: 1600, outputTokens: 200 },
      { kind: 'model', label: 'gpt-4o-mini' },
    ],
  );
});
