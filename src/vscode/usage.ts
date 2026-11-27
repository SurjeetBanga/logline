import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import * as os from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  AUTOMATIC_CAPTURES,
  debuggerKind,
  TEST_FRAMEWORKS,
  USAGE_HOST,
  type TIMED_REQUESTS,
  commonProperties,
  DOCTOR_CODES,
  MILESTONES,
  panelWidth,
  sanitizeUsage,
  USAGE_EVENTS,
  type Milestone,
  type PanelAction,
  type SearchOperator,
  type UsageEnvironment,
  type UsageProperties,
  type UsageVocabulary,
} from '../core/usage-events';
import type { TelemetryCode } from '../core/telemetry-findings';
import type { FindingCode } from './log-doctor';
import type { AgentErrorCode } from './agent-access';
import type { AGENT_ERROR_CODES } from '../core/usage-events';

// Every kind of Log Doctor finding is one usage counts can name; a new kind fails to compile until it is added.
type UncountedFinding = Exclude<FindingCode | TelemetryCode, (typeof DOCTOR_CODES)[number]>;
const doctorCodesComplete: [UncountedFinding] extends [never] ? true : never = true;
void doctorCodesComplete;
// Every agent error code is one usage counts can name; a new one fails to compile until it is added.
type UncountedAgentError = Exclude<AgentErrorCode, (typeof AGENT_ERROR_CODES)[number]>;
const agentCodesComplete: [UncountedAgentError] extends [never] ? true : never = true;
void agentCodesComplete;

// Where anonymous usage counts go. The project key can only write events, so it is
// safe to ship; with no key, nothing is sent and Show Usage Data still lists events.
export { USAGE_HOST };
export const USAGE_PROJECT_KEY = 'phc_Amvwr7HmP3SzK8uTELYNuC7joo6jKtC8X9TvovZW37b2';

const ID_KEY = 'logline.usage.id';
const STATE_KEY = 'logline.usage.state';
/** Holds the anonymous id in the extension's storage folder, where windows starting together can agree on one. */
const ID_FILE = 'usage-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_LIMIT = 500;
/** How many times a batch is sent before its events are dropped, so a short outage loses nothing. */
const SEND_ATTEMPTS = 3;
/** How long activation may take to report its time before `activated` is sent without it. */
const ACTIVATION_WAIT_MS = 30_000;
const FLUSH_MS = 60_000;
const SUMMARY_MS = 24 * 60 * 60 * 1000;
const LOG_LIMIT = 200;
/** Searches are timed for the first few in a session, then one in this many. */
const SAMPLE_AFTER = 5;
const SAMPLE_EVERY = 50;
export const SURVEY_TEXT_LIMIT = 500;
/** How long after Ask Copilot to ask whether it helped, and how often at most. */
export const HELPFUL_DELAY_MS = 5 * 60 * 1000;
const HELPFUL_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const HELPFUL_TIMES = 3;

interface UsageState {
  installedAt?: number;
  /** When Logline last asked whether Copilot helped, and how many times. */
  helpfulAsked?: number;
  helpfulTimes?: number;
  version?: string;
  /** The local date of the last `active_day`. */
  activeDay?: string;
  milestones?: string[];
}

interface QueuedEvent {
  event: string;
  properties: UsageProperties;
  timestamp: string;
  /** Its own one-time id instead of the install's, for answers a person wrote. */
  distinctId?: string;
  /** How many times it was sent and not accepted; it is dropped after `SEND_ATTEMPTS`. */
  failures?: number;
}

/** Sends one batch and says whether it was accepted; the default posts it to PostHog. */
export type UsageTransport = (body: string) => Promise<boolean>;

/** What a session summary reads from the rest of Logline when it is sent. */
export interface UsageSummarySource {
  eventsCaptured(): number;
  sources(): number;
  memoryMb(): number;
  trimmed(): boolean;
  connections(): Record<string, number>;
  /** Runtime errors and test failures marked in the editor now. */
  runtimeErrors?(): number;
  /** Agent sessions read, and which agents they came from. */
  agentSessions?(): { sessions: number; agents: string[] };
  /** Terminal commands captured, run while capture was off, or with no stream to read; terminals without integration. */
  terminal?(): { captured: number; uncaptured: number; unreadable: number; unintegrated: number };
  /** Log statements showing their latest value at the end of their line now. */
  inlineValues?(): number;
  /** Whether terminal capture is on only because nobody set it. */
  captureDefault?(): boolean;
  /** Events dropped to stay within limits, and events cut short. */
  discarded?(): number;
  truncated?(): number;
  /** How the newest retained events parsed, as percentages; nothing when there are none. */
  quality?(): { json: number; unclassified: number; multiline: number } | undefined;
}

export interface UsageOptions {
  vocabulary: UsageVocabulary;
  environment: UsageEnvironment;
  transport?: UsageTransport;
  now?: () => number;
  /**
   * Where to keep what an uninstall reports, in the extension's own folder, which the `vscode:uninstall` script
   * reads after Logline is removed. Kept only while usage counts are on.
   */
  willFile?: string;
  /** Process environment, for DO_NOT_TRACK and LOGLINE_USAGE_DEBUG. */
  env?: NodeJS.ProcessEnv;
  projectKey?: string;
}

type TelemetryLoggerLike = Pick<
  vscode.TelemetryLogger,
  'logUsage' | 'logError' | 'isUsageEnabled' | 'isErrorsEnabled'
> &
  Partial<Pick<vscode.TelemetryLogger, 'dispose' | 'onDidChangeEnableStates'>>;

function postBatch(body: string): Promise<boolean> {
  return new Promise((resolve) => {
    // node:https, not fetch: the extension host routes it through the editor's proxy settings.
    const req = request(
      `${USAGE_HOST}/batch/`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 },
      (res) => {
        res.resume();
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        res.on('end', () => resolve(ok));
        res.on('error', () => resolve(false));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

/**
 * Anonymous usage counts, only while both VS Code's telemetry setting and
 * `logline.telemetry.enabled` allow them. Events are checked against the schema
 * in `core/usage-events`, queued in memory, and sent in batches; nothing is
 * written to disk, and a batch that is not accepted is tried once more, then dropped.
 */
export class Usage implements vscode.Disposable {
  private readonly logger?: TelemetryLoggerLike;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: UsageTransport;
  private readonly projectKey: string;
  private readonly common: UsageProperties;
  private readonly production: boolean;
  private queue: QueuedEvent[] = [];
  private readonly log: string[] = [];
  private channel?: vscode.OutputChannel;
  private flushTimer?: ReturnType<typeof setInterval>;
  private helpfulTimer?: ReturnType<typeof setTimeout>;
  private readonly findingCodes = new Set<string>();
  private summaryTimer?: ReturnType<typeof setInterval>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private id = '';
  private fresh = false;
  private panelCounted = false;
  private sizeCounted = false;
  private readonly startedAt: number;
  private readonly terminalsChecked = new Set<string>();
  private readonly actions = new Set<PanelAction>();
  private inspected = 0;
  private emptySearches = 0;
  private summarySource?: UsageSummarySource;
  private disposed = false;
  private closing?: Promise<void>;
  // This session's counts, sent as one summary.
  private readonly activeMinutes = new Set<number>();
  private readonly views = new Set<string>();
  private readonly features = new Set<string>();
  private readonly clients = new Set<string>();
  private readonly operators = new Map<SearchOperator, number>();
  private readonly fields = new Set<string>();
  private searches = 0;
  private timedSearches = 0;
  private shares = 0;
  private toolCalls = 0;
  private sharedAt?: number;
  private sharedCalls = 0;
  private unusedShares = 0;
  private peakEventsPerSecond = 0;
  private readonly debuggers = new Set<string>();
  private readonly snapshotted = new Set<string>();
  private readonly testFrameworks = new Set<string>();
  private snapshots = 0;
  private activationCounted = false;
  private readonly timedRequests = new Map<string, number>();
  private investigatedAt?: number;
  private investigations = 0;
  private investigationsRead = 0;
  private activationTimer?: ReturnType<typeof setTimeout>;
  private testRuns = 0;
  private testsFailed = 0;
  private lastSample?: { total: number; at: number };

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'globalState'> &
      Partial<Pick<vscode.ExtensionContext, 'extensionMode' | 'globalStorageUri'>>,
    private readonly options: UsageOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.env = options.env ?? process.env;
    this.transport = options.transport ?? postBatch;
    this.projectKey = options.projectKey ?? USAGE_PROJECT_KEY;
    this.common = commonProperties(options.environment);
    // Development hosts, tests, and smoke runs never send; the debug switch lists events instead.
    this.production = context.extensionMode === (vscode.ExtensionMode?.Production ?? 1);
    const create = vscode.env?.createTelemetryLogger;
    if (typeof create === 'function')
      this.logger = create(
        {
          sendEventData: (eventName, data) => this.enqueue(eventName, data),
          sendErrorData: () => undefined,
        },
        { ignoreBuiltInCommonProperties: true, ignoreUnhandledErrors: true },
      );
  }

  /** Start: the anonymous id, install and update events, the flush timer, and the settings listener. */
  start(summary?: UsageSummarySource): void {
    this.summarySource = summary;
    const state = this.state;
    let id = this.context.globalState.get<string>(ID_KEY);
    if (!id) {
      // Someone who used Logline before usage counts existed is not a new install, and their firsts are long past.
      const existing = (this.context.globalState.keys?.() ?? []).some((key) => key.startsWith('logline.'));
      const claim = this.claimId(randomUUID());
      id = claim.id;
      void this.save(ID_KEY, id);
      this.id = id;
      // Another window of this install got there first: it counts the install and keeps the state.
      if (claim.first) {
        this.saveState({
          installedAt: this.now(),
          version: this.common.version as string,
          milestones: existing ? [...MILESTONES] : [],
        });
        this.fresh = !existing;
        if (this.fresh) this.record('installed');
      }
    } else {
      this.id = id;
      if (state.version && state.version !== this.common.version) this.record('updated', { from: state.version });
      if (state.version !== this.common.version) this.saveState({ version: this.common.version as string });
    }
    this.writeWill();
    this.activationTimer = setTimeout(() => this.activated(), ACTIVATION_WAIT_MS);
    this.activationTimer.unref?.();
    this.flushTimer = setInterval(() => {
      this.sampleRate();
      void this.flush();
    }, FLUSH_MS);
    this.flushTimer.unref?.();
    this.summaryTimer = setInterval(() => this.sendSummary(), SUMMARY_MS);
    this.summaryTimer.unref?.();
    const onConfig = vscode.workspace?.onDidChangeConfiguration;
    if (onConfig)
      this.subscriptions.push(
        onConfig((event) => {
          if (event.affectsConfiguration('logline.telemetry.enabled')) {
            if (!this.settingEnabled()) this.queue = [];
            this.writeWill();
          }
          for (const key of this.options.vocabulary.settings.keys())
            if (key !== 'telemetry.enabled' && event.affectsConfiguration(`logline.${key}`))
              this.record('setting_changed', {
                key,
                value: vscode.workspace.getConfiguration('logline').get(key),
              });
        }),
      );
    const onStates = this.logger?.onDidChangeEnableStates;
    if (onStates)
      this.subscriptions.push(
        onStates(() => {
          if (!this.logger?.isUsageEnabled) this.queue = [];
          this.writeWill();
        }),
      );
  }

  /** Whether events are recorded at all: VS Code's telemetry level, then Logline's own switch. */
  get enabled(): boolean {
    if (/^(1|true)$/i.test(this.env.DO_NOT_TRACK ?? '')) return false;
    return (this.logger?.isUsageEnabled ?? vscode.env?.isTelemetryEnabled ?? false) && this.settingEnabled();
  }

  get usageId(): string {
    return this.id;
  }

  /** Whether this window is the one that found Logline newly installed, whether or not usage counts are on. */
  get newInstall(): boolean {
    return this.fresh;
  }

  private get idFile(): string | undefined {
    const folder = this.context.globalStorageUri?.fsPath;
    return folder ? join(folder, ID_FILE) : undefined;
  }

  /**
   * Windows open during an install start together, before they see each other's
   * stored id. Linking a finished file into place is atomic, so one wins and the
   * rest read its whole id rather than each counting an install.
   */
  private claimId(candidate: string): { id: string; first: boolean } {
    const file = this.idFile;
    if (!file) return { id: candidate, first: true };
    const finished = `${file}.${candidate}`;
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(finished, candidate);
      linkSync(finished, file);
      return { id: candidate, first: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && this.createdId(file, candidate))
        return { id: candidate, first: true };
    } finally {
      try {
        rmSync(finished, { force: true });
      } catch {
        /* a stray file does no harm */
      }
    }
    try {
      const claimed = readFileSync(file, 'utf8').trim();
      if (UUID.test(claimed)) return { id: claimed, first: false };
    } catch {
      /* unreadable: this window keeps its own id */
    }
    return { id: candidate, first: true };
  }

  /** For a disk without hard links, where creating the file still lets only one window win. False if another did. */
  private createdId(file: string, candidate: string): boolean {
    try {
      writeFileSync(file, candidate, { flag: 'wx' });
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'EEXIST';
    }
  }

  private get debug(): boolean {
    return /^(1|true)$/i.test(this.env.LOGLINE_USAGE_DEBUG ?? '');
  }

  private settingEnabled(): boolean {
    return vscode.workspace?.getConfiguration?.('logline').get<boolean>('telemetry.enabled', true) ?? true;
  }

  private get state(): UsageState {
    return this.context.globalState.get<UsageState>(STATE_KEY) ?? {};
  }

  private saveState(change: Partial<UsageState>): void {
    void this.save(STATE_KEY, { ...this.state, ...change });
  }

  private save(key: string, value: unknown): Promise<void> {
    return Promise.resolve(this.context.globalState.update(key, value)).catch(() => undefined);
  }

  /** Record one event. Properties the schema does not name for it are dropped. */
  record(event: string, properties: Record<string, unknown> = {}): void {
    if (this.disposed || !this.enabled || !this.logger) return;
    const clean = sanitizeUsage(event, properties, this.options.vocabulary);
    if (!clean) return;
    if (event === 'error') {
      if (this.logger.isErrorsEnabled) this.logger.logError(event, clean);
    } else this.logger.logUsage(event, clean);
  }

  private enqueue(eventName: string, data: Record<string, unknown> | undefined): void {
    // The logger names events `<extension id>/<event>`.
    const event = eventName.slice(eventName.lastIndexOf('/') + 1);
    const schema = Object.hasOwn(USAGE_EVENTS, event) ? USAGE_EVENTS[event] : undefined;
    if (!schema || !this.enabled) return;
    // record() checked the values; keep only what it sent, whatever the logger adds.
    const properties: UsageProperties = {};
    for (const [key, value] of Object.entries(data ?? {}))
      if (Object.hasOwn(schema, key)) properties[key] = value as UsageProperties[string];
    if (this.queue.length >= QUEUE_LIMIT) this.queue.shift();
    this.queue.push({ event, properties, timestamp: this.minute() });
  }

  /** When an event happened, to the minute: nothing Logline counts needs it finer. */
  private minute(): string {
    return new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString();
  }

  /**
   * The extension finished activating, after `ms`; once. Without it, `start` sends the event
   * without a time, so an activation that failed partway is still counted.
   */
  activated(ms?: number): void {
    if (this.activationCounted) return;
    this.activationCounted = true;
    clearTimeout(this.activationTimer);
    this.record('activated', ms === undefined ? {} : { ms });
  }

  /** Something the person did, for active days and active minutes. */
  touch(): void {
    if (!this.enabled) return;
    const now = this.now();
    this.activeMinutes.add(Math.floor(now / 60_000));
    const day = new Date(now).toDateString();
    if (this.state.activeDay === day) return;
    this.saveState({ activeDay: day });
    this.record('active_day');
  }

  /** A first: sent once per install, with how long after installing it came. */
  milestone(name: Milestone): void {
    if (!this.enabled) return;
    const state = this.state;
    if (state.milestones?.includes(name)) return;
    this.saveState({ milestones: [...(state.milestones ?? []), name] });
    this.record('milestone', { name, after: this.now() - (state.installedAt ?? this.now()) });
    this.writeWill();
  }

  /** A command run from the palette, a menu, or a keybinding. */
  command(id: string): void {
    this.touch();
    this.record('command', { id });
  }

  /** The Logs panel came into view: activity each time, and one event a session. */
  panelOpened(): void {
    this.touch();
    if (this.panelCounted) return;
    this.panelCounted = true;
    this.record('panel_opened');
  }

  /** How wide the panel was when it first showed, once a session. */
  panelSize(pixels: number): void {
    if (this.sizeCounted) return;
    this.sizeCounted = true;
    this.record('panel_size', { width: panelWidth(pixels) });
  }

  /** Something done in the panel: activity each time, one event a session for each kind, and a count of events read. */
  panelAction(action: PanelAction): void {
    this.touch();
    if (action === 'inspect_event') {
      this.inspected++;
      this.milestone('first_event_inspected');
    }
    if (this.actions.has(action)) return;
    this.actions.add(action);
    this.record('panel_action', { action });
  }

  /** A view the panel opened; some poll while open, so this does not count as activity. */
  view(view: string): void {
    if (view !== 'logs' && view !== 'trace' && view !== 'aiCall') this.milestone('first_view_switch');
    if (this.views.has(view)) return;
    this.views.add(view);
    this.record('view_opened', { view });
  }

  /** A capture started; each kind counts once a session, since terminals start a run per command. */
  capture(kind: string, byDefault?: boolean): void {
    if (kind === 'agent') this.milestone('first_agent_session');
    else this.milestone('first_capture');
    if (this.features.has(kind)) return;
    this.features.add(kind);
    this.record('capture_started', {
      kind,
      auto: AUTOMATIC_CAPTURES.includes(kind),
      ...(byDefault === undefined ? {} : { by_default: byDefault }),
    });
  }

  /** A debug session started: which runtime, once a session for each. */
  debugSession(type: string | undefined): void {
    const kind = debuggerKind(type);
    if (this.debuggers.has(kind)) return;
    this.debuggers.add(kind);
    this.record('debug_session', { debugger: kind });
  }

  /** What a program held when its debugger stopped on an exception was recorded: counted, and sent once a session for each debugger. */
  exceptionSnapshot(type: string | undefined, frames: number, locals: number): void {
    this.snapshots++;
    const kind = debuggerKind(type);
    if (this.snapshotted.has(kind)) return;
    this.snapshotted.add(kind);
    this.record('exception_snapshot', { debugger: kind, frames, locals });
  }

  /** A local test run finished and was read for failures: counted, and sent once a session for each runner. */
  testRun(framework: string | undefined, failed: number, fixed: number): void {
    this.testRuns++;
    this.testsFailed += failed;
    const kind = (TEST_FRAMEWORKS as readonly string[]).includes(framework ?? '') ? framework! : 'other';
    if (this.testFrameworks.has(kind)) return;
    this.testFrameworks.add(kind);
    this.record('test_run', { framework: kind, failed, fixed });
  }

  /** Whether a terminal came up with shell integration, without which nothing is captured: each outcome once a session for each shell. */
  terminalChecked(
    shell: string,
    integrated: boolean,
    detail: { variant?: 'windows_powershell' | 'pwsh' | 'other'; settingOff?: boolean } = {},
  ): void {
    const key = `${shell}:${detail.variant ?? ''}:${integrated}`;
    if (this.terminalsChecked.has(key)) return;
    this.terminalsChecked.add(key);
    this.record('terminal_checked', {
      shell,
      integrated,
      ...(shell === 'powershell' && detail.variant ? { variant: detail.variant } : {}),
      ...(detail.settingOff === undefined ? {} : { setting_off: detail.settingOff }),
    });
  }

  /** How long the host took to answer one of the panel's heavier requests: the first few of each, then a sample. */
  timed(op: (typeof TIMED_REQUESTS)[number], ms: number, events?: number): void {
    const count = (this.timedRequests.get(op) ?? 0) + 1;
    this.timedRequests.set(op, count);
    if (count <= SAMPLE_AFTER || count % SAMPLE_EVERY === 0)
      this.record('perf', { op, ms, ...(events !== undefined ? { events } : {}) });
  }

  /** An error was handed to an agent; whether an agent then reads the shared logs is told once. */
  investigated(agent: string, from: string, ci: boolean): void {
    this.touch();
    this.investigations++;
    this.investigatedAt = this.now();
    this.record('investigate', { agent, from, ci });
    this.milestone('first_investigate');
  }

  /** A new search in the panel: what it used and how much it found, never what it said. */
  search(operators: Iterable<SearchOperator>, fields: Iterable<string>, ms?: number, matched?: number): void {
    this.touch();
    this.searches++;
    if (matched === 0) this.emptySearches++;
    this.milestone('first_search');
    let filtered = false;
    for (const operator of operators) {
      this.operators.set(operator, (this.operators.get(operator) ?? 0) + 1);
      filtered = true;
    }
    for (const field of fields) this.fields.add(field);
    if (filtered) this.milestone('first_filtered_search');
    if (ms !== undefined && (this.timedSearches++ < SAMPLE_AFTER || this.timedSearches % SAMPLE_EVERY === 0))
      this.record('perf', { op: 'search', ms, ...(matched !== undefined ? { events: matched } : {}) });
  }

  shared(how: 'all' | 'runs' | 'event', sources: number, events: number, agentsReady: string[] = []): void {
    this.touch();
    if (this.sharedAt !== undefined && this.sharedCalls === 0) this.unusedShares++;
    this.shares++;
    this.sharedAt = this.now();
    this.sharedCalls = 0;
    this.record('shared_with_agent', { how, sources, events, agents_ready: agentsReady });
    this.milestone('first_share');
  }

  /** A window shared from its start, as the one-step setup asked: not something its user did just now. */
  autoShared(sources: number, events: number, agentsReady: string[] = []): void {
    this.sharedAt = this.now();
    this.sharedCalls = 0;
    this.record('shared_with_agent', { how: 'auto', sources, events, agents_ready: agentsReady });
  }

  sharingStopped(by: 'user' | 'closed' = 'user'): void {
    if (this.sharedAt === undefined) return;
    this.record('sharing_stopped', { duration: this.now() - this.sharedAt, by });
    if (this.sharedCalls === 0) this.unusedShares++;
    this.sharedAt = undefined;
  }

  agentConnected(client: string): void {
    this.clients.add(client);
    this.record('agent_connected', { client });
  }

  agentTool(properties: {
    tool: string;
    via: 'copilot' | 'mcp';
    client: string;
    ok: boolean;
    code?: string;
    ms: number;
    resultSize: number;
    truncated: boolean;
    redactions: number;
  }): void {
    this.touch();
    this.toolCalls++;
    this.features.add(properties.tool);
    this.clients.add(properties.client);
    if (this.sharedAt !== undefined && this.sharedCalls++ === 0)
      this.record('first_tool_after_share', { after: this.now() - this.sharedAt });
    if (this.investigatedAt !== undefined) {
      this.investigationsRead++;
      this.record('investigate_read', { after: this.now() - this.investigatedAt });
      this.investigatedAt = undefined;
    }
    const { resultSize, ...rest } = properties;
    this.record('agent_tool', { ...rest, result_size: resultSize });
    this.milestone('first_agent_call');
  }

  /**
   * Answers to a PostHog survey, which the person wrote and chose to send. The only
   * text Logline ever sends, under a one-time id rather than the install's; returns
   * false when usage counts are off or the answers could not be delivered, so the
   * caller offers another way.
   */
  async survey(surveyId: string, responses: Record<string, string | string[]>): Promise<boolean> {
    if (this.disposed || !this.enabled || !surveyId) return false;
    const properties: UsageProperties = {
      $survey_id: surveyId,
      $survey_submission_id: randomUUID(),
      $survey_completed: true,
    };
    for (const [question, answer] of Object.entries(responses))
      properties[`$survey_response_${question}`] = Array.isArray(answer)
        ? answer.map((item) => item.slice(0, 200))
        : answer.slice(0, SURVEY_TEXT_LIMIT);
    const timestamp = this.minute();
    // A one-time id of its own: what someone wrote is never tied to their usage counts.
    this.queue.push({ event: 'survey sent', properties, timestamp, distinctId: randomUUID() });
    return this.flush();
  }

  /** What Log Doctor found, each kind once a session. */
  findings(codes: Iterable<string>): void {
    for (const code of codes) {
      if (this.findingCodes.has(code) || !(DOCTOR_CODES as readonly string[]).includes(code)) continue;
      this.findingCodes.add(code);
      this.record('doctor_finding', { code });
    }
  }

  /** A thumbs up or down on a Log Doctor finding in the panel. */
  findingHelpful(code: string, helpful: boolean): void {
    this.touch();
    this.record('feedback', { surface: 'doctor', code, helpful });
  }

  /**
   * A while after Ask Copilot opened an investigation, ask whether it helped:
   * at most once a week, three times in all, and only while usage counts are on.
   */
  askWhetherCopilotHelped(): void {
    const state = this.state;
    const now = this.now();
    if (!this.enabled || this.helpfulTimer || (state.helpfulTimes ?? 0) >= HELPFUL_TIMES) return;
    if (state.helpfulAsked !== undefined && now - state.helpfulAsked < HELPFUL_EVERY_MS) return;
    this.saveState({ helpfulAsked: now, helpfulTimes: (state.helpfulTimes ?? 0) + 1 });
    this.helpfulTimer = setTimeout(() => void this.askHelpful(), HELPFUL_DELAY_MS);
    this.helpfulTimer.unref?.();
  }

  /** Ask now; returns once answered or dismissed. */
  async askHelpful(): Promise<void> {
    if (this.disposed || !this.enabled) return;
    const answer = await vscode.window.showInformationMessage(
      "Logline: Did Copilot's investigation of your logs help?",
      'Yes',
      'No',
    );
    if (answer) this.record('feedback', { surface: 'copilot', helpful: answer === 'Yes' });
  }

  /** How fast logs came in since the last sample, for the busiest minute of the session. */
  sampleRate(): void {
    const total = this.summarySource?.eventsCaptured();
    if (total === undefined) return;
    const now = this.now();
    if (this.lastSample && total >= this.lastSample.total && now > this.lastSample.at)
      this.peakEventsPerSecond = Math.max(
        this.peakEventsPerSecond,
        ((total - this.lastSample.total) * 1000) / (now - this.lastSample.at),
      );
    this.lastSample = { total, at: now };
  }

  private sendSummary(): void {
    const source = this.summarySource;
    const connections = source?.connections() ?? {};
    const quality = source?.quality?.();
    const agentSessions = source?.agentSessions?.();
    const terminal = source?.terminal?.();
    this.record('session_summary', {
      active_minutes: this.activeMinutes.size * 60_000,
      session_length: this.now() - this.startedAt,
      searches: this.searches,
      empty_searches: this.emptySearches,
      events_inspected: this.inspected,
      actions_used: [...this.actions],
      events_captured: source?.eventsCaptured() ?? 0,
      events_discarded: source?.discarded?.() ?? 0,
      events_truncated: source?.truncated?.() ?? 0,
      ...(quality
        ? { pct_json: quality.json, pct_unclassified: quality.unclassified, pct_multiline: quality.multiline }
        : {}),
      sources: source?.sources() ?? 0,
      memory_mb: source?.memoryMb() ?? 0,
      trimmed: source?.trimmed() ?? false,
      peak_events_per_sec: this.peakEventsPerSecond,
      views_used: [...this.views],
      features_used: [...this.features],
      fields: [...this.fields],
      ...Object.fromEntries([...this.operators].map(([operator, count]) => [`op_${operator}`, count])),
      ...Object.fromEntries(Object.entries(connections).map(([type, count]) => [`conn_${type}`, count])),
      shares: this.shares,
      tool_calls: this.toolCalls,
      unused_shares: this.unusedShares + (this.sharedAt !== undefined && this.sharedCalls === 0 ? 1 : 0),
      clients_used: [...this.clients],
      ...(source?.captureDefault ? { capture_default: source.captureDefault() } : {}),
      ...(source?.runtimeErrors ? { runtime_errors: source.runtimeErrors() } : {}),
      test_runs: this.testRuns,
      tests_failed: this.testsFailed,
      exception_snapshots: this.snapshots,
      ...(agentSessions ? { agent_sessions: agentSessions.sessions, agents_followed: agentSessions.agents } : {}),
      debuggers: [...this.debuggers],
      ...(terminal
        ? {
            commands_captured: terminal.captured,
            commands_uncaptured: terminal.uncaptured,
            commands_unreadable: terminal.unreadable,
            terminals_unintegrated: terminal.unintegrated,
          }
        : {}),
      ...(source?.inlineValues ? { inline_values: source.inlineValues() } : {}),
      investigations: this.investigations,
      investigations_read: this.investigationsRead,
    });
  }

  /** Send what is queued, unless usage counts were turned off; returns whether it was delivered. */
  async flush(): Promise<boolean> {
    if (!this.queue.length) return true;
    if (!this.enabled) {
      this.queue = [];
      return false;
    }
    const batch = this.queue;
    this.queue = [];
    // Show Usage Data lists an event once it is sent, or would have been from a build that sends.
    const listSent = () => {
      for (const item of batch)
        this.remember(`${item.timestamp.slice(11, 19)}  ${item.event.padEnd(22)} ${describe(item.properties)}`);
    };
    if (!this.production || !this.projectKey || this.debug) {
      listSent();
      return true;
    }
    // The id the events were recorded under, though Reset Usage ID may replace it while they are sent.
    const id = this.id;
    const body = JSON.stringify({
      api_key: this.projectKey,
      batch: batch.map((item) => ({
        event: item.event,
        distinct_id: item.distinctId ?? id,
        timestamp: item.timestamp,
        properties: { ...this.common, ...item.properties, $process_person_profile: false, $geoip_disable: true },
      })),
    });
    const sent = await this.transport(body).catch(() => false);
    if (sent) listSent();
    else this.requeue(batch, id);
    return sent;
  }

  /**
   * Put a batch that was not accepted back in front of what was queued since,
   * for one more try. Answers a person sent are not: the form already said they
   * were not sent. Nor is a batch recorded under an id that was reset since:
   * the reset dropped what was queued, so it cannot be tied to the new id.
   */
  private requeue(batch: QueuedEvent[], id: string): void {
    if (this.disposed || !this.enabled || id !== this.id) return;
    const again = batch
      .filter((item) => !item.distinctId && (item.failures ?? 0) + 1 < SEND_ATTEMPTS)
      .map((item) => ({ ...item, failures: (item.failures ?? 0) + 1 }));
    this.queue = [...again, ...this.queue].slice(-QUEUE_LIMIT);
  }

  private remember(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.channel?.appendLine(line);
  }

  /** The Logline Usage output channel: every event sent this session, and the anonymous id. */
  showData(): void {
    this.channel ??= vscode.window.createOutputChannel('Logline Usage');
    this.channel.clear();
    const level = this.enabled ? 'on' : 'off';
    this.channel.appendLine(
      `Usage ID ${this.id || '(none)'} · usage counts ${level} · ${this.projectKey && this.production ? USAGE_HOST : 'not sent from this build'}`,
    );
    this.channel.appendLine('Common properties: ' + describe(this.common));
    for (const line of this.log) this.channel.appendLine(line);
    this.channel.show(true);
  }

  /** A new anonymous id: what was sent under the old one can no longer be tied to what follows. */
  async resetId(): Promise<void> {
    this.queue = [];
    this.id = randomUUID();
    await this.save(ID_KEY, this.id);
    // The old id must not come back from the file if stored state is ever cleared.
    const file = this.idFile;
    if (file)
      try {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, this.id);
      } catch {
        /* the stored id still holds */
      }
    void vscode.window.showInformationMessage('Logline: Your anonymous usage ID was reset.');
  }

  /**
   * Keep what an uninstall reports in the extension's own folder: the anonymous id, how long ago Logline was
   * installed, which firsts it reached, and the common properties. Removed while usage counts are off or in a
   * development host, so the uninstall script sends nothing then.
   */
  private writeWill(): void {
    const file = this.options.willFile;
    if (!file) return;
    try {
      if (!this.production || this.debug || !this.enabled || !this.id) {
        rmSync(file, { force: true });
        return;
      }
      const state = this.state;
      writeFileSync(
        file,
        JSON.stringify({
          id: this.id,
          projectKey: this.projectKey,
          installedAt: state.installedAt,
          milestones: state.milestones ?? [],
          common: this.common,
        }),
      );
    } catch {
      /* a read-only extension folder: an uninstall is not reported */
    }
  }

  /** Send the session summary and what is queued; deactivation waits for it. */
  close(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.closing) {
      // A window closed before activation reported its time is still counted.
      this.activated();
      this.sharingStopped('closed');
      this.sendSummary();
      // Disposed once the last batch is out, so Show Usage Data still lists it.
      this.closing = this.flush().then(
        () => this.dispose(),
        () => this.dispose(),
      );
    }
    return this.closing;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.flushTimer);
    clearTimeout(this.activationTimer);
    clearTimeout(this.helpfulTimer);
    clearInterval(this.summaryTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.logger?.dispose?.();
    this.channel?.dispose();
  }
}

function describe(properties: UsageProperties): string {
  return Object.entries(properties)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join(' ');
}

/** The editor and machine, as `commonProperties` buckets them. */
export function usageEnvironment(version: string): UsageEnvironment {
  return {
    version,
    vscode: vscode.version ?? '',
    appName: vscode.env?.appName,
    uiKind: vscode.env?.uiKind === vscode.UIKind?.Web ? 'web' : 'desktop',
    remoteName: vscode.env?.remoteName,
    platform: process.platform,
    arch: process.arch,
    cpus: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    totalMemory: os.totalmem(),
    internal: /^(1|true)$/i.test(process.env.LOGLINE_USAGE_INTERNAL ?? ''),
  };
}

/** The commands, guide sections, and settings that usage events may name, read from the extension's manifest. */
export function usageVocabulary(packageJSON: unknown, guideSections: readonly string[]): UsageVocabulary {
  const manifest = (packageJSON ?? {}) as {
    contributes?: {
      commands?: { command?: string }[];
      configuration?: { properties?: Record<string, { type?: string | string[]; enum?: unknown[] }> }[];
    };
  };
  const commands = new Set(
    (manifest.contributes?.commands ?? [])
      .map((item) => item.command)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('logline.')),
  );
  const settings = new Map<string, 'boolean' | 'number' | 'custom' | readonly string[]>();
  for (const section of manifest.contributes?.configuration ?? [])
    for (const [key, schema] of Object.entries(section.properties ?? {})) {
      if (!key.startsWith('logline.')) continue;
      const name = key.slice('logline.'.length);
      if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === 'string'))
        settings.set(name, schema.enum as string[]);
      else if (schema.type === 'boolean') settings.set(name, 'boolean');
      else if (schema.type === 'number' || schema.type === 'integer') settings.set(name, 'number');
      else settings.set(name, 'custom');
    }
  return { commands, guideSections: new Set(guideSections), settings };
}

/** A command handler that counts its use: the id only, never its arguments. */
export function counted<A extends unknown[], R>(
  usage: Usage | undefined,
  id: string,
  handler: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    usage?.command(id);
    const failed = () => usage?.record('error', { area: 'command', code: 'command_failed', command: id });
    try {
      const result = handler(...args);
      // A command that fails later rejects its promise; it is counted, and still fails as before.
      if (result instanceof Promise)
        return result.catch((error: unknown) => {
          failed();
          throw error;
        }) as R;
      return result;
    } catch (error) {
      failed();
      throw error;
    }
  };
}
