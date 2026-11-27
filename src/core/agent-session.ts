// What a coding agent did in one session, read from the transcript it keeps on
// this machine: Claude Code under ~/.claude/projects, Codex under ~/.codex/sessions,
// Copilot CLI under ~/.copilot/session-state, and Copilot Chat in VS Code's workspace storage.
// Each prompt, tool call, and reply becomes one JSON log line, so search, Analyze,
// and sharing treat an agent session like any other run.

import { finishedTools, plainMessage, replayChatLine, replyText } from './copilot-chat';

export type AgentName = 'claude-code' | 'codex' | 'copilot';
export const AGENT_LABELS: Record<AgentName, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
};
export const AGENT_NAMES = Object.keys(AGENT_LABELS) as AgentName[];

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && (AGENT_NAMES as string[]).includes(value);
}

/** The source an agent's sessions belong to. */
export function agentSource(agent: AgentName): { serverId: string; server: string } {
  return { serverId: `agent:${agent}`, server: AGENT_LABELS[agent] };
}

/** One step of a session as a JSON log line's fields. */
export interface AgentRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  kind: 'agent';
  agent: AgentName;
  /** What happened: the person asked, the agent ran a tool, or the agent answered. */
  action: 'prompt' | 'tool' | 'reply';
  session: string;
  tool?: string;
  /** A shell command the tool ran. */
  command?: string;
  /** The file the tool read or changed, relative to the session's folder when inside it. */
  file?: string;
  exitCode?: number;
  durationMs?: number;
  /** The end of what a failed tool printed. */
  output?: string;
  model?: string;
}

export interface AgentTokens {
  input: number;
  output: number;
  /** Input read from the prompt cache. */
  cached: number;
}

export interface AgentSessionInfo {
  id?: string;
  /** The folder the agent worked in. */
  cwd?: string;
  /** The session's title, when the agent names it. */
  title?: string;
  /** What the person first asked, which names a session the agent did not title. */
  firstPrompt?: string;
  model?: string;
  startedAt?: number;
  lastAt?: number;
  tokens: AgentTokens;
  toolCalls: number;
  failedCalls: number;
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const MAX_MESSAGE = 300;
const MAX_COMMAND = 500;
const MAX_OUTPUT = 400;
/** Tool calls waiting for their result; a session that never answers one cannot hold more. */
const MAX_PENDING = 500;

/** The first line of a text, cut short. */
export function headline(value: string, length = MAX_MESSAGE): string {
  const line = value.trim().split('\n', 1)[0].trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
}
/** A command as one line, ending in `…` when it was cut short or had more lines, so it is never taken for all of it. */
export function commandText(command: string): string {
  const line = headline(command, MAX_COMMAND);
  return line === command.trim() || line.endsWith('…') ? line : `${line}…`;
}
const tail = (value: string, length = MAX_OUTPUT) =>
  value.length > length ? `…${value.slice(value.length - length)}` : value;

/** Text a person typed, not a reminder or command output the agent added to the conversation. */
function typed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !trimmed.startsWith('<') && !trimmed.startsWith('# AGENTS.md') ? trimmed : undefined;
}

/** The text of a message's content: a string, or the text parts of a list. */
function contentText(content: unknown, types = ['text', 'input_text', 'output_text']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => object(part))
    .filter((part) => part && types.includes(String(part.type)))
    .map((part) => text(part!.text) ?? '')
    .join('\n');
}

/** `Exit code 1`, `Exit code: 1`, `Process exited with code 1`. */
export function exitCodeOf(output: string): number | undefined {
  const match = /(?:exit code:?|exited with code)\s*(-?\d+)/i.exec(output);
  return match ? Number(match[1]) : undefined;
}

function relative(file: string, cwd: string | undefined): string {
  return cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

interface Pending {
  tool: string;
  at: number;
  command?: string;
  file?: string;
  summary?: string;
}

/**
 * Reads one session file line by line. A tool call is reported when its result
 * arrives, so it carries its duration and outcome, at the time it was called.
 */
export class AgentSessionParser {
  readonly info: AgentSessionInfo = { tokens: { input: 0, output: 0, cached: 0 }, toolCalls: 0, failedCalls: 0 };
  private readonly pending = new Map<string, Pending>();
  /** Claude Code repeats a reply's usage on each of its content parts: counted once per reply. */
  private readonly counted = new Map<string, AgentTokens>();
  /** A Copilot Chat session as its file's lines so far have made it. */
  private chat?: Json;
  /** What of a Copilot Chat session was logged: `prompt <request>`, `reply <request>`, `tool <call>`. */
  private readonly logged = new Set<string>();
  /** Copilot CLI recorded each model call's usage, so its totals at shutdown are not needed. */
  private cliUsage = false;

  constructor(readonly agent: AgentName) {}

  line(line: string): AgentRecord[] {
    if (!line.trim()) return [];
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      return [];
    }
    if (!entry) return [];
    // Copilot Chat lines change the session rather than say what happened, and have no time of their own.
    if (this.agent === 'copilot' && typeof entry.kind === 'number') return this.copilotChat(entry);
    const at = Date.parse(text(entry.timestamp) ?? '') || undefined;
    this.seen(at);
    if (this.agent === 'copilot') return this.copilotCli(entry, at);
    return this.agent === 'claude-code' ? this.claude(entry, at) : this.codex(entry, at);
  }

  private seen(at: number | undefined): void {
    if (at === undefined) return;
    this.info.startedAt ??= at;
    this.info.lastAt = Math.max(this.info.lastAt ?? at, at);
  }

  private record(at: number | undefined, fields: Omit<AgentRecord, 'timestamp' | 'kind' | 'agent' | 'session'>) {
    const record: AgentRecord = {
      timestamp: new Date(at ?? this.info.lastAt ?? 0).toISOString(),
      kind: 'agent',
      agent: this.agent,
      session: this.info.id ?? '',
      ...fields,
    };
    if (this.info.model && !record.model) record.model = this.info.model;
    return record;
  }

  private prompt(at: number | undefined, prompt: string): AgentRecord {
    this.info.firstPrompt ??= headline(prompt, 120);
    return this.record(at, { level: 'info', message: headline(prompt), action: 'prompt' });
  }

  /** A short name for the session: its title, else what was first asked. */
  get label(): string | undefined {
    return this.info.title ?? this.info.firstPrompt;
  }

  private call(id: string, pending: Pending): void {
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, pending);
  }

  /** The tool call `id` finished. */
  private finished(id: string, at: number | undefined, output: string, failed: boolean, ms?: number): AgentRecord[] {
    const call = this.pending.get(id);
    if (!call) return [];
    this.pending.delete(id);
    const exitCode = exitCodeOf(output.slice(0, 2000));
    const error = failed || (exitCode !== undefined && exitCode !== 0);
    this.info.toolCalls++;
    if (error) this.info.failedCalls++;
    const durationMs = ms ?? (at !== undefined ? Math.max(0, at - call.at) : undefined);
    const outcome = exitCode !== undefined ? `exit ${exitCode}` : error ? 'failed' : '';
    const record = this.record(call.at, {
      level: error ? 'error' : 'info',
      message: [call.tool, call.summary, outcome].filter(Boolean).join('  '),
      action: 'tool',
      tool: call.tool,
      ...(call.command ? { command: call.command } : {}),
      ...(call.file ? { file: call.file } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(error && output.trim() ? { output: tail(output.trim()) } : {}),
    });
    return [record];
  }

  private claude(entry: Json, at: number | undefined): AgentRecord[] {
    this.info.id ??= text(entry.sessionId);
    this.info.cwd ??= text(entry.cwd);
    if (entry.type === 'ai-title' || entry.type === 'summary') {
      this.info.title = headline(text(entry.aiTitle) ?? text(entry.summary) ?? '', 120) || this.info.title;
      return [];
    }
    const message = object(entry.message);
    if (!message || entry.isMeta === true || entry.isSidechain === true) return [];
    const records: AgentRecord[] = [];
    if (entry.type === 'assistant') {
      const model = text(message.model);
      if (model && !model.startsWith('<')) this.info.model = model;
      this.usage(text(message.id), object(message.usage));
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const block = object(part);
        if (block?.type === 'tool_use' && typeof block.id === 'string' && at !== undefined)
          this.call(block.id, this.claudeTool(text(block.name) ?? 'tool', object(block.input) ?? {}, at));
        else if (block?.type === 'text' && text(block.text)?.trim())
          records.push(this.record(at, { level: 'info', message: headline(text(block.text)!), action: 'reply' }));
      }
    } else if (entry.type === 'user') {
      const content = message.content;
      if (Array.isArray(content) && content.some((part) => object(part)?.type === 'tool_result')) {
        const result = object(entry.toolUseResult);
        for (const part of content) {
          const block = object(part);
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const output =
            contentText(block.content) || [text(result?.stdout), text(result?.stderr)].filter(Boolean).join('\n');
          records.push(...this.finished(block.tool_use_id, at, output, block.is_error === true));
        }
      } else {
        const prompt = typed(contentText(content));
        if (prompt) records.push(this.prompt(at, prompt));
      }
    }
    return records;
  }

  private claudeTool(tool: string, input: Json, at: number): Pending {
    const command = text(input.command);
    const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
    const file = path ? relative(path, this.info.cwd) : undefined;
    const summary = command
      ? headline(command, MAX_COMMAND)
      : (file ??
        headline(
          text(input.pattern) ??
            text(input.description) ??
            text(input.url) ??
            text(input.query) ??
            text(input.prompt) ??
            '',
          160,
        ));
    return {
      tool,
      at,
      ...(command ? { command: commandText(command) } : {}),
      ...(file ? { file } : {}),
      summary,
    };
  }

  private usage(id: string | undefined, usage: Json | undefined): void {
    if (!usage) return;
    const tokens: AgentTokens = {
      input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
      output: count(usage.output_tokens),
      cached: count(usage.cache_read_input_tokens),
    };
    const before = id ? this.counted.get(id) : undefined;
    if (id) this.counted.set(id, tokens);
    this.info.tokens.input += tokens.input - (before?.input ?? 0);
    this.info.tokens.output += tokens.output - (before?.output ?? 0);
    this.info.tokens.cached += tokens.cached - (before?.cached ?? 0);
  }

  private codex(entry: Json, at: number | undefined): AgentRecord[] {
    const payload = object(entry.payload);
    if (!payload) return [];
    if (entry.type === 'session_meta') {
      this.info.id ??= text(payload.id) ?? text(payload.session_id);
      this.info.cwd ??= text(payload.cwd);
      return [];
    }
    if (entry.type === 'turn_context') {
      this.info.model = text(payload.model) ?? this.info.model;
      this.info.cwd ??= text(payload.cwd);
      return [];
    }
    if (entry.type === 'event_msg') {
      if (payload.type === 'token_count') {
        const total = object(object(payload.info)?.total_token_usage);
        if (total) {
          const cached = count(total.cached_input_tokens);
          this.info.tokens = {
            input: Math.max(0, count(total.input_tokens) - cached),
            output: count(total.output_tokens),
            cached,
          };
        }
      }
      return [];
    }
    if (entry.type !== 'response_item') return [];
    switch (payload.type) {
      case 'message': {
        const said = contentText(payload.content);
        if (payload.role === 'user') {
          const prompt = typed(said);
          return prompt ? [this.prompt(at, prompt)] : [];
        }
        return payload.role === 'assistant' && said.trim()
          ? [this.record(at, { level: 'info', message: headline(said), action: 'reply' })]
          : [];
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = text(payload.call_id) ?? text(payload.id);
        if (id && at !== undefined) this.call(id, this.codexTool(payload, at));
        return [];
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const id = text(payload.call_id);
        if (!id) return [];
        const raw = payload.output;
        const output = typeof raw === 'string' ? codexOutput(raw) : contentText(raw);
        const wall = /Wall time:?\s*([\d.]+)\s*s/i.exec(output);
        const failed = /^\s*(Script failed|Error\b|error:)/i.test(output);
        return this.finished(id, at, output, failed, wall ? Math.round(Number(wall[1]) * 1000) : undefined);
      }
      default:
        return [];
    }
  }

  private codexTool(payload: Json, at: number): Pending {
    const tool = text(payload.name) ?? 'shell';
    const action = object(payload.action);
    let source = text(payload.input) ?? '';
    let args: Json | undefined;
    if (typeof payload.arguments === 'string')
      try {
        args = object(JSON.parse(payload.arguments));
      } catch {
        source = payload.arguments;
      }
    const shell = Array.isArray(action?.command) ? action!.command.map(String).join(' ') : undefined;
    const listed = args && Array.isArray(args.command) ? args.command.map(String).join(' ') : undefined;
    const command = shell ?? listed ?? (args ? text(args.cmd) : undefined) ?? embeddedCommand(source);
    const summary = command ?? headline(text(args?.title) ?? source, 160);
    // Codex runs shell commands from a script tool; the command is what was done.
    const name = command && tool === 'exec' ? 'shell' : tool;
    return {
      tool: name,
      at,
      ...(command ? { command: commandText(command) } : {}),
      ...(summary ? { summary: headline(summary, MAX_COMMAND) } : {}),
    };
  }

  /** Copilot CLI: one event per line, such as `user.message` or `tool.execution_complete`. */
  private copilotCli(entry: Json, at: number | undefined): AgentRecord[] {
    const data = object(entry.data) ?? {};
    switch (entry.type) {
      case 'session.start':
      case 'session.resume':
        this.info.id ??= text(data.sessionId);
        this.info.cwd ??= text(object(data.context)?.cwd);
        return [];
      case 'session.model_change':
        this.info.model = modelName(data.newModel) ?? this.info.model;
        return [];
      case 'session.auto_mode_resolved':
        this.info.model = modelName(data.chosenModel) ?? this.info.model;
        return [];
      case 'session.usage_record': {
        const usage = object(data.usage);
        if (!usage) return [];
        const cached = count(usage.cacheReadTokens);
        this.info.tokens.input += Math.max(0, count(usage.inputTokens) - cached);
        this.info.tokens.output += count(usage.outputTokens);
        this.info.tokens.cached += cached;
        this.cliUsage = true;
        return [];
      }
      case 'session.shutdown': {
        // Earlier versions record only the session's totals, when it ends.
        const details = object(data.tokenDetails);
        const tokens = (name: string) => count(object(details?.[name])?.tokenCount);
        if (details && !this.cliUsage)
          this.info.tokens = {
            input: tokens('input') + tokens('cache_write'),
            output: tokens('output'),
            cached: tokens('cache_read'),
          };
        return [];
      }
      case 'user.message': {
        const prompt = typed(text(data.content));
        return prompt ? [this.prompt(at, prompt)] : [];
      }
      case 'assistant.message': {
        this.info.model = modelName(data.model) ?? this.info.model;
        const said = text(data.content);
        return said?.trim() ? [this.record(at, { level: 'info', message: headline(said), action: 'reply' })] : [];
      }
      case 'tool.execution_start': {
        const id = text(data.toolCallId);
        if (id && at !== undefined)
          this.call(id, this.claudeTool(text(data.toolName) ?? 'tool', object(data.arguments) ?? {}, at));
        return [];
      }
      case 'tool.execution_complete': {
        const id = text(data.toolCallId);
        if (!id) return [];
        const exit = object(data.shellExecution)?.exitCode;
        const said = text(object(data.result)?.content) ?? text(object(data.error)?.message) ?? text(data.error) ?? '';
        const output = typeof exit === 'number' ? `Exit code: ${exit}\n${said}` : said;
        return this.finished(id, at, output, data.success === false);
      }
      case 'session.error': {
        const message = text(data.message);
        return message ? [this.record(at, { level: 'error', message: headline(message), action: 'reply' })] : [];
      }
      default:
        return [];
    }
  }

  /**
   * Copilot Chat: replay the line, then log what the session has that was not
   * logged yet. A request's prompt is logged once it appears, each tool call
   * once it finished, and the reply once the request is done.
   */
  private copilotChat(entry: Json): AgentRecord[] {
    this.chat = replayChatLine(this.chat, entry);
    const chat = this.chat;
    if (!chat) return [];
    this.info.id ??= text(chat.sessionId);
    const created = typeof chat.creationDate === 'number' ? chat.creationDate : undefined;
    this.seen(created);
    if (text(chat.customTitle)?.trim()) this.info.title = headline(text(chat.customTitle)!, 120);
    const records: AgentRecord[] = [];
    for (const value of Array.isArray(chat.requests) ? chat.requests : []) {
      const request = object(value);
      const id = text(request?.requestId);
      if (!request || !id) continue;
      const at = typeof request.timestamp === 'number' ? request.timestamp : undefined;
      this.seen(at);
      this.info.model =
        modelName(object(object(request.result)?.metadata)?.resolvedModel) ??
        modelName(request.modelId) ??
        this.info.model;
      if (!this.logged.has(`prompt ${id}`)) {
        this.logged.add(`prompt ${id}`);
        const prompt = typed(text(object(request.message)?.text));
        if (prompt) records.push(this.prompt(at, prompt));
      }
      for (const call of finishedTools(request)) {
        if (this.logged.has(`tool ${call.id}`)) continue;
        this.logged.add(`tool ${call.id}`);
        const { text: said, file } = plainMessage(call.said, this.info.cwd);
        const when = call.at ?? at;
        this.seen(when);
        this.info.toolCalls++;
        if (call.failed) this.info.failedCalls++;
        const outcome = call.denied
          ? 'denied'
          : call.exitCode !== undefined
            ? `exit ${call.exitCode}`
            : call.failed
              ? 'failed'
              : '';
        const summary = call.command ? headline(call.command, MAX_COMMAND) : headline(said, 160);
        records.push(
          this.record(when, {
            level: call.failed ? 'error' : call.denied ? 'warn' : 'info',
            message: [call.tool, summary, outcome].filter(Boolean).join('  '),
            action: 'tool',
            tool: call.tool,
            ...(call.command ? { command: commandText(call.command) } : {}),
            ...(file ? { file } : {}),
            ...(call.exitCode !== undefined ? { exitCode: call.exitCode } : {}),
            ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
            ...(call.failed && call.output?.trim() ? { output: tail(call.output.trim()) } : {}),
          }),
        );
      }
      const result = object(request.result);
      if (!result || this.logged.has(`reply ${id}`)) continue;
      this.logged.add(`reply ${id}`);
      this.usage(`chat ${id}`, { input_tokens: request.promptTokens, output_tokens: request.completionTokens });
      const elapsed = typeof request.elapsedMs === 'number' ? request.elapsedMs : undefined;
      const done =
        count(object(request.modelState)?.completedAt) ||
        (at !== undefined && elapsed !== undefined ? at + elapsed : at);
      this.seen(done || undefined);
      const error = text(object(result.errorDetails)?.message);
      const reply = replyText(request);
      if (reply)
        records.push(this.record(done || undefined, { level: 'info', message: headline(reply), action: 'reply' }));
      if (error)
        records.push(
          this.record(done || undefined, {
            level: 'error',
            message: headline(error),
            action: 'reply',
            ...(elapsed !== undefined ? { durationMs: elapsed } : {}),
          }),
        );
    }
    return records;
  }
}

/** Copilot names models `copilot/auto` in Chat; the name after the provider is the model. */
function modelName(value: unknown): string | undefined {
  const name = text(value)?.replace(/^copilot\//, '');
  return name && name !== 'auto' ? name : undefined;
}

/** Codex sends some outputs as JSON: `{"output": "...", "metadata": {"exit_code": 1}}`, or a list of text parts. */
function codexOutput(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return contentText(parsed);
    const value = object(parsed);
    const exit = object(value?.metadata)?.exit_code;
    const output = text(value?.output) ?? raw;
    return typeof exit === 'number' ? `Exit code: ${exit}\n${output}` : output;
  } catch {
    return raw;
  }
}

/** The shell command in a script that runs one: `exec_command({cmd:"npm test"})`. */
export function embeddedCommand(source: string): string | undefined {
  const match = /\bcmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

/** Claude Code files a session under its folder, with each character other than a letter or digit as `-`. */
export function claudeProjectDir(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Whether `cwd` is `folder` or inside it. */
export function within(cwd: string | undefined, folder: string): boolean {
  if (!cwd) return false;
  const base = folder.replace(/[\\/]+$/, '');
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
}
