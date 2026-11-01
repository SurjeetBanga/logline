// Anonymous usage events: what may leave the machine, and in what shape. Every
// property is checked against a rule here, so a caller cannot send a string the
// schema does not name: log text, queries, paths, names, and hosts have no rule.
import type { ConnectionType } from './connections';
import { BUILT_IN_FIELDS, type ParsedQuery } from './query';

export type UsageValue = string | number | boolean | string[];
export type UsageProperties = Record<string, UsageValue>;

/** Values a caller cannot spell wrong, such as connection types, checked at runtime against the editor's lists. */
export interface UsageVocabulary {
  commands: ReadonlySet<string>;
  guideSections: ReadonlySet<string>;
  /** Each `logline.*` setting: `boolean`, `number`, the values of an enum, or `custom` for anything else. */
  settings: ReadonlyMap<string, 'boolean' | 'number' | 'custom' | readonly string[]>;
}

type Rule =
  | { kind: 'enum'; values: readonly string[] | ((vocabulary: UsageVocabulary) => ReadonlySet<string>) }
  | { kind: 'list'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'count' }
  | { kind: 'ms' }
  | { kind: 'duration' }
  | { kind: 'bytes' }
  | { kind: 'version' }
  | { kind: 'setting' };

const oneOf = (...values: string[]): Rule => ({ kind: 'enum', values });
const listOf = (...values: string[]): Rule => ({ kind: 'list', values });
const BOOL: Rule = { kind: 'bool' };
const COUNT: Rule = { kind: 'count' };
const MS: Rule = { kind: 'ms' };
const DURATION: Rule = { kind: 'duration' };

export const CONNECTION_TYPES: readonly ConnectionType[] = [
  'sqlite',
  'postgres',
  'mysql',
  'mongodb',
  'datadog',
  'cloudwatch',
  'loki',
  'elasticsearch',
  'gcp',
];
/** The panel's views, as `ViewName` in the webview names them. */
export const USAGE_VIEWS = [
  'logs',
  'analysis',
  'compare',
  'traces',
  'trace',
  'metrics',
  'aiCalls',
  'aiCall',
  'doctor',
  'connection',
] as const;
export const CAPTURE_KINDS = [
  'terminal',
  'debug',
  'task',
  'file',
  'compose',
  'command',
  'otlp',
  'import',
  'connection',
] as const;
export const AGENT_TOOLS = [
  'logline_list_shared_sources',
  'logline_search_logs',
  'logline_inspect_event',
  'logline_analyze_logs',
  'logline_get_trace',
  'logline_get_ai_calls',
  'logline_fetch_production',
  'logline_compare_with_production',
  'logline_wait_for_logs',
] as const;
export const AGENT_CLIENTS = ['claude-code', 'codex', 'cursor', 'copilot', 'other'] as const;
export const MILESTONES = [
  'first_capture',
  'first_search',
  'first_filtered_search',
  'first_view_switch',
  'first_connection',
  'first_share',
  'first_agent_call',
  'first_doctor_action',
  'first_log_breakpoint',
] as const;
export type Milestone = (typeof MILESTONES)[number];
/** Why an agent tool call failed: its error code, never its message. */
export const AGENT_ERROR_CODES = [
  'NOT_SHARED',
  'SHARE_CHANGED',
  'INVALID_INPUT',
  'EVENT_UNAVAILABLE',
  'CANCELLED',
  'BUSY',
  'CONNECTION_UNAVAILABLE',
  'RANGE_TOO_LARGE',
  'REMOTE_ERROR',
  'RESULT_TOO_LARGE',
] as const;
/** What failed inside Logline, by area, as one of these codes. */
export const ERROR_CODES = ['start_failed'] as const;
/** What Log Doctor finds: its own checks and the OpenTelemetry conventions. */
export const DOCTOR_CODES = [
  'secret',
  'personal',
  'noisy',
  'missing-exception',
  'unstructured',
  'quiet-failure',
  'oversized',
  'contextless',
  'unnamed-service',
  'span-name-ids',
  'missing-route',
  'unmarked-error',
  'old-attributes',
  'unit-in-name',
] as const;
/** What a search used, counted per session; field names only when they are Logline's own. */
export const SEARCH_OPERATORS = ['field', 'negation', 'regex', 'time', 'compare', 'glob', 'changed', 'or'] as const;
export type SearchOperator = (typeof SEARCH_OPERATORS)[number];
const FIELD_NAMES = [...BUILT_IN_FIELDS];

const connection = oneOf(...CONNECTION_TYPES);
/** Every event and the rule for each property it may carry. Anything else is dropped. */
export const USAGE_EVENTS: Record<string, Record<string, Rule>> = {
  installed: {},
  updated: { from: { kind: 'version' } },
  activated: {},
  active_day: {},
  milestone: { name: oneOf(...MILESTONES), after: DURATION },
  command: { id: { kind: 'enum', values: (vocabulary) => vocabulary.commands } },
  capture_started: { kind: oneOf(...CAPTURE_KINDS) },
  view_opened: { view: oneOf(...USAGE_VIEWS) },
  connection_added: { type: connection, auth: oneOf('password', 'iam', 'other') },
  connection_searched: { type: connection, ok: BOOL, ms: MS, rows: COUNT },
  connection_tailed: { type: connection },
  connection_sql_run: { type: connection, ok: BOOL },
  connection_tested: { type: connection, ok: BOOL },
  connection_agent_allowed: { type: connection },
  shared_with_agent: { how: oneOf('all', 'runs', 'event'), sources: COUNT, events: COUNT, redacted: BOOL },
  sharing_stopped: { duration: DURATION },
  exported_for_ai: {},
  ask_copilot: {},
  agent_connected: { client: oneOf(...AGENT_CLIENTS) },
  agent_tool: {
    tool: oneOf(...AGENT_TOOLS),
    via: oneOf('copilot', 'mcp'),
    client: oneOf(...AGENT_CLIENTS),
    ok: BOOL,
    code: oneOf(...AGENT_ERROR_CODES),
    ms: MS,
    result_size: { kind: 'bytes' },
    truncated: BOOL,
  },
  first_tool_after_share: { after: DURATION },
  tour: { step: oneOf('started', 'finished', 'skipped') },
  guide_section: { section: { kind: 'enum', values: (vocabulary) => vocabulary.guideSections } },
  setting_changed: {
    key: { kind: 'enum', values: (vocabulary) => new Set(vocabulary.settings.keys()) },
    value: { kind: 'setting' },
  },
  perf: { op: oneOf('activate', 'first_render', 'search', 'import'), ms: MS, events: COUNT },
  doctor_finding: { code: oneOf(...DOCTOR_CODES) },
  doctor_action: { action: oneOf('open', 'showEvents', 'fix', 'report') },
  feedback: { surface: oneOf('doctor', 'copilot'), code: oneOf(...DOCTOR_CODES), helpful: BOOL },
  log_lens_clicked: {},
  log_breakpoint: { step: oneOf('set', 'hit') },
  compare_production: { ok: BOOL },
  error: { area: oneOf('bridge', 'otlp', 'connection', 'import', 'export', 'capture'), code: oneOf(...ERROR_CODES) },
  session_summary: {
    active_minutes: DURATION,
    searches: COUNT,
    events_captured: COUNT,
    sources: COUNT,
    memory_mb: COUNT,
    trimmed: BOOL,
    peak_events_per_sec: COUNT,
    views_used: listOf(...USAGE_VIEWS),
    features_used: listOf(...CAPTURE_KINDS, ...AGENT_TOOLS),
    fields: listOf(...FIELD_NAMES),
    ...Object.fromEntries(SEARCH_OPERATORS.map((operator) => [`op_${operator}`, COUNT])),
    ...Object.fromEntries(CONNECTION_TYPES.map((type) => [`conn_${type}`, COUNT])),
    shares: COUNT,
    tool_calls: COUNT,
    unused_shares: COUNT,
    clients_used: listOf(...AGENT_CLIENTS),
  },
};
export type UsageEventName = keyof typeof USAGE_EVENTS;

/** `0`, `1-9`, `10-99`, `100-999`, `1k-10k`, `10k-100k`, `100k+`. */
export function countBucket(n: number): string {
  if (!(n > 0)) return '0';
  if (n < 10) return '1-9';
  if (n < 100) return '10-99';
  if (n < 1000) return '100-999';
  if (n < 10_000) return '1k-10k';
  if (n < 100_000) return '10k-100k';
  return '100k+';
}

const MS_EDGES: [number, string][] = [
  [10, '<10ms'],
  [25, '10-24ms'],
  [50, '25-49ms'],
  [100, '50-99ms'],
  [250, '100-249ms'],
  [500, '250-499ms'],
  [1000, '500-999ms'],
  [5000, '1-5s'],
  [15_000, '5-15s'],
];
export function msBucket(ms: number): string {
  for (const [edge, label] of MS_EDGES) if (ms < edge) return label;
  return '15s+';
}

const MINUTE = 60_000;
const DURATION_EDGES: [number, string][] = [
  [MINUTE, '<1m'],
  [5 * MINUTE, '1-5m'],
  [15 * MINUTE, '5-15m'],
  [60 * MINUTE, '15-60m'],
  [6 * 60 * MINUTE, '1-6h'],
  [24 * 60 * MINUTE, '6-24h'],
  [7 * 24 * 60 * MINUTE, '1-7d'],
];
export function durationBucket(ms: number): string {
  for (const [edge, label] of DURATION_EDGES) if (ms < edge) return label;
  return '7d+';
}

export function bytesBucket(bytes: number): string {
  if (bytes < 1024) return '<1KB';
  if (bytes < 8 * 1024) return '1-8KB';
  if (bytes < 32 * 1024) return '8-32KB';
  return '32KB+';
}

export function cpusBucket(cpus: number): string {
  if (cpus <= 2) return '1-2';
  if (cpus <= 4) return '3-4';
  if (cpus <= 8) return '5-8';
  if (cpus <= 16) return '9-16';
  return '17+';
}

export function ramBucket(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb < 7.5) return '<8';
  if (gb < 15.5) return '8-15';
  if (gb < 31.5) return '16-31';
  return '32+';
}

/** The editor, from `vscode.env.appName`. */
export function hostApp(appName: string | undefined): string {
  const name = (appName ?? '').toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('vscodium')) return 'vscodium';
  if (name.includes('visual studio code')) return 'vscode';
  return 'other';
}

/** Where the extension runs, from `vscode.env.remoteName`. */
export function remoteKind(remoteName: string | undefined): string {
  if (!remoteName) return 'none';
  if (remoteName === 'ssh-remote') return 'ssh';
  if (remoteName === 'wsl') return 'wsl';
  if (remoteName === 'dev-container' || remoteName === 'attached-container') return 'container';
  if (remoteName === 'codespaces') return 'codespaces';
  return 'other';
}

/** An MCP client's self-reported name, which can be anything, as one of a few known clients. */
export function agentClient(name: string | undefined): (typeof AGENT_CLIENTS)[number] {
  const lower = (name ?? '').toLowerCase();
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('copilot')) return 'copilot';
  return 'other';
}

/** The common properties every event carries: the editor and machine, coarsely. */
export interface UsageEnvironment {
  version: string;
  vscode: string;
  appName?: string;
  uiKind: 'desktop' | 'web';
  remoteName?: string;
  platform: string;
  arch: string;
  cpus: number;
  totalMemory: number;
}

export function commonProperties(env: UsageEnvironment): UsageProperties {
  const version = (value: string) => (VERSION.test(value) ? value : 'unknown');
  return {
    version: version(env.version),
    vscode: version(env.vscode),
    host: hostApp(env.appName),
    ui: env.uiKind,
    remote: remoteKind(env.remoteName),
    os: ['darwin', 'win32', 'linux'].includes(env.platform) ? env.platform : 'other',
    arch: ['x64', 'arm64', 'arm', 'ia32'].includes(env.arch) ? env.arch : 'other',
    cpus: cpusBucket(env.cpus),
    ram_gb: ramBucket(env.totalMemory),
  };
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,20})?$/;

function settingValue(rule: 'boolean' | 'number' | 'custom' | readonly string[], value: unknown): UsageValue {
  if (rule === 'boolean') return typeof value === 'boolean' ? value : 'custom';
  if (rule === 'number') return typeof value === 'number' ? countBucket(value) : 'custom';
  if (Array.isArray(rule)) return typeof value === 'string' && rule.includes(value) ? value : 'custom';
  return 'custom';
}

function check(
  rule: Rule,
  value: unknown,
  vocabulary: UsageVocabulary,
  properties: Record<string, unknown>,
): UsageValue | undefined {
  switch (rule.kind) {
    case 'enum': {
      if (typeof value !== 'string') return undefined;
      const values = typeof rule.values === 'function' ? rule.values(vocabulary) : rule.values;
      const allowed = 'has' in values ? (values as ReadonlySet<string>).has(value) : values.includes(value);
      return allowed ? value : undefined;
    }
    case 'list':
      return Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === 'string' && rule.values.includes(item)))]
        : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'count':
      return typeof value === 'number' ? countBucket(value) : undefined;
    case 'ms':
      return typeof value === 'number' ? msBucket(value) : undefined;
    case 'duration':
      return typeof value === 'number' ? durationBucket(value) : undefined;
    case 'bytes':
      return typeof value === 'number' ? bytesBucket(value) : undefined;
    case 'version':
      return typeof value === 'string' && VERSION.test(value) ? value : undefined;
    case 'setting': {
      const key = properties.key;
      const setting = typeof key === 'string' ? vocabulary.settings.get(key) : undefined;
      return setting ? settingValue(setting, value) : undefined;
    }
  }
}

/**
 * The event as it may be sent: only properties its schema names, each bucketed or
 * checked against its allowed values. Unknown events give `undefined`.
 */
export function sanitizeUsage(
  name: string,
  properties: Record<string, unknown>,
  vocabulary: UsageVocabulary,
): UsageProperties | undefined {
  const schema = Object.hasOwn(USAGE_EVENTS, name) ? USAGE_EVENTS[name] : undefined;
  if (!schema) return undefined;
  const clean: UsageProperties = {};
  for (const [key, rule] of Object.entries(schema)) {
    if (!Object.hasOwn(properties, key)) continue;
    const value = check(rule, properties[key], vocabulary, properties);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/** Which operators a search used, and which of Logline's own fields it filtered on. Never the values. */
export function queryFeatures(query: ParsedQuery): { operators: Set<SearchOperator>; fields: Set<string> } {
  const operators = new Set<SearchOperator>();
  const fields = new Set<string>();
  if (query.length > 1) operators.add('or');
  for (const group of query)
    for (const token of group) {
      if (token.negate) operators.add('negation');
      if (token.regex !== undefined) operators.add('regex');
      if (token.timestampRange || token.relativeMs !== undefined) operators.add('time');
      if (token.numericComparison || token.numericRange) operators.add('compare');
      if (token.glob) operators.add('glob');
      if (token.changed !== undefined) operators.add('changed');
      if (token.canonical !== undefined) {
        operators.add('field');
        if (BUILT_IN_FIELDS.has(token.canonical)) fields.add(token.canonical);
      }
    }
  return { operators, fields };
}
