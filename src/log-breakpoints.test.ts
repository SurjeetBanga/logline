import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRule, LogBreakpointRules } from './core/log-breakpoints';
import { parseLogLine } from './core/log-event';
import { LogSiteIndex, extractLogSites } from './core/log-sites';
import { LogStore } from './core/log-store';
import { withVscode } from './test/vscode-mock';

const event = (id: number, line: string) => parseLogLine(line, 'stdout', id, new Date(0));

test('log breakpoint rules match by search and level, and pause at most once per interval', () => {
  const rules = new LogBreakpointRules();
  const rule = rules.add('"payment failed"', ['ERROR']);
  assert.deepEqual(rules.add('"payment failed"', ['error']), rule, 'the same filter is not added twice');
  assert.equal(describeRule(rule), '"payment failed" · level error');
  assert.equal(rules.check(event(1, '{"level":"info","msg":"payment failed"}'), 0), undefined);
  assert.equal(rules.check(event(2, '{"level":"error","msg":"payment failed for order 7"}'), 0)?.id, rule.id);
  // Output that arrives while the pause is under way does not ask again.
  assert.equal(rules.check(event(3, '{"level":"error","msg":"payment failed for order 8"}'), 500), undefined);
  assert.equal(rules.check(event(4, '{"level":"error","msg":"payment failed for order 9"}'), 2000)?.id, rule.id);
  assert.deepEqual(rules.list().map(item => [item.hits, item.pauses]), [[3, 2]]);
  assert.throws(() => rules.add('message:/(/'), /regular expression|Invalid/i);
  assert.throws(() => rules.add('  '), /Enter a search/);
  assert.equal(rules.remove(rule.id), true);
  assert.equal(rules.size, 0);
});

class Uri {
  constructor(readonly path: string) { }
  get fsPath() { return this.path; }
  toString() { return `file://${this.path}`; }
  static file(path: string) { return new Uri(path); }
}
class Position { constructor(readonly line: number, readonly character: number) { } }
class Range { constructor(readonly start: Position, readonly end: Position) { } }
class Location { readonly range: Range; constructor(readonly uri: Uri, position: Position) { this.range = new Range(position, position); } }
class SourceBreakpoint { constructor(readonly location: Location) { } }

test('breakpoints go on the statement that logged an event, and matching debug output pauses the session', async () => {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const breakpoints: SourceBreakpoint[] = [];
  const messages: string[] = [];
  let status = { text: '', shown: false };
  const mock = {
    Uri, Position, Range, Location, SourceBreakpoint, StatusBarAlignment: { Left: 1 },
    commands: { registerCommand(name: string, callback: (...args: unknown[]) => unknown) { commands.set(name, callback); return { dispose() { } }; } },
    debug: {
      get breakpoints() { return breakpoints; },
      addBreakpoints(added: SourceBreakpoint[]) { breakpoints.push(...added); },
      onDidChangeBreakpoints: () => ({ dispose() { } })
    },
    window: {
      createStatusBarItem: () => {
        status = { text: '', shown: false };
        return { set text(value: string) { status.text = value; }, tooltip: '', name: '', command: '', show() { status.shown = true; }, hide() { status.shown = false; }, dispose() { } };
      },
      showInformationMessage: async (message: string) => { messages.push(message); return undefined; },
      showWarningMessage: async (message: string) => { messages.push(message); return undefined; },
      showTextDocument: async () => undefined
    },
    workspace: {
      asRelativePath: (uri: Uri) => uri.path.replace(/^\/w\//, ''),
      openTextDocument: async (uri: Uri) => ({ uri, lineCount: 20 })
    }
  };
  const { LogBreakpoints } = withVscode(mock, () => require('./vscode/log-breakpoints') as typeof import('./vscode/log-breakpoints'));
  const store = new LogStore();
  const index = new LogSiteIndex();
  index.setFile('src/pay.ts', extractLogSites('src/pay.ts', 'function pay(id) {\n  log.error(`payment failed for order ${id}`);\n}\n'));
  const lens = { enabled: true, siteUri: () => Uri.file('/w/src/pay.ts') };
  const shown: number[] = [];
  const controller = new LogBreakpoints({ store, index, lens: () => lens as never, showEvent: async id => { shown.push(id); } });

  store.add(event(1, '{"level":"error","msg":"payment failed for order 7"}'));
  await controller.breakOnEvent(1);
  assert.equal(breakpoints.length, 1);
  assert.equal(breakpoints[0].location.uri.path, '/w/src/pay.ts');
  assert.equal(breakpoints[0].location.range.start.line, 1);
  assert.match(messages.at(-1)!, /added a breakpoint at src\/pay\.ts:2/);
  await controller.breakOnEvent(1);
  assert.equal(breakpoints.length, 1, 'an existing breakpoint is not duplicated');

  // A search breaks on the statements that logged matches and watches debug output.
  await commands.get('logline.breakOnMatchingLogs')!('timeout', []);
  assert.equal(status.shown, true);
  assert.match(status.text, /Break on log/);
  let pauses = 0;
  const session = { id: 'd', name: 'Launch API', type: 'node', pause: async () => { pauses++; return true; } };
  // Output from a statement that already has a breakpoint does not stop twice.
  controller.onDebugEvent(event(2, '{"level":"error","msg":"payment failed for order 8 timeout"}'), session);
  assert.equal(pauses, 0);
  controller.onDebugEvent(event(3, '{"level":"warn","msg":"upstream timeout after 3s"}'), session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pauses, 1);
  assert.match(messages.at(-1)!, /paused Launch API after it logged “upstream timeout after 3s”/);
  controller.dispose();
});
