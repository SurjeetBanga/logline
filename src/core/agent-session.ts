// What a coding agent did in one session, read from the transcript it keeps on
// this machine: Claude Code under ~/.claude/projects, Codex under ~/.codex/sessions.
// Each prompt, tool call, and reply becomes one JSON log line, so search, Analyze,
// and sharing treat an agent session like any other run.

export type AgentName = 'claude-code' | 'codex';
export const AGENT_LABELS: Record<AgentName, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

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
    const at = Date.parse(text(entry.timestamp) ?? '') || undefined;
    if (at !== undefined) {
      this.info.startedAt ??= at;
      this.info.lastAt = Math.max(this.info.lastAt ?? at, at);
    }
    return this.agent === 'claude-code' ? this.claude(entry, at) : this.codex(entry, at);
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
      ...(command ? { command: headline(command, MAX_COMMAND) } : {}),
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
      ...(command ? { command: headline(command, MAX_COMMAND) } : {}),
      ...(summary ? { summary: headline(summary, MAX_COMMAND) } : {}),
    };
  }
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
