import * as vscode from 'vscode';
import { SENSITIVE_LABELS, uncaughtExceptionVariable } from '../core/log-findings';
import type { LogSite, LogSiteIndex, LogSiteTracker, SiteStats } from '../core/log-sites';
import type { Settings } from '../core/settings';
import type { LogLens } from './log-lens';

export type DoctorMode = 'off' | 'security' | 'all';
export type FindingCode = 'secret' | 'personal' | 'noisy' | 'missing-exception' | 'unstructured';

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
  askCopilot(prompt: string): Promise<void>;
}

// A statement is noisy when it alone is this share of enough retained events.
const NOISY_SHARE = 0.3;
const NOISY_MIN_EVENTS = 500;
const QUIET_LEVELS = new Set(['warn', 'error', 'fatal']);
const IGNORE = /logline-ignore(?::\s*([\w,\s-]+))?/;
const LOWER: Record<string, string> = {
  log: 'debug', info: 'debug', information: 'debug', notice: 'debug', Info: 'Debug', Infof: 'Debugf', Infow: 'Debugw', Infoln: 'Debugln',
  LogInformation: 'LogDebug', Information: 'Debug'
};

export function doctorMode(config: Settings): DoctorMode {
  const value = config.get<string>('logDoctor', 'all');
  return value === 'off' || value === 'security' ? value : 'all';
}

/**
 * Findings for one statement from its counters. Missing exceptions also need
 * the source text, to see whether the call sits in a catch block.
 */
export function siteFindings(site: LogSite, stats: SiteStats, total: number, mode: DoctorMode, sourceText?: string): Finding[] {
  if (mode === 'off' || !stats.hits) return [];
  const findings: Finding[] = [];
  const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  for (const { value, count } of stats.sensitive?.values() ?? []) {
    const where = value.path === 'message' ? 'in its message' : `in field ${value.path}`;
    findings.push({
      code: value.category, site, severity: 'warning', detail: value.kind,
      message: `Logged ${SENSITIVE_LABELS[value.kind]} ${where} in ${plural(count, 'event')} (${value.preview}). Logs are kept and shared more widely than the values in them.`
    });
  }
  if (mode === 'all') {
    if (stats.bareErrors && sourceText !== undefined) {
      const caught = uncaughtExceptionVariable(sourceText, site.line, site.file.slice(site.file.lastIndexOf('.') + 1).toLowerCase());
      if (caught) findings.push({
        code: 'missing-exception', site, severity: 'warning', detail: caught,
        message: `Logged ${plural(stats.bareErrors, 'error')} without the caught exception '${caught}', so no stack trace was recorded.`
      });
    }
    const share = total ? stats.hits / total : 0;
    const level = site.level ?? stats.samples.at(-1)?.level ?? '';
    if (total >= NOISY_MIN_EVENTS && share >= NOISY_SHARE && !QUIET_LEVELS.has(level)) findings.push({
      code: 'noisy', site, severity: 'information',
      message: `Logged ${Math.floor(share * 100)}% of all retained events (${stats.hits.toLocaleString()} of ${total.toLocaleString()}). Lower its level or sample it so other logs stay visible.`
    });
    const placeholders = site.template.split('…').length - 1;
    if (placeholders >= 2 && stats.hits >= 3 && stats.plain === stats.hits) findings.push({
      code: 'unstructured', site, severity: 'hint',
      message: `Formats ${placeholders} values into the message text. Log them as fields to make them searchable and chartable.`
    });
  }
  return findings;
}

/** Whether a source line or the line above it suppresses a finding with `logline-ignore`. */
export function isIgnored(lines: readonly string[], line: number, code: FindingCode): boolean {
  for (const text of [lines[line - 1], lines[line - 2]]) {
    const match = text === undefined ? null : IGNORE.exec(text);
    if (match && (!match[1] || match[1].split(/[\s,]+/).includes(code))) return true;
  }
  return false;
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
  private timer?: ReturnType<typeof setTimeout>;
  private run = 0;

  constructor(private readonly sources: DoctorSources) {
    this.disposables.push(this.diagnostics,
      sources.lens.onDidChangeCodeLenses(() => this.schedule()),
      vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, { providedCodeActionKinds: LogDoctor.kinds as vscode.CodeActionKind[] }),
      vscode.commands.registerCommand('logline.showLogHealth', () => this.showHealth()),
      vscode.commands.registerCommand('logline.fixLogStatementWithCopilot', (uri: vscode.Uri, line: number, message: string) =>
        sources.askCopilot(`Fix the log statement at ${vscode.workspace.asRelativePath(uri)}:${line}. Logline reported: ${message} Change only what is needed, keep the log useful, and follow the logging style of the file.`)),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('logline.logDoctor')) this.apply(); })
    );
    this.apply();
  }

  /** Findings from the latest refresh, worst first. */
  get findings(): readonly Finding[] { return this.current; }

  schedule(): void {
    if (this.timer || doctorMode(this.sources.config) === 'off') return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 500);
    this.timer.unref?.();
  }

  async refresh(): Promise<void> {
    const run = ++this.run;
    const mode = doctorMode(this.sources.config);
    const { tracker, index, lens } = this.sources;
    const findings: Finding[] = [];
    const byFile = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    const texts = new Map<string, string[] | undefined>();
    for (const [id, stats] of tracker.stats) {
      const site = index.find(id);
      const uri = site && lens.siteUri(site);
      if (!site || !uri) continue;
      let lines = texts.get(site.file);
      if (!texts.has(site.file)) { lines = (await this.read(uri))?.split('\n'); texts.set(site.file, lines); }
      if (run !== this.run) return;
      for (const finding of siteFindings(site, stats, tracker.total, mode, lines?.join('\n'))) {
        if (lines && isIgnored(lines, site.line, finding.code)) continue;
        findings.push(finding);
        const entry = byFile.get(site.file) ?? { uri, diagnostics: [] };
        const length = lines?.[site.line - 1]?.length ?? 0;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(site.line - 1, Math.max(0, site.column - 1), site.line - 1, Math.max(site.column, length)),
          finding.message, finding.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
            : finding.severity === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint);
        diagnostic.source = 'Logline';
        diagnostic.code = finding.code;
        this.findingsByDiagnostic.set(diagnostic, finding);
        entry.diagnostics.push(diagnostic);
        byFile.set(site.file, entry);
      }
    }
    this.diagnostics.clear();
    for (const { uri, diagnostics } of byFile.values()) this.diagnostics.set(uri, diagnostics);
    const rank = { warning: 0, information: 1, hint: 2 };
    this.current = findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line);
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      const finding = this.findingsByDiagnostic.get(diagnostic);
      if (!finding) continue;
      const line = document.lineAt(finding.site.line - 1);
      const fix = (title: string, edit: (workspaceEdit: vscode.WorkspaceEdit) => void, preferred = false) => {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = preferred;
        action.edit = new vscode.WorkspaceEdit();
        edit(action.edit);
        actions.push(action);
      };
      if (finding.code === 'noisy') {
        const method = /\.(log|info|information|notice|Info|Infof|Infow|Infoln|LogInformation|Information)\s*\(/.exec(line.text);
        if (method && LOWER[method[1]]) {
          const start = line.text.indexOf(method[1], method.index);
          fix(`Lower to ${LOWER[method[1]]}`, edit => edit.replace(document.uri, new vscode.Range(line.lineNumber, start, line.lineNumber, start + method[1].length), LOWER[method[1]]), true);
        }
      }
      if (finding.code === 'missing-exception' && finding.detail) {
        const python = /\.py$/.test(document.uri.path);
        const error = /\.error\s*\(/.exec(line.text);
        if (python && error) {
          const start = error.index + 1;
          fix('Log with the traceback (logger.exception)', edit => edit.replace(document.uri, new vscode.Range(line.lineNumber, start, line.lineNumber, start + 5), 'exception'), true);
        } else if (!/\.cs$/.test(document.uri.path)) {
          // C# loggers take the exception first; Copilot handles that shape.
          const close = closingParen(line.text, finding.site.column - 1);
          if (close !== undefined) fix(`Pass '${finding.detail}' to the log call`, edit => edit.insert(document.uri, new vscode.Position(line.lineNumber, close), `, ${finding.detail}`), true);
        }
      }
      if (finding.code === 'secret' || finding.code === 'personal' || finding.code === 'unstructured' || finding.code === 'missing-exception') {
        const action = new vscode.CodeAction('Fix with Copilot', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.command = { title: 'Fix with Copilot', command: 'logline.fixLogStatementWithCopilot', arguments: [document.uri, finding.site.line, finding.message] };
        actions.push(action);
      }
      const comment = /\.(py|rb)$/.test(document.uri.path) ? '#' : '//';
      const indent = /^\s*/.exec(line.text)![0];
      fix(`Ignore this ${finding.code} finding`, edit => edit.insert(document.uri, new vscode.Position(line.lineNumber, 0), `${indent}${comment} logline-ignore: ${finding.code}\n`));
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
    if (doctorMode(this.sources.config) === 'off') { this.sources.tracker.findings = false; this.diagnostics.clear(); this.current = []; return; }
    // A stale index version makes the lens recount retained events, now with evidence.
    if (!this.sources.tracker.findings) { this.sources.tracker.findings = true; this.sources.tracker.indexVersion = -1; this.sources.lens.schedule(0); }
    this.schedule();
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (open) return open.getText();
    try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
  }

  private async showHealth(): Promise<void> {
    if (doctorMode(this.sources.config) === 'off') {
      void vscode.window.showInformationMessage('Log doctor is off. Set logline.logDoctor to "security" or "all" to check log statements.');
      return;
    }
    await this.refresh();
    const findings = this.current;
    const count = (codes: FindingCode[]) => findings.filter(finding => codes.includes(finding.code)).length;
    const sites = this.sources.tracker.stats.size;
    const lines = [
      '# Log health', '',
      `Checked ${sites.toLocaleString()} log ${sites === 1 ? 'statement' : 'statements'} that produced ${this.sources.tracker.total.toLocaleString()} retained events.`, '',
      `- **${count(['secret'])}** logged secrets such as tokens or keys`,
      `- **${count(['personal'])}** logged personal data such as email addresses or card numbers`,
      `- **${count(['missing-exception'])}** logged errors without the caught exception`,
      `- **${count(['noisy'])}** produced most of the log volume`,
      `- **${count(['unstructured'])}** format values into text instead of fields`, ''
    ];
    if (!findings.length) lines.push('No problems found in the logs Logline has retained. Findings come only from events that statements actually logged.');
    else {
      lines.push('| Statement | Finding |', '| --- | --- |');
      for (const finding of findings) lines.push(`| \`${finding.site.file}:${finding.site.line}\` | ${finding.message.replace(/\|/g, '\\|')} |`);
    }
    lines.push('', 'Values are masked. Generated by Logline from captured runs.');
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

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
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = undefined; continue; }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index;
  }
  return undefined;
}
