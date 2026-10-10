import * as vscode from 'vscode';
import { SENSITIVE_LABELS, uncaughtExceptionVariable, type SourceSensitive } from '../core/log-findings';
import { siteQuery, type LogSite, type LogSiteIndex, type LogSiteTracker, type SiteStats } from '../core/log-sites';
import type { Settings } from '../core/settings';
import type { TelemetryCode, TelemetryFinding } from '../core/telemetry-findings';
import type { DoctorAction, DoctorFindingView } from '../protocol/messages';
import type { LogLens } from './log-lens';

export type DoctorMode = 'off' | 'security' | 'all';
export type FindingCode =
  | 'secret'
  | 'personal'
  | 'noisy'
  | 'missing-exception'
  | 'unstructured'
  | 'quiet-failure'
  | 'oversized'
  | 'contextless';

/** One problem with a log statement, backed by the events it logged. */
export interface Finding {
  code: FindingCode;
  site: LogSite;
  message: string;
  severity: 'warning' | 'information' | 'hint';
  /** Supporting detail for fixes: the caught variable, or the kind of value logged. */
  detail?: string;
}

export interface DoctorSources {
  config: Settings;
  index: LogSiteIndex;
  tracker: LogSiteTracker;
  lens: LogLens;
  /** Ask Copilot to change a statement, with the evidence in the prompt. */
  askCopilot(prompt: string): Promise<unknown>;
  /** Whether Copilot chat is available; without it, Fix with Copilot is not offered. */
  copilot?(): boolean;
  /** Filter the Logs panel, used to show a statement's events. */
  showQuery?(query: string): Promise<void>;
  /** Called when the findings shown in the Logs panel change. */
  onChanged?(): void;
  /** Sensitive values in events no statement claimed, scanned up to now. */
  unclaimed?(): { findings: SourceSensitive[]; version: number; more?: boolean };
  /** Semantic convention problems in the OpenTelemetry spans and metrics received. */
  telemetry?(): { findings: TelemetryFinding[]; version: number };
}

/** A sensitive value in a source's output that no indexed statement accounts for. */
export interface SourceFinding {
  code: 'secret' | 'personal';
  serverId: string;
  server: string;
  message: string;
  severity: 'warning';
  /** The latest event that carried it. */
  eventId: number;
}

// A statement is noisy when it alone is this share of enough retained events.
const NOISY_SHARE = 0.3;
const NOISY_MIN_EVENTS = 500;
const QUIET_LEVELS = new Set(['warn', 'error', 'fatal']);
const IGNORE = /logline-ignore(?::\s*([\w,\s-]+))?/;
const RAISE: Record<string, string> = {
  log: 'error',
  info: 'error',
  information: 'error',
  notice: 'error',
  debug: 'error',
  trace: 'error',
  Info: 'Error',
  Infof: 'Errorf',
  Infow: 'Errorw',
  Infoln: 'Errorln',
  Debug: 'Error',
  Debugf: 'Errorf',
  Debugw: 'Errorw',
  LogInformation: 'LogError',
  LogDebug: 'LogError',
  LogTrace: 'LogError',
  Information: 'Error',
};
// Oversized: what one event may average before it is worth a finding.
const LARGE_EVENT_CHARS = 8192;
const LOWER: Record<string, string> = {
  log: 'debug',
  info: 'debug',
  information: 'debug',
  notice: 'debug',
  Info: 'Debug',
  Infof: 'Debugf',
  Infow: 'Debugw',
  Infoln: 'Debugln',
  LogInformation: 'LogDebug',
  Information: 'Debug',
};

export function doctorMode(config: Settings): DoctorMode {
  const value = config.get<string>('logDoctor', 'all');
  return value === 'off' || value === 'security' ? value : 'all';
}

/**
 * Findings for one statement from its counters. Missing exceptions also need
 * the source text, to see whether the call sits in a catch block.
 */
export function siteFindings(
  site: LogSite,
  stats: SiteStats,
  total: number,
  mode: DoctorMode,
  sourceText?: string,
  context?: { structured: number; correlated: number },
): Finding[] {
  if (mode === 'off' || !stats.hits) return [];
  const findings: Finding[] = [];
  const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  for (const { value, count } of stats.sensitive?.values() ?? []) {
    const where = value.path === 'message' ? 'in its message' : `in field ${value.path}`;
    findings.push({
      code: value.category,
      site,
      severity: 'warning',
      detail: value.kind,
      message: `Logged ${SENSITIVE_LABELS[value.kind]} ${where} in ${plural(count, 'event')} (${value.preview}). Logs are kept and shared more widely than the values in them.`,
    });
  }
  if (mode === 'all') {
    if (stats.bareErrors && sourceText !== undefined) {
      const caught = uncaughtExceptionVariable(
        sourceText,
        site.line,
        site.file.slice(site.file.lastIndexOf('.') + 1).toLowerCase(),
      );
      if (caught)
        findings.push({
          code: 'missing-exception',
          site,
          severity: 'warning',
          detail: caught,
          message: `Logged ${plural(stats.bareErrors, 'error')} without the caught exception '${caught}', so no stack trace was recorded.`,
        });
    }
    const share = total ? stats.hits / total : 0;
    const level = site.level ?? stats.samples.at(-1)?.level ?? '';
    if (total >= NOISY_MIN_EVENTS && share >= NOISY_SHARE && !QUIET_LEVELS.has(level))
      findings.push({
        code: 'noisy',
        site,
        severity: 'information',
        message: `Logged ${Math.floor(share * 100)}% of all retained events (${stats.hits.toLocaleString()} of ${total.toLocaleString()}). Lower its level or sample it so other logs stay visible.`,
      });
    const quiet = stats.quietFailures ?? 0;
    if (quiet >= 3 && quiet * 2 >= stats.hits)
      findings.push({
        code: 'quiet-failure',
        site,
        severity: 'warning',
        message: `Logged ${plural(quiet, 'failure')} below warning level (${Math.round((quiet / stats.hits) * 100)}% of its events): a stack trace, a 5xx status, or a message like "failed". Error filters, alerts and error counts miss them; log them as errors.`,
      });
    const average = stats.chars ? stats.chars / stats.hits : 0;
    if (stats.hits >= 3 && (stats.truncated || average >= LARGE_EVENT_CHARS))
      findings.push({
        code: 'oversized',
        site,
        severity: 'information',
        message: `Logs ${(average / 1024).toFixed(average >= 10240 ? 0 : 1)} KB per event on average${stats.truncated ? `, and ${plural(stats.truncated, 'event')} reached the line limit and were cut` : ''}. Large events are slow to search and costly to keep; log the fields you need rather than whole objects.`,
      });
    const contextless = stats.contextless ?? 0;
    if (
      context &&
      context.structured >= 50 &&
      context.correlated * 2 >= context.structured &&
      contextless >= 3 &&
      contextless * 2 >= stats.hits
    )
      findings.push({
        code: 'contextless',
        site,
        severity: 'information',
        message: `Logged ${contextless.toLocaleString()} ${contextless === 1 ? 'warning or error' : 'warnings or errors'} without a trace or request id, though ${Math.round((context.correlated / context.structured) * 100)}% of structured logs carry one, so they cannot be tied to the request that failed. Log with the request's logger or context.`,
      });
    const placeholders = site.template.split('…').length - 1;
    if (placeholders >= 2 && stats.hits >= 3 && stats.plain === stats.hits)
      findings.push({
        code: 'unstructured',
        site,
        severity: 'hint',
        message: `Formats ${placeholders} values into the message text. Log them as fields to make them searchable and chartable.`,
      });
  }
  return findings;
}

/** Text for a Markdown table cell: log-derived text cannot end the cell or the row. */
export function tableCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s*[\r\n]+\s*/g, ' ');
}

/** Whether a source line or the line above it suppresses a finding with `logline-ignore`. */
export function isIgnored(lines: readonly string[], line: number, code: FindingCode): boolean {
  for (const text of [lines[line - 1], lines[line - 2]]) {
    const match = text === undefined ? null : IGNORE.exec(text);
    if (match && (!match[1] || match[1].split(/[\s,]+/).includes(code))) return true;
  }
  return false;
}

function view(finding: Finding): DoctorFindingView {
  return {
    siteId: finding.site.id,
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    file: finding.site.file,
    line: finding.site.line,
  };
}

function sourceView(finding: SourceFinding): DoctorFindingView {
  return {
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    source: finding.server,
    eventId: finding.eventId,
  };
}

function telemetryView(finding: TelemetryFinding): DoctorFindingView {
  return {
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    source: finding.service,
    ...(finding.traceId ? { traceId: finding.traceId } : {}),
  };
}

/** Findings for sensitive values that no statement accounts for, one per source and kind. */
export function sourceFindings(found: readonly SourceSensitive[]): SourceFinding[] {
  return found
    .map(({ serverId, server, value, count, lastId }) => ({
      code: value.category,
      serverId,
      server,
      severity: 'warning' as const,
      eventId: lastId,
      message: `${server} logged ${SENSITIVE_LABELS[value.kind]} ${value.path === 'message' ? 'in its message' : `in field ${value.path}`} in ${count.toLocaleString()} event${count === 1 ? '' : 's'} (${value.preview}), from code Logline has not matched to a log statement, such as a library, another repository, or imported logs.`,
    }))
    .sort((a, b) => a.server.localeCompare(b.server) || a.message.localeCompare(b.message));
}

/**
 * Log doctor: Problems-panel diagnostics on log statements, backed by what
 * they actually logged, with quick fixes and a workspace health report.
 */
export class LogDoctor implements vscode.Disposable, vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind?.QuickFix].filter(Boolean);
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('logline');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly findingsByDiagnostic = new WeakMap<vscode.Diagnostic, Finding>();
  private current: Finding[] = [];
  private unclaimedFindings: SourceFinding[] = [];
  private telemetryFindings: TelemetryFinding[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private run = 0;
  // What the last refresh was computed from; lenses also change on a clock
  // tick, which leaves findings as they were.
  private computedFrom?: string;
  // Source read from disk, kept until the index sees a file change.
  private readonly sourceCache = new Map<string, string | undefined>();
  private sourceVersion = -1;
  // Diagnostics as set per file, so unchanged files are not re-sent to the Problems panel.
  private readonly published = new Map<string, { uri: vscode.Uri; signature: string }>();
  // Findings per statement, worst first, for rows and expanded events in the Logs panel.
  private bySite = new Map<string, Finding[]>();
  private viewSignature = '';
  private viewCache?: DoctorFindingView[];
  /** Changes whenever the findings shown in the Logs panel change. */
  revision = 0;

  constructor(private readonly sources: DoctorSources) {
    this.disposables.push(
      this.diagnostics,
      sources.lens.onDidChangeCodeLenses(() => this.schedule()),
      vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, {
        providedCodeActionKinds: LogDoctor.kinds as vscode.CodeActionKind[],
      }),
      vscode.commands.registerCommand('logline.showLogHealth', () => this.showHealth()),
      vscode.commands.registerCommand(
        'logline.fixLogStatementWithCopilot',
        (uri: vscode.Uri, line: number, message: string) =>
          sources.askCopilot(
            `Fix the log statement at ${vscode.workspace.asRelativePath(uri)}:${line}. Logline reported: ${message} Change only what is needed, keep the log useful, and follow the logging style of the file.`,
          ),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('logline.logDoctor')) this.apply();
      }),
      // An edit can add or remove a logline-ignore comment without moving any statement.
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.published.has(event.document.uri.toString())) {
          this.computedFrom = undefined;
          this.schedule();
        }
      }),
    );
    this.apply();
  }

  /** Findings on statements from the latest refresh, worst first. */
  get findings(): readonly Finding[] {
    return this.current;
  }

  /** Findings in output that no statement accounts for. */
  get unclaimed(): readonly SourceFinding[] {
    return this.unclaimedFindings;
  }

  /** Semantic convention problems in OpenTelemetry data, per service. */
  get telemetry(): readonly TelemetryFinding[] {
    return this.telemetryFindings;
  }

  /** Every finding the Logs panel counts. */
  get total(): number {
    return this.current.length + this.unclaimedFindings.length + this.telemetryFindings.length;
  }

  schedule(): void {
    if (this.timer || doctorMode(this.sources.config) === 'off') return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 500);
    this.timer.unref?.();
  }

  async refresh(): Promise<void> {
    const run = ++this.run;
    const mode = doctorMode(this.sources.config);
    const { tracker, index, lens } = this.sources;
    const unclaimed = mode === 'off' ? undefined : this.sources.unclaimed?.();
    const telemetry = mode === 'all' ? this.sources.telemetry?.() : undefined;
    // The scan works through a large backlog in steps.
    if (unclaimed?.more) this.schedule();
    const computedFrom = `${mode}:${tracker.findings}:${index.version}:${tracker.watermark}:${tracker.total}:${tracker.stats.size}:${unclaimed?.version}:${telemetry?.version}`;
    if (computedFrom === this.computedFrom) return;
    if (index.version !== this.sourceVersion) {
      this.sourceCache.clear();
      this.sourceVersion = index.version;
    }
    const findings: Finding[] = [];
    const byFile = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    const texts = new Map<string, { text: string; lines: string[] } | undefined>();
    for (const [id, stats] of tracker.stats) {
      const site = index.find(id);
      const uri = site && lens.siteUri(site);
      if (!site || !uri) continue;
      if (!texts.has(site.file)) {
        const text = await this.read(uri);
        texts.set(site.file, text === undefined ? undefined : { text, lines: text.split('\n') });
      }
      if (run !== this.run) return;
      const source = texts.get(site.file);
      const lines = source?.lines;
      for (const finding of siteFindings(site, stats, tracker.total, mode, source?.text, tracker)) {
        if (lines && isIgnored(lines, site.line, finding.code)) continue;
        findings.push(finding);
        const entry = byFile.get(site.file) ?? { uri, diagnostics: [] };
        const length = lines?.[site.line - 1]?.length ?? 0;
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(site.line - 1, Math.max(0, site.column - 1), site.line - 1, Math.max(site.column, length)),
          finding.message,
          finding.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : finding.severity === 'information'
              ? vscode.DiagnosticSeverity.Information
              : vscode.DiagnosticSeverity.Hint,
        );
        diagnostic.source = 'Logline';
        diagnostic.code = finding.code;
        this.findingsByDiagnostic.set(diagnostic, finding);
        entry.diagnostics.push(diagnostic);
        byFile.set(site.file, entry);
      }
    }
    const current = new Set([...byFile.values()].map(({ uri }) => uri.toString()));
    for (const [key, { uri }] of this.published) {
      if (!current.has(key)) {
        this.diagnostics.delete(uri);
        this.published.delete(key);
      }
    }
    for (const { uri, diagnostics } of byFile.values()) {
      const signature = JSON.stringify(
        diagnostics.map(({ range, message, code, severity }) => [range, message, code, severity]),
      );
      if (this.published.get(uri.toString())?.signature === signature) continue;
      this.diagnostics.set(uri, diagnostics);
      this.published.set(uri.toString(), { uri, signature });
    }
    this.computedFrom = computedFrom;
    const rank = { warning: 0, information: 1, hint: 2 };
    this.current = findings.sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line,
    );
    this.unclaimedFindings = sourceFindings(unclaimed?.findings ?? []);
    this.telemetryFindings = telemetry?.findings ?? [];
    this.findingsChanged();
  }

  /** Findings on one statement, worst first. */
  findingsFor(siteId: string): readonly Finding[] {
    return this.bySite.get(siteId) ?? [];
  }

  /** Findings as the Logs panel shows them, worst first. */
  views(): DoctorFindingView[] {
    // Leaked values come first wherever they were found; the list is capped for the panel.
    return (this.viewCache ??= [
      ...this.unclaimedFindings.map(sourceView),
      ...this.current.map(view),
      ...this.telemetryFindings.map(telemetryView),
    ]
      .sort((a, b) => Number(a.severity !== 'warning') - Number(b.severity !== 'warning'))
      .slice(0, 200));
  }

  /** Act on a finding from the Logs panel. */
  async act(action: DoctorAction, siteId?: string): Promise<void> {
    if (action === 'report') {
      await this.showHealth();
      return;
    }
    const site = siteId === undefined ? undefined : this.sources.index.find(siteId);
    if (!site) {
      void vscode.window.showInformationMessage(
        'This log statement is no longer indexed. It may have been edited or removed.',
      );
      return;
    }
    if (action === 'showEvents') {
      await this.sources.showQuery?.(siteQuery(site));
      return;
    }
    await this.sources.lens.openSite(site);
    // The cursor lands on the statement, where the quick fixes for its diagnostics are offered.
    if (action === 'fix') await vscode.commands.executeCommand('editor.action.quickFix');
  }

  private findingsChanged(): void {
    const bySite = new Map<string, Finding[]>();
    for (const finding of this.current) {
      const list = bySite.get(finding.site.id);
      if (list) list.push(finding);
      else bySite.set(finding.site.id, [finding]);
    }
    this.bySite = bySite;
    const signature = JSON.stringify([
      this.current.map((finding) => [finding.site.id, finding.code, finding.message]),
      this.unclaimedFindings.map((finding) => [finding.serverId, finding.message, finding.eventId]),
      this.telemetryFindings.map((finding) => [finding.service, finding.message, finding.traceId]),
    ]);
    if (signature === this.viewSignature) return;
    this.viewSignature = signature;
    this.viewCache = undefined;
    this.revision++;
    this.sources.onChanged?.();
  }

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const finding = this.findingsByDiagnostic.get(diagnostic);
      // Diagnostics do not move with edits; skip a statement whose line no longer exists.
      if (!finding || finding.site.line < 1 || finding.site.line > document.lineCount) continue;
      const line = document.lineAt(finding.site.line - 1);
      const fix = (title: string, edit: (workspaceEdit: vscode.WorkspaceEdit) => void, preferred = false) => {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = preferred;
        action.edit = new vscode.WorkspaceEdit();
        edit(action.edit);
        actions.push(action);
      };
      if (finding.code === 'quiet-failure') {
        const method =
          /\.(log|info|information|notice|debug|trace|Info|Infof|Infow|Infoln|Debug|Debugf|Debugw|LogInformation|LogDebug|LogTrace|Information)\s*\(/.exec(
            line.text,
          );
        if (method && RAISE[method[1]]) {
          const start = line.text.indexOf(method[1], method.index);
          fix(
            `Raise to ${RAISE[method[1]]}`,
            (edit) =>
              edit.replace(
                document.uri,
                new vscode.Range(line.lineNumber, start, line.lineNumber, start + method[1].length),
                RAISE[method[1]],
              ),
            true,
          );
        }
      }
      if (finding.code === 'noisy') {
        const method = /\.(log|info|information|notice|Info|Infof|Infow|Infoln|LogInformation|Information)\s*\(/.exec(
          line.text,
        );
        if (method && LOWER[method[1]]) {
          const start = line.text.indexOf(method[1], method.index);
          fix(
            `Lower to ${LOWER[method[1]]}`,
            (edit) =>
              edit.replace(
                document.uri,
                new vscode.Range(line.lineNumber, start, line.lineNumber, start + method[1].length),
                LOWER[method[1]],
              ),
            true,
          );
        }
      }
      if (finding.code === 'missing-exception' && finding.detail) {
        const python = /\.py$/.test(document.uri.path);
        const error = /\.error\s*\(/.exec(line.text);
        if (python && error) {
          const start = error.index + 1;
          fix(
            'Log with the traceback (logger.exception)',
            (edit) =>
              edit.replace(
                document.uri,
                new vscode.Range(line.lineNumber, start, line.lineNumber, start + 5),
                'exception',
              ),
            true,
          );
        } else if (!/\.cs$/.test(document.uri.path)) {
          // C# loggers take the exception first; Copilot handles that shape.
          const close = closingParen(line.text, finding.site.column - 1);
          if (close !== undefined)
            fix(
              `Pass '${finding.detail}' to the log call`,
              (edit) => edit.insert(document.uri, new vscode.Position(line.lineNumber, close), `, ${finding.detail}`),
              true,
            );
        }
      }
      if (
        this.sources.copilot?.() !== false &&
        ['secret', 'personal', 'unstructured', 'missing-exception', 'oversized', 'contextless'].includes(finding.code)
      ) {
        const action = new vscode.CodeAction('Fix with Copilot', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.command = {
          title: 'Fix with Copilot',
          command: 'logline.fixLogStatementWithCopilot',
          arguments: [document.uri, finding.site.line, finding.message],
        };
        actions.push(action);
      }
      const comment = /\.(py|rb)$/.test(document.uri.path) ? '#' : '//';
      const indent = /^\s*/.exec(line.text)![0];
      fix(`Ignore this ${finding.code} finding`, (edit) =>
        edit.insert(
          document.uri,
          new vscode.Position(line.lineNumber, 0),
          `${indent}${comment} logline-ignore: ${finding.code}\n`,
        ),
      );
      const show = new vscode.CodeAction('Show the events in Logs', vscode.CodeActionKind.QuickFix);
      show.diagnostics = [diagnostic];
      show.command = { title: 'Show the events in Logs', command: 'logline.showLogSite', arguments: [finding.site.id] };
      actions.push(show);
    }
    return actions;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private apply(): void {
    if (doctorMode(this.sources.config) === 'off') {
      this.sources.tracker.findings = false;
      this.diagnostics.clear();
      this.published.clear();
      this.computedFrom = undefined;
      this.current = [];
      this.unclaimedFindings = [];
      this.telemetryFindings = [];
      this.findingsChanged();
      return;
    }
    // A stale index version makes the lens recount retained events, now with evidence.
    if (!this.sources.tracker.findings) {
      this.sources.tracker.findings = true;
      this.sources.tracker.indexVersion = -1;
      this.sources.lens.schedule(0);
    }
    this.schedule();
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (open) return open.getText();
    const key = uri.toString();
    if (this.sourceCache.has(key)) return this.sourceCache.get(key);
    let text: string | undefined;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      text = undefined;
    }
    this.sourceCache.set(key, text);
    return text;
  }

  private async showHealth(): Promise<void> {
    if (doctorMode(this.sources.config) === 'off') {
      void vscode.window.showInformationMessage(
        'Log doctor is off. Set logline.logDoctor to "security" or "all" to check log statements.',
      );
      return;
    }
    await this.refresh();
    const findings = this.current;
    const unclaimed = this.unclaimedFindings;
    const telemetry = this.telemetryFindings;
    const count = (codes: (FindingCode | TelemetryCode)[]) =>
      findings.filter((finding) => codes.includes(finding.code)).length +
      unclaimed.filter((finding) => codes.includes(finding.code)).length +
      telemetry.filter((finding) => codes.includes(finding.code)).length;
    const sites = this.sources.tracker.stats.size;
    const lines = [
      '# Log health',
      '',
      `Checked ${sites.toLocaleString()} log ${sites === 1 ? 'statement' : 'statements'} that produced ${this.sources.tracker.total.toLocaleString()} retained events, and every source's output for secrets and personal data.`,
      '',
      ...REPORT.filter((rule) => count([rule.code])).map((rule) => `- **${count([rule.code])}** ${rule.summary}`),
    ];
    if (!findings.length && !unclaimed.length && !telemetry.length)
      lines.push(
        'No problems found in the logs Logline has retained. Findings come only from events that were actually logged.',
      );
    if (unclaimed.length) {
      lines.push(
        '',
        '## In output not matched to a statement',
        '',
        'From libraries, other repositories, imported files, terminals or OpenTelemetry. Open an example from log doctor in the Logs panel.',
        '',
        '| Source | Finding |',
        '| --- | --- |',
      );
      for (const finding of unclaimed) lines.push(`| ${tableCell(finding.server)} | ${tableCell(finding.message)} |`);
    }
    if (telemetry.length) {
      lines.push(
        '',
        '## In OpenTelemetry data',
        '',
        'Checked against the OpenTelemetry semantic conventions, in the spans and metrics each service sent.',
        '',
        '| Service | Finding |',
        '| --- | --- |',
      );
      for (const finding of telemetry) lines.push(`| ${tableCell(finding.service)} | ${tableCell(finding.message)} |`);
    }
    if (findings.length) {
      lines.push('', '## On log statements', '', '| Statement | Finding |', '| --- | --- |');
      for (const finding of findings)
        lines.push(`| \`${finding.site.file}:${finding.site.line}\` | ${tableCell(finding.message)} |`);
    }
    const found = REPORT.filter((rule) => count([rule.code]));
    if (found.length) {
      lines.push('', '## What to do', '');
      for (const rule of found) lines.push(`**${rule.title}.** ${rule.advice}`, '');
    }
    lines.push(
      '',
      'Values are masked. Generated by Logline from captured runs. Suppress a finding on a statement with a `logline-ignore: <code>` comment.',
    );
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

/** Each check as the health report explains it, in the order it lists them. */
const REPORT: { code: FindingCode | TelemetryCode; title: string; summary: string; advice: string }[] = [
  {
    code: 'secret',
    title: 'Secrets',
    summary: 'logged secrets such as tokens or keys',
    advice:
      'Anyone who can read the logs can use these. Remove the value or log a masked form, and rotate any credential that reached shared logs.',
  },
  {
    code: 'personal',
    title: 'Personal data',
    summary: 'logged personal data such as email addresses or card numbers',
    advice:
      'Logs are kept longer and shared more widely than the data they copy. Log an internal id instead, or mask the value.',
  },
  {
    code: 'quiet-failure',
    title: 'Failures logged below warning',
    summary: 'logged failures at info or debug level',
    advice:
      'Error filters, alerts, and error counts in Analyze only see warnings and errors. Log failures at error, or at warn when they are expected and handled.',
  },
  {
    code: 'missing-exception',
    title: 'Errors without the exception',
    summary: 'logged errors without the caught exception',
    advice:
      'Without the exception there is no stack trace to show where it failed. Pass the caught exception to the log call.',
  },
  {
    code: 'contextless',
    title: 'Errors without a request or trace id',
    summary: 'logged errors that cannot be tied to a request',
    advice:
      'Most of your structured logs name their request or trace, so these errors stand out by not doing so. Log through the request-scoped logger or add the id to the context.',
  },
  {
    code: 'noisy',
    title: 'Noisy statements',
    summary: 'produced most of the log volume',
    advice:
      'One statement crowding out the rest hides everything else and costs the most to keep. Lower its level, sample it, or log a summary.',
  },
  {
    code: 'oversized',
    title: 'Oversized events',
    summary: 'logged very large events',
    advice:
      'Large events are slow to search, get cut at the line limit, and cost the most to ship and store. Log the fields you need rather than whole objects or payloads.',
  },
  {
    code: 'unstructured',
    title: 'Values formatted into messages',
    summary: 'format values into text instead of fields',
    advice:
      'Values inside the text cannot be filtered, grouped, or charted. Keep the message constant and pass the values as fields.',
  },
  {
    code: 'unnamed-service',
    title: 'Services without a name',
    summary: 'services sent telemetry without a service name',
    advice:
      'Every unnamed service shares one name, so their traces and metrics mix. Set OTEL_SERVICE_NAME; Logline sets it for servers and tasks it starts.',
  },
  {
    code: 'span-name-ids',
    title: 'Ids in span names',
    summary: 'services put ids in span names',
    advice:
      'A span name with an id in it is unique to one request, so the same operation never groups together in traces or hotspots. Name the operation and record the id as an attribute.',
  },
  {
    code: 'unmarked-error',
    title: 'Failed requests not marked as errors',
    summary: 'services returned 5xx without an error status',
    advice:
      'Traces count and highlight spans whose status is Error. Server spans that returned 5xx should set it; current HTTP instrumentation does this for you.',
  },
  {
    code: 'missing-route',
    title: 'HTTP spans without a route',
    summary: 'services recorded HTTP server spans without http.route',
    advice:
      'Without the route template, each URL counts as its own endpoint. Framework instrumentation sets http.route; with plain HTTP instrumentation, set it where the route is matched.',
  },
  {
    code: 'old-attributes',
    title: 'Older attribute names',
    summary: 'services used attribute names from before the stable conventions',
    advice:
      'Instrumentation released before the HTTP, database, and network conventions became stable uses older names. Update the OpenTelemetry instrumentation packages.',
  },
  {
    code: 'unit-in-name',
    title: 'Units in metric names',
    summary: 'services put units in metric names',
    advice:
      'OpenTelemetry metrics carry their unit separately, so tools can convert and label it. Drop the unit from the name and set it as the unit.',
  },
];

const ERROR_CALL = /\b(?:error|Error|exception|severe|fatal|critical|warn|warning|Warn|log)\s*\(/;

/** The column of the `)` that closes the logging call starting at `from`, when it ends on the same line. */
export function closingParen(text: string, from: number): number | undefined {
  // Skip calls in the receiver chain, such as `getLogger()` in `getLogger().error(`.
  const call = ERROR_CALL.exec(text.slice(from));
  if (!call) return undefined;
  let depth = 0;
  let quote: string | undefined;
  for (let index = from + call.index + call[0].length - 1; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index;
  }
  return undefined;
}
