import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogLine } from '../core/log-event';
import { LogStore } from '../core/log-store';
import { withVscode } from '../test/vscode-mock';

class Uri {
  constructor(readonly path: string) {}
  get fsPath() {
    return this.path;
  }
  toString() {
    return `file://${this.path}`;
  }
  static file(path: string) {
    return new Uri(path);
  }
}
class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    this.start = typeof a === 'number' ? new Position(a, b as number) : a;
    this.end = typeof a === 'number' ? new Position(c!, d!) : (b as Position);
  }
}
class Diagnostic {
  source?: string;
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number,
  ) {}
}
class CodeAction {
  command?: { command: string; arguments: unknown[] };
  diagnostics?: unknown[];
  isPreferred?: boolean;
  constructor(
    readonly title: string,
    readonly kind: string,
  ) {}
}
class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Position,
  ) {}
}
class SourceBreakpoint {
  constructor(readonly location: Location) {}
}

const stack = (line: number) =>
  `TypeError: boom\n    at charge (/srv/app/src/lib/payments.ts:${line}:20)\n    at x (/srv/app/node_modules/a/b.js:1:1)`;

function harness(mode = 'inline', source = '') {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const collection = new Map<string, Diagnostic[]>();
  const decorations: { range: Range; renderOptions: { after: { contentText: string } } }[][] = [];
  const breakpoints: SourceBreakpoint[] = [];
  const queries: string[] = [];
  let changeListener: ((event: unknown) => void) | undefined;
  const document = {
    uri: Uri.file('/w/src/lib/payments.ts'),
    lineCount: 100,
    lineAt: (line: number) => ({ range: { end: new Position(line, 30) } }),
  };
  const vscode = {
    Uri,
    Position,
    Range,
    Diagnostic,
    CodeAction,
    Location,
    SourceBreakpoint,
    CodeActionKind: { QuickFix: 'quickfix' },
    DiagnosticSeverity: { Error: 0 },
    OverviewRulerLane: { Right: 4 },
    FileType: { File: 1 },
    ThemeColor: class {},
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: Uri, diagnostics: Diagnostic[]) => collection.set(uri.toString(), diagnostics),
        get: (uri: Uri) => collection.get(uri.toString()),
        clear: () => collection.clear(),
        dispose() {},
      }),
      registerCodeActionsProvider: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose() {} };
      },
    },
    window: {
      visibleTextEditors: [
        {
          document,
          setDecorations: (_type: unknown, options: (typeof decorations)[number]) => decorations.push(options),
        },
      ],
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
      showInformationMessage: () => undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: Uri.file('/w') }],
      fs: {
        readFile: async () => new TextEncoder().encode(source),
        stat: async () => {
          throw new Error('not at this path');
        },
      },
      // The logged path is from a container, so the file is found by its tail.
      findFiles: async () => [Uri.file('/w/src/lib/payments.ts'), Uri.file('/w/test/payments.ts')],
      onDidChangeTextDocument: (listener: (event: unknown) => void) => {
        changeListener = listener;
        return { dispose() {} };
      },
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    debug: { addBreakpoints: (added: SourceBreakpoint[]) => breakpoints.push(...added) },
  };
  const store = new LogStore(1000, 10 * 1024 * 1024);
  let generation = 0;
  // Each harness loads the module afresh against its own mock.
  delete require.cache[require.resolve('./runtime-errors')];
  const { RuntimeErrors } = withVscode(vscode, () => require('./runtime-errors') as typeof import('./runtime-errors'));
  const errors = new RuntimeErrors({
    store,
    config: { get: <T>(key: string, fallback: T) => (key === 'runtimeErrors' ? (mode as T) : fallback) },
    generation: () => generation,
    showQuery: async (query) => {
      queries.push(query);
    },
  });
  const add = (id: number, line: number) =>
    store.add({
      ...parseLogLine(
        JSON.stringify({
          level: 'error',
          msg: 'failed',
          err: { type: 'TypeError', message: 'boom', stack: stack(line) },
        }),
        'stdout',
        id,
        new Date(0),
      ),
      timestampMs: 1000,
    });
  const addCi = (id: number, fields: Record<string, unknown> = {}) =>
    store.add({
      ...parseLogLine(
        JSON.stringify({
          level: 'error',
          message: '✕ cart › adds items',
          kind: 'test-failure',
          test: 'cart › adds items',
          file: 'out/lib/payments.js',
          run: 7,
          job: 'build',
          ...fields,
        }),
        'stdout',
        id,
        new Date(0),
      ),
      timestampMs: 1000,
    });
  return {
    addCi,
    errors,
    commands,
    collection,
    decorations,
    breakpoints,
    queries,
    document,
    add,
    edit: (line: number) => changeListener!({ document, contentChanges: [{ range: new Range(line, 0, line, 5) }] }),
    clear: () => {
      store.clear();
      generation++;
    },
  };
}

test('the line that raised an error is marked in the Problems panel and after the line', async () => {
  const h = harness();
  h.add(1, 40);
  h.add(2, 40);
  await h.errors.refresh(6000);
  const [diagnostic] = h.collection.get('file:///w/src/lib/payments.ts')!;
  assert.deepEqual(
    [diagnostic.range.start.line, diagnostic.message, diagnostic.source],
    [39, 'TypeError: boom · 2× · 5s ago', 'Logline runtime'],
  );
  assert.equal(h.decorations.at(-1)![0].renderOptions.after.contentText, 'TypeError: boom · 2× · 5s ago');

  const actions = h.errors.provideCodeActions(
    h.document as never,
    diagnostic.range as never,
    {
      diagnostics: [diagnostic],
    } as never,
  );
  assert.deepEqual(
    actions.map((action) => action.title),
    ['Show in Logs', 'Investigate with agent', 'Break here next time'],
  );
  await h.commands.get('logline.showRuntimeError')!(actions[0].command!.arguments![0]);
  assert.equal(h.queries.length, 1);
  assert.deepEqual(actions[1].command!.arguments![0], {
    message: 'TypeError: boom',
    eventId: 2,
    query: (actions[1].command!.arguments![0] as { query?: string }).query,
    count: 2,
    location: '/w/src/lib/payments.ts:40',
  });
  h.commands.get('logline.breakOnRuntimeError')!(actions[2].command!.arguments![0]);
  assert.equal(h.breakpoints[0].location.range.line, 39);
  h.errors.dispose();
});

test('editing a marked line hides its mark until the error happens again', async () => {
  const h = harness();
  h.add(1, 40);
  await h.errors.refresh(2000);
  h.edit(39);
  assert.deepEqual(h.collection.get('file:///w/src/lib/payments.ts'), []);
  await h.errors.refresh(2000);
  assert.equal(h.collection.get('file:///w/src/lib/payments.ts')?.length ?? 0, 0, 'still hidden');
  h.add(2, 40);
  await h.errors.refresh(2000);
  assert.equal(h.collection.get('file:///w/src/lib/payments.ts')?.length, 1);
  h.errors.dispose();
});

test('Problems-only mode shows no inline text, and clearing logs clears the marks', async () => {
  const h = harness('problems');
  h.add(1, 40);
  await h.errors.refresh(2000);
  assert.equal(h.collection.get('file:///w/src/lib/payments.ts')?.length, 1);
  assert.equal(h.decorations.length, 0);
  h.clear();
  await h.errors.refresh(2000);
  assert.equal(h.collection.size, 0);
  h.errors.dispose();
});

test('off marks nothing', async () => {
  const h = harness('off');
  h.add(1, 40);
  await h.errors.refresh(2000);
  assert.equal(h.collection.size, 0);
  h.errors.dispose();
});

test('a test that failed in CI marks its source file at the test, and Investigate carries where it failed', async () => {
  const h = harness(
    'inline',
    ["describe('cart', () => {", "  it('removes items', () => {})", "  it('adds items', () => {})"].join('\n'),
  );
  h.addCi(1);
  await h.errors.refresh(6000);
  const [diagnostic] = h.collection.get('file:///w/src/lib/payments.ts')!;
  assert.equal(diagnostic.range.start.line, 2);
  assert.equal(diagnostic.message, '✕ cart › adds items · failed in CI #7 · build · 5s ago');
  const actions = h.errors.provideCodeActions(
    h.document as never,
    diagnostic.range as never,
    { diagnostics: [diagnostic] } as never,
  );
  const argument = actions[1].command!.arguments![0] as { ci?: string; location?: string };
  assert.equal(argument.ci, 'CI #7 · build');
  assert.equal(argument.location, '/w/src/lib/payments.ts:3');
  h.errors.dispose();
});

test('a test is found by its own name in any quote, and line 0 when it is not found or unreadable', async () => {
  const readers = { text: '' as string | Error };
  const mock = {
    Uri,
    workspace: {
      fs: {
        readFile: async () => {
          if (readers.text instanceof Error) throw readers.text;
          return new TextEncoder().encode(readers.text);
        },
      },
    },
  };
  delete require.cache[require.resolve('./runtime-errors')];
  const { testLine } = withVscode(mock, () => require('./runtime-errors') as typeof import('./runtime-errors'));
  const uri = Uri.file('/w/a.test.ts') as never;
  readers.text = 'x\n  test(\'a\', () => {})\r\n  test("b c", () => {})\n  test(`d`, () => {})';
  assert.equal(await testLine(uri, 'a'), 1);
  assert.equal(await testLine(uri, 'suite › b c'), 2);
  assert.equal(await testLine(uri, 'suite › inner › d'), 3);
  assert.equal(await testLine(uri, 'missing'), 0);
  assert.equal(await testLine(uri, ' › '), 0);
  readers.text = new Error('gone');
  assert.equal(await testLine(uri, 'a'), 0);
});
