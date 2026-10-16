// A simulated support assistant: when an order is declined, an agent looks the
// order up with a tool and drafts a reply to the customer. No model is called;
// the spans follow the OpenTelemetry GenAI conventions, so Logline's AI calls
// tab shows each call's model, tokens, and conversation.
const logger = require('./logger');
const { span } = require('./tracing');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = 'claude-haiku-5-5';
const SYSTEM = [{ type: 'text', content: 'You write short, friendly replies to customers whose payment was declined. Look up the order first. Never repeat card details.' }];
const TOOLS = [{ type: 'function', name: 'lookup_order', description: 'Order total, items, and decline code', parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] } }];
const DECLINES = ['insufficient_funds', 'card_expired', 'do_not_honor'];
let drafts = 0;

function chat(conversation, input, reply, usage) {
  return span('support-assistant', `chat ${MODEL}`, async attributes => {
    await wait(usage.ms);
    Object.assign(attributes, {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': MODEL, 'gen_ai.response.model': MODEL,
      'gen_ai.agent.name': 'support-assistant', 'gen_ai.conversation.id': conversation, 'gen_ai.request.max_tokens': 160,
      'gen_ai.usage.input_tokens': usage.input, 'gen_ai.usage.output_tokens': usage.output, 'gen_ai.usage.cache_read.input_tokens': usage.cached,
      'gen_ai.response.finish_reasons': [reply.finish_reason], 'gen_ai.system_instructions': JSON.stringify(SYSTEM),
      'gen_ai.tool.definitions': JSON.stringify(TOOLS), 'gen_ai.input.messages': JSON.stringify(input), 'gen_ai.output.messages': JSON.stringify([reply])
    });
    return reply;
  }, 3);
}

async function draftDeclineReply(order) {
  const n = ++drafts;
  const conversation = `conv_${order.id}`;
  const declineCode = DECLINES[n % DECLINES.length];
  const callId = `toolu_${order.id}`;
  const ask = { role: 'user', parts: [{ type: 'text', content: `Order ${order.id} was declined. Draft a reply to the customer.` }] };
  const toolCall = { type: 'tool_call', id: callId, name: 'lookup_order', arguments: { orderId: order.id } };
  const result = { orderId: order.id, total: order.total, items: 4, declineCode };

  await span('support-assistant', 'invoke_agent support-assistant', async () => {
    await chat(conversation, [ask], { role: 'assistant', parts: [toolCall], finish_reason: 'tool_calls' },
      { ms: 350 + Math.random() * 300, input: 612, output: 38, cached: n > 1 ? 480 : 0 });
    await span('support-assistant', 'execute_tool lookup_order', () => wait(15 + Math.random() * 30), 1, {
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup_order', 'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': callId, 'gen_ai.tool.call.arguments': JSON.stringify(toolCall.arguments), 'gen_ai.tool.call.result': JSON.stringify(result)
    });
    // Every third draft runs into the token limit, the way a long reply does.
    const cutShort = n % 3 === 0;
    const text = cutShort
      ? `Thanks for your order ${order.id}. Unfortunately your bank declined the payment of $${order.total.toFixed(2)}, which usually happens when the card issuer flags a larger purchase. You can try again with the same card after contacting your bank, use a different card, or split the order into two smaller`
      : `Thanks for your order ${order.id}. Your payment of $${order.total.toFixed(2)} was declined (${declineCode.replace(/_/g, ' ')}). Your items are held for 24 hours, so you can try again with another card.`;
    await chat(conversation, [ask, { role: 'assistant', parts: [toolCall] }, { role: 'tool', parts: [{ type: 'tool_call_response', id: callId, response: result }] }],
      { role: 'assistant', parts: [{ type: 'text', content: text }], finish_reason: cutShort ? 'max_tokens' : 'end_turn' },
      { ms: 600 + Math.random() * 500, input: 734, output: cutShort ? 160 : 64, cached: 612 });
    if (cutShort) logger.warn('support reply cut short', { orderId: order.id, finishReason: 'max_tokens' });
    else logger.info('support reply drafted', { orderId: order.id, declineCode });
  }, 1, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'anthropic', 'gen_ai.agent.name': 'support-assistant', 'gen_ai.conversation.id': conversation });
}

module.exports = { draftDeclineReply };
