import * as vscode from 'vscode';
import type { AgentLogAccess, AgentSearchInput } from './agent-access';
import { AgentAccessError } from './agent-access';

const MAX_BYTES = 64 * 1024;
type ToolInput = Record<string, unknown>;
type CancellationTokenLike = { isCancellationRequested?: boolean } | undefined;
type ToolCallback = (input: ToolInput, token?: CancellationTokenLike) => unknown | Promise<unknown>;
interface LanguageModelRuntime {
  lm?: { registerTool(name: string, tool: unknown): vscode.Disposable };
  LanguageModelToolResult?: new (content: unknown[]) => unknown;
  LanguageModelTextPart?: new (value: string) => unknown;
  MarkdownString?: new (value: string) => unknown;
}
const runtimeVscode = vscode as unknown as LanguageModelRuntime;

const textResult = (value: unknown) => {
  const json = JSON.stringify(value);
  const oversized = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = Buffer.byteLength(json, 'utf8') <= MAX_BYTES ? json : JSON.stringify({
    error: 'RESULT_TOO_LARGE',
    message: 'The bounded result exceeded 64 KiB; narrow the query or inspect individual events.',
    partial: true,
    truncated: true,
    ...(typeof oversized.hasMore === 'boolean' ? { hasMore: oversized.hasMore } : {}),
    ...(Number.isSafeInteger(oversized.matched) ? { matched: oversized.matched } : {}),
    ...(Number.isSafeInteger(oversized.newest) ? { newest: oversized.newest } : {})
  });
  const Result = runtimeVscode.LanguageModelToolResult;
  const TextPart = runtimeVscode.LanguageModelTextPart;
  return Result ? new Result(TextPart ? [new TextPart(text)] : [{ type: 'text', value: text }]) : { content: [{ type: 'text', value: text }] };
};

function inputOf(options: unknown): ToolInput {
  if (!options || typeof options !== 'object') return {};
  const input = (options as { input?: unknown }).input;
  return input && typeof input === 'object' && !Array.isArray(input) ? input as ToolInput : {};
}

function invoke(access: AgentLogAccess, callback: ToolCallback) {
  return {
    async prepareInvocation(_options: unknown) {
      const MarkdownString = runtimeVscode.MarkdownString;
      const status = access.status();
      const runCount = status.sources.reduce((sum, source) => sum + source.runs.length, 0);
      const message = status.scope === 'all'
        ? 'Read-only access to existing and new captured Logline runs in this window until sharing stops. Results are redacted.'
        : `Read-only access to ${runCount} explicitly shared Logline run${runCount === 1 ? '' : 's'}; future commands are not included.`;
      return { invocationMessage: 'Reading shared Logline runs', confirmationMessages: { title: 'Read shared Logline runs', message: MarkdownString ? new MarkdownString(message) : message } };
    },
    async invoke(options: unknown, token?: CancellationTokenLike) {
      try { return textResult(await callback(inputOf(options), token)); }
      catch (error) { const e = error instanceof AgentAccessError ? error : new AgentAccessError('INVALID_INPUT', String(error)); return textResult({ error: e.code, message: e.message }); }
    }
  };
}

export function registerAgentTools(context: vscode.ExtensionContext, access: AgentLogAccess): vscode.Disposable[] {
  void context;
  const lm = runtimeVscode.lm;
  if (!lm?.registerTool) return [];
  const tools: [string, unknown][] = [
    ['logline_list_shared_sources', invoke(access, input => access.list(input))],
    ['logline_search_logs', invoke(access, input => access.search(input as unknown as AgentSearchInput))],
    ['logline_inspect_event', invoke(access, input => {
      if (typeof input.shareId !== 'string' || !Number.isSafeInteger(input.id) || (input.id as number) < 0) throw new AgentAccessError('INVALID_INPUT', 'shareId and a non-negative integer id are required.');
      if (input.context !== undefined && (!Number.isSafeInteger(input.context) || (input.context as number) < 0 || (input.context as number) > 25)) throw new AgentAccessError('INVALID_INPUT', 'context must be an integer from 0 to 25.');
      return access.inspect(input.shareId, input.id as number, input.context as number | undefined);
    })],
    ['logline_analyze_logs', invoke(access, input => access.analyze(input as unknown as AgentSearchInput))],
    ['logline_get_trace', invoke(access, input => {
      if (typeof input.shareId !== 'string' || typeof input.traceId !== 'string') throw new AgentAccessError('INVALID_INPUT', 'shareId and traceId are required.');
      return access.trace(input.shareId, input.traceId);
    })],
    ['logline_wait_for_logs', invoke(access, (input, token) => {
      if (!Number.isSafeInteger(input.watermark) || (input.watermark as number) < 0) throw new AgentAccessError('INVALID_INPUT', 'watermark must be a non-negative integer.');
      const timeoutMs = input.timeoutMs === undefined ? 5000 : Number(input.timeoutMs);
      return access.wait(input as unknown as AgentSearchInput, input.watermark as number, timeoutMs, token);
    })]
  ];
  return tools.map(([name, tool]) => lm.registerTool(name, tool));
}
