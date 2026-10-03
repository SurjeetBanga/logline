import * as vscode from 'vscode';
import type { DebugSessionInfo } from '../capture/debug-capture';
import { describeRule, LogBreakpointRules } from '../core/log-breakpoints';
import type { LogSite, LogSiteIndex } from '../core/log-sites';
import { eventLocation } from '../core/log-sites';
import type { LogStore } from '../core/log-store';
import type { LogEvent } from '../core/types';
import type { LogLens } from './log-lens';
import { resolveSourceUri } from './source-navigation';

export interface LogBreakpointSources {
  store: Pick<LogStore, 'find' | 'reversePage'>;
  index: LogSiteIndex;
  lens(): LogLens | undefined;
  /** Show one event in the Logs panel. */
  showEvent(id: number): Promise<void>;
}

// Statements to stop at when breaking on a search; more is rarely a useful debugging session.
const MAX_SITE_BREAKPOINTS = 10;

/**
 * Debugger breakpoints driven by logs. "Break when this logs again" puts a
 * breakpoint on the statement that logged an event. "Break on matching
 * logs" does that for every statement that logged a matching event so far,
 * and pauses a debug session right after it logs any other matching event.
 */
export class LogBreakpoints implements vscode.Disposable {
  readonly rules = new LogBreakpointRules();
  // Statements Logline put a breakpoint on: a pause after their output would stop twice.
  private readonly siteBreakpoints = new Map<string, vscode.SourceBreakpoint>();
  private readonly status: vscode.StatusBarItem | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly sources: LogBreakpointSources) {
    this.status = vscode.window.createStatusBarItem?.('logline.logBreakpoints', vscode.StatusBarAlignment.Left, 50);
    if (this.status) {
      this.status.name = 'Logline log breakpoints';
      this.status.command = 'logline.manageLogBreakpoints';
    }
    this.disposables.push(
      vscode.commands.registerCommand('logline.breakOnMatchingLogs', async (query?: unknown, levels?: unknown) => this.breakOnMatchingLogs(
        typeof query === 'string' ? query : await vscode.window.showInputBox({
          title: 'Break on matching logs', prompt: 'Pause debug sessions when they log an event matching this search',
          placeHolder: 'level:error "payment failed"', ignoreFocusOut: true
        }), Array.isArray(levels) ? levels.filter((level): level is string => typeof level === 'string') : [])),
      vscode.commands.registerCommand('logline.manageLogBreakpoints', () => this.manage())
    );
    const debug = vscode.debug as Partial<typeof vscode.debug> | undefined;
    if (debug?.onDidChangeBreakpoints) this.disposables.push(debug.onDidChangeBreakpoints(change => {
      // Forget breakpoints the user removed, so their statements pause again.
      for (const removed of change.removed) for (const [key, breakpoint] of this.siteBreakpoints) if (breakpoint === removed) this.siteBreakpoints.delete(key);
    }));
    this.render();
  }

  /** Put a breakpoint on the statement that logged an event. */
  async breakOnEvent(id: number): Promise<void> {
    const event = this.sources.store.find(id);
    if (!event) { void vscode.window.showInformationMessage('This event has been discarded from retained history.'); return; }
    const target = await this.statementFor(event);
    if (!target) {
      void vscode.window.showInformationMessage('Logline could not find the log statement for this event in the workspace. Use Break on matching logs to pause right after it is logged instead.');
      return;
    }
    const added = this.addBreakpoint(target.uri, target.line, target.site);
    const where = `${vscode.workspace.asRelativePath(target.uri)}:${target.line}`;
    await this.reveal(target.uri, target.line);
    void vscode.window.showInformationMessage(added
      ? `Logline added a breakpoint at ${where}. The debugger stops there the next time this statement runs.`
      : `A breakpoint is already set at ${where}.`);
  }

  /** Break on every statement that logged a matching event, and pause after any other matching output. */
  async breakOnMatchingLogs(query: string | undefined, levels: readonly string[] = []): Promise<void> {
    if (query === undefined) return;
    let rule;
    try { rule = this.rules.add(query, levels); } catch (error) { void vscode.window.showWarningMessage(`Logline: ${(error as Error).message}`); return; }
    let added = 0;
    if (this.sources.lens()?.enabled) {
      const sites = new Map<string, LogSite>();
      for (const event of this.sources.store.reversePage({ query: rule.query, levels: rule.levels }, 2000).events) {
        const site = this.sources.index.match(event)?.site;
        if (site && !sites.has(site.id)) sites.set(site.id, site);
        if (sites.size >= MAX_SITE_BREAKPOINTS) break;
      }
      for (const site of sites.values()) {
        const uri = this.sources.lens()?.siteUri(site);
        if (uri && this.addBreakpoint(uri, site.line, site)) added++;
      }
    }
    this.render();
    const statements = added ? `Added breakpoints on ${added} log ${added === 1 ? 'statement' : 'statements'} that logged matching events. ` : '';
    void vscode.window.showInformationMessage(`${statements}Debug sessions pause right after they log another event matching ${describeRule(rule)}.`, 'Manage')
      .then(action => { if (action === 'Manage') void this.manage(); });
  }

  /** Check an event captured from a debug session against the rules. */
  onDebugEvent(event: LogEvent, session: DebugSessionInfo): void {
    if (!this.rules.size || !session.pause) return;
    const site = this.sources.index.match(event)?.site;
    if (site && this.siteBreakpoints.has(this.key(site.file, site.line))) return;
    const rule = this.rules.check(event);
    this.render();
    if (!rule) return;
    void session.pause().then(paused => {
      if (!paused) return;
      const message = (event.message ?? '').slice(0, 120);
      void vscode.window.showInformationMessage(`Logline paused ${session.name} after it logged “${message}” (matches ${describeRule(rule)}).`, 'Show event', 'Remove log breakpoint')
        .then(action => {
          if (action === 'Show event') void this.sources.showEvent(event.id);
          else if (action === 'Remove log breakpoint') { this.rules.remove(rule.id); this.render(); }
        });
    }, () => undefined);
  }

  dispose(): void {
    this.status?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async manage(): Promise<void> {
    const rules = this.rules.list();
    if (!rules.length) {
      void vscode.window.showInformationMessage('No log breakpoints are set. Use Break on matching logs in the Logs panel, or Break when this logs again on an event.');
      return;
    }
    type Item = vscode.QuickPickItem & { id?: number };
    const items: Item[] = rules.map(rule => ({
      label: `$(debug-breakpoint-log) ${describeRule(rule)}`, id: rule.id,
      description: `${rule.hits.toLocaleString()} ${rule.hits === 1 ? 'match' : 'matches'} · ${rule.pauses.toLocaleString()} ${rule.pauses === 1 ? 'pause' : 'pauses'}`
    }));
    items.push({ label: '$(close-all) Remove all log breakpoints' });
    const picked = await vscode.window.showQuickPick(items, { title: 'Log breakpoints', placeHolder: 'Select a log breakpoint to remove it' });
    if (!picked) return;
    if (picked.id === undefined) this.rules.clear(); else this.rules.remove(picked.id);
    this.render();
  }

  private render(): void {
    if (!this.status) return;
    const rules = this.rules.list();
    if (!rules.length) { this.status.hide(); return; }
    this.status.text = `$(debug-breakpoint-log) Break on log${rules.length > 1 ? ` (${rules.length})` : ''}`;
    this.status.tooltip = `Logline pauses debug sessions after they log a matching event:\n${rules.map(rule => `• ${describeRule(rule)} — ${rule.hits} matches`).join('\n')}\nClick to manage.`;
    this.status.show();
  }

  private async statementFor(event: LogEvent): Promise<{ uri: vscode.Uri; line: number; site?: LogSite } | undefined> {
    const lens = this.sources.lens();
    const site = lens?.enabled ? this.sources.index.match(event)?.site : undefined;
    const uri = site && lens?.siteUri(site);
    if (site && uri) return { uri, line: site.line, site };
    const location = eventLocation(event);
    if (!location) return undefined;
    try {
      const resolved = await resolveSourceUri(location, 'Choose log statement');
      return resolved && { uri: resolved, line: location.line };
    } catch { return undefined; }
  }

  private addBreakpoint(uri: vscode.Uri, line: number, site?: LogSite): boolean {
    const key = this.key(site?.file ?? uri.toString(), line);
    const position = new vscode.Position(Math.max(0, line - 1), 0);
    const existing = vscode.debug.breakpoints.some(breakpoint => breakpoint instanceof vscode.SourceBreakpoint
      && breakpoint.location.uri.toString() === uri.toString() && breakpoint.location.range.start.line === position.line);
    if (existing) return false;
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, position));
    vscode.debug.addBreakpoints([breakpoint]);
    this.siteBreakpoints.set(key, breakpoint);
    return true;
  }

  private async reveal(uri: vscode.Uri, line: number): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(Math.min(line - 1, document.lineCount - 1), 0);
      await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
    } catch { /* the breakpoint is set either way */ }
  }

  private key(file: string, line: number): string { return `${file}\0${line}`; }
}
