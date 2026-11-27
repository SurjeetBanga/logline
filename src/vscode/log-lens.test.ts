import assert from 'node:assert/strict';
import test from 'node:test';
import { LogSiteIndex, LogSiteTracker } from '../core/log-sites';
import { LogStore } from '../core/log-store';
import { parseLogLine } from '../core/log-event';
import { withVscode } from '../test/vscode-mock';

class Uri {
  constructor(readonly path: string) {}
  get fsPath() {
    return this.path;
  }
  get scheme() {
    return 'file';
  }
  toString() {
    return `file://${this.path}`;
  }
  static file(path: string) {
    return new Uri(path);
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri([base.path, ...parts].join('/'));
  }
}
class Range {
  readonly startLine: number;
  constructor(start: number | { line: number }, ..._rest: unknown[]) {
    this.startLine = typeof start === 'number' ? start : start.line;
  }
}
class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
class CodeLens {
  constructor(
    readonly range: Range,
    readonly command: { title: string; command: string; arguments: unknown[] },
  ) {}
}
class Hover {
  constructor(readonly contents: MarkdownString) {}
}
class MarkdownString {
  value = '';
  isTrusted: unknown;
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(text: string) {
    this.value += text;
    return this;
  }
  appendText(text: string) {
    this.value += text.replace(/[\\*_`[\]]/g, '\\$&');
    return this;
  }
}
class EventEmitter {
  listeners: (() => void)[] = [];
  event = (listener: () => void) => {
    this.listeners.push(listener);
    return { dispose() {} };
  };
  fire() {
    for (const listener of this.listeners) listener();
  }
  dispose() {}
}

const commands = new Map<string, (...args: unknown[]) => unknown>();
// A document whose lines come from the fake files.
const textDocument = (path: string) => ({
  uri: Uri.file(path),
  lineCount: 6,
  lineAt: (line: number) => {
    const text = files.get(path)?.split('\n')[line] ?? '';
    return { text, range: { end: new Position(line, text.length) } };
  },
});
const files = new Map<string, string>([
  [
    '/w/src/auth.ts',
    'export function login(id: string) {\n  logger.info(`user ${id} logged in`);\n  logger.error("login failed for user");\n  logger.debug("session refreshed ok");\n}\n',
  ],
]);
// Files the initial workspace scan does not return, as if beyond its file limit.
const unscanned = new Map<string, string>([
  ['/w/deep/pkg/worker.go', 'package main\n\nfunc run() {\n\tlog.Printf("ok")\n}\n'],
]);
const opened: { path: string; line: number }[] = [];
let configured = 'codelens+gutter';
let decorations: Range[] = [];
type ValueDecoration = { range: Range; renderOptions: { after: { contentText: string } } };
// What each statement shows after its line, by line, and whether it is in the error colour.
let values = new Map<number, { text: string; error: boolean }>();
const editor = {
  document: textDocument('/w/src/auth.ts'),
  setDecorations(
    type: { options: { gutterIconPath?: unknown; after?: { color: { id: string } } } },
    ranges: unknown[],
  ) {
    if (type.options.gutterIconPath) {
      decorations = ranges as Range[];
      return;
    }
    const error = type.options.after?.color.id === 'editorError.foreground';
    for (const [line, value] of values) if (value.error === error) values.delete(line);
    for (const item of ranges as ValueDecoration[])
      values.set(item.range.startLine, { text: item.renderOptions.after.contentText, error });
  },
};
let changeText: ((event: unknown) => void) | undefined;
let inlineValues = true;
const clipboard: string[] = [];
const breakpoints: { line: number; character: number }[] = [];
let pick: ((items: { label: string; site: unknown }[]) => unknown) | undefined;
const mock = {
  Uri,
  Range,
  Position,
  CodeLens,
  Hover,
  MarkdownString,
  EventEmitter,
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  OverviewRulerLane: { Right: 4 },
  languages: { registerCodeLensProvider: () => ({ dispose() {} }), registerHoverProvider: () => ({ dispose() {} }) },
  commands: {
    registerCommand(name: string, callback: (...args: unknown[]) => unknown) {
      commands.set(name, callback);
      return { dispose() {} };
    },
  },
  window: {
    visibleTextEditors: [editor],
    activeTextEditor: editor,
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    createTextEditorDecorationType: (options: unknown) => ({ options, dispose() {} }),
    showInformationMessage: () => undefined,
    showQuickPick: async (items: { label: string; site: unknown }[]) => pick?.(items),
    showTextDocument: async (document: { uri: Uri }, options: { selection: Range }) => {
      opened.push({ path: document.uri.path, line: options.selection.startLine });
    },
  },
  env: { clipboard: { writeText: async (text: string) => void clipboard.push(text) } },
  debug: {
    addBreakpoints: (added: { location: { range: Position } }[]) =>
      breakpoints.push(...added.map((breakpoint) => breakpoint.location.range)),
  },
  SourceBreakpoint: class {
    constructor(readonly location: unknown) {}
  },
  Location: class {
    constructor(
      readonly uri: unknown,
      readonly range: unknown,
    ) {}
  },
  workspace: {
    textDocuments: [] as unknown[],
    asRelativePath: (uri: Uri) => uri.path.replace(/^\/w\//, ''),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeTextDocument: (listener: (event: unknown) => void) => {
      changeText = listener;
      return { dispose() {} };
    },
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    }),
    findFiles: async (glob: string) =>
      glob.includes('{')
        ? [...files.keys()].map((path) => Uri.file(path))
        : [...files.keys(), ...unscanned.keys()]
            .filter((path) => path.endsWith('/' + glob.slice(3)))
            .map((path) => Uri.file(path)),
    fs: {
      stat: async (uri: Uri) => ({ size: (files.get(uri.path) ?? unscanned.get(uri.path))!.length }),
      readFile: async (uri: Uri) => new TextEncoder().encode(files.get(uri.path) ?? unscanned.get(uri.path)),
    },
    openTextDocument: async (uri: Uri) => textDocument(uri.path),
  },
};

async function harness(maxRows = 100000) {
  const loaded = withVscode(mock, () => require('./log-lens') as typeof import('./log-lens'));
  const store = new LogStore(maxRows);
  const index = new LogSiteIndex();
  const tracker = new LogSiteTracker(index);
  const queries: string[] = [];
  let generation = 0;
  const lens = new loaded.LogLens(
    {
      store,
      index,
      tracker,
      config: {
        get<T>(key: string, fallback: T): T {
          if (key === 'inlineValues') return inlineValues as T;
          return (key === 'logLenses' ? configured : fallback) as T;
        },
      },
      generation: () => generation,
      showQuery: async (query) => {
        queries.push(query);
      },
    },
    Uri.file('/ext') as never,
  );
  for (let i = 0; i < 20 && index.size < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  return {
    loaded,
    lens,
    store,
    index,
    tracker,
    queries,
    clear: () => {
      generation++;
      store.clear();
    },
  };
}
const add = (store: LogStore, id: number, line: string) => store.add(parseLogLine(line, 'stdout', id, new Date()));

test('log lenses count events per statement and filter the Logs panel', async () => {
  inlineValues = false;
  const h = await harness();
  assert.equal(h.index.size, 3);
  add(h.store, 1, '{"level":"info","msg":"user 41 logged in","durationMs":30}');
  add(h.store, 2, '{"level":"info","msg":"user 42 logged in","durationMs":12}');
  add(h.store, 3, '{"level":"error","msg":"login failed for user bob"}');
  add(h.store, 4, '{"level":"info","msg":"unrelated"}');
  h.lens.refresh(Date.now() + 5000);
  const document = textDocument('/w/src/auth.ts');
  const lenses = h.lens.provideCodeLenses(document as never) as unknown as CodeLens[];
  assert.deepEqual(
    lenses.map((lens) => [lens.range.startLine, lens.command.title.replace(/ · last .*$/, '')]),
    [
      [1, '$(pulse) 2 hits · 12 ms–30 ms'],
      [2, '$(pulse) 1 hit · 1 error'],
    ],
  );
  assert.deepEqual(
    decorations.map((range) => range.startLine),
    [2],
    'gutter marks only statements that logged errors',
  );
  await commands.get('logline.showLogSite')!(lenses[0].command.arguments[0]);
  assert.deepEqual(h.queries, ['message:/user.*logged\\s+in/']);
  const hover = h.lens.provideHover(document as never, new Position(1, 4) as never) as unknown as Hover;
  assert.match(hover.contents.value, /2 hits · 12 ms–30 ms · last .* matched by message text/);
  assert.match(hover.contents.value, /Duration 12 ms–30 ms, from the latest 2 events with `durationMs`/);
  assert.match(hover.contents.value, /user 42 logged in[^]*user 41 logged in/);
  assert.equal(h.lens.provideHover(document as never, new Position(3, 4) as never), undefined);

  add(h.store, 5, '{"level":"info","msg":"user 43 logged in"}');
  h.lens.refresh(Date.now() + 5000);
  assert.match((h.lens.provideCodeLenses(document as never) as unknown as CodeLens[])[0].command.title, /3 hits/);
  h.clear();
  h.lens.refresh(Date.now() + 5000);
  assert.deepEqual(h.lens.provideCodeLenses(document as never), []);
  h.lens.dispose();
  inlineValues = true;
});

test('each log statement shows what it logged last after its line, and an edit hides it until it logs again', async () => {
  values = new Map();
  const h = await harness();
  add(h.store, 1, '{"level":"info","msg":"user 41 logged in"}');
  add(h.store, 2, 'user 42 logged in');
  add(h.store, 3, '{"level":"error","msg":"login failed for user","user":"bob","token":"abc"}');
  add(h.store, 4, '{"level":"debug","msg":"session refreshed ok"}');
  h.lens.refresh(Date.now() + 5000);
  assert.deepEqual(Object.fromEntries(values), {
    1: { text: '42', error: false },
    2: { text: '{"user":"bob","token":"[REDACTED]"}', error: true },
  });
  // The value replaces nothing in the CodeLens, which keeps the counts.
  const document = textDocument('/w/src/auth.ts');
  assert.match(
    (h.lens.provideCodeLenses(document as never) as unknown as CodeLens[])[0].command.title,
    /^\$\(pulse\) 2 hits/,
  );

  // The hover lists the latest values, newest first, with Copy value and Break here.
  const hover = h.lens.provideHover(document as never, new Position(1, 4) as never) as unknown as Hover;
  assert.match(hover.contents.value, /`42`[^]*`41`/);
  assert.match(hover.contents.value, /\[Copy value\]\(command:logline\.copyLogValue\?[^]*\[Break here\]/);
  const site = h.index.sitesIn('src/auth.ts').find((item) => item.line === 2)!;
  await commands.get('logline.copyLogValue')!(site.id);
  assert.deepEqual(clipboard, ['42']);
  commands.get('logline.breakAtLogSite')!(site.id);
  assert.deepEqual(breakpoints, [new Position(1, 2)]);

  changeText!({
    document,
    contentChanges: [{ range: { start: new Position(1, 10), end: new Position(1, 10) } }],
  });
  assert.equal(values.has(1), false, 'an edited line hides its value');
  assert.equal(values.has(2), true);
  add(h.store, 5, 'user 43 logged in');
  h.lens.refresh(Date.now() + 5000);
  assert.equal(values.get(1)?.text, '43', 'and shows it again once the statement logs again');

  inlineValues = false;
  (h.lens as unknown as { decorateValues(): void }).decorateValues();
  assert.equal(values.size, 0, 'logline.inlineValues off removes them');
  inlineValues = true;
  h.lens.dispose();
});

test('quiet statements lists log calls without retained events and opens the chosen one', async () => {
  const h = await harness();
  add(h.store, 1, '{"level":"info","msg":"user 41 logged in"}');
  h.lens.refresh(Date.now() + 5000);
  let offered: string[] = [];
  pick = (items) => {
    offered = items.map((item) => item.label);
    return items[1];
  };
  await commands.get('logline.showQuietLogStatements')!();
  assert.deepEqual(offered, ['Line 3', 'Line 4']);
  assert.deepEqual(opened.at(-1), { path: '/w/src/auth.ts', line: 3 });
  h.lens.dispose();
});

test('lens titles summarize counts and age', () => {
  const { lensTitle, formatAgo } = withVscode(mock, () => require('./log-lens') as typeof import('./log-lens'));
  assert.equal(
    lensTitle({ hits: 1200, errors: 0, samples: [], exact: 0, lastSeen: 1000 }, 4000),
    '$(pulse) 1,200 hits · last 3s ago',
  );
  const timed = (...values: number[]) => ({
    hits: values.length,
    errors: 1,
    samples: [],
    exact: 0,
    durations: values.map((ms, id) => ({ id, ms })),
  });
  assert.equal(lensTitle(timed(42)), '$(pulse) 1 hit · 42 ms · 1 error');
  assert.equal(
    lensTitle(timed(8, 1500)),
    '$(pulse) 2 hits · 8 ms–1.5 s · 1 error',
    'a range until percentiles mean something',
  );
  assert.equal(lensTitle(timed(0.25, 10, 12, 14, 900)), '$(pulse) 5 hits · p50 12 ms · p95 900 ms · 1 error');
  assert.equal(formatAgo(125000), '2m ago');
  assert.equal(formatAgo(7200000), '2h ago');
});

test('turning lenses off releases the index', async () => {
  configured = 'off';
  const h = await harness();
  assert.equal(h.lens.enabled, false);
  assert.equal(h.index.size, 0);
  assert.deepEqual(h.lens.provideCodeLenses(textDocument('/w/src/auth.ts') as never), []);
  h.lens.dispose();
  configured = 'codelens+gutter';
});

test('lens counts drop events evicted from retention', async () => {
  const h = await harness(2);
  add(h.store, 1, '{"level":"info","msg":"user 41 logged in"}');
  const later = Date.now() + 5000;
  h.lens.refresh(later);
  const document = textDocument('/w/src/auth.ts');
  add(h.store, 2, '{"level":"info","msg":"user 42 logged in"}');
  add(h.store, 3, '{"level":"error","msg":"login failed for user bob"}');
  h.lens.refresh(later + 1000);
  const titles = () =>
    (h.lens.provideCodeLenses(document as never) as unknown as CodeLens[]).map((lens) =>
      lens.command.title.replace(/ · last .*$/, ''),
    );
  assert.deepEqual(titles(), ['$(pulse) 1 hit', '$(pulse) 1 hit · 1 error'], 'the evicted event no longer counts');
  add(h.store, 4, '{"level":"info","msg":"user 43 logged in"}');
  add(h.store, 5, '{"level":"info","msg":"user 44 logged in"}');
  h.lens.refresh(later + 2000);
  assert.deepEqual(titles(), ['$(pulse) 2 hits'], 'a statement whose events were all evicted loses its lens');
  h.lens.dispose();
});

test('files that events report are indexed on demand beyond the workspace scan', async () => {
  const h = await harness();
  assert.equal(h.index.sitesIn('deep/pkg/worker.go').length, 0);
  h.store.add({ id: 1, level: 'info', message: 'ok', location: { file: '/build/src/deep/pkg/worker.go', line: 4 } });
  h.lens.refresh(Date.now() + 5000);
  for (let i = 0; i < 20 && !h.index.sitesIn('deep/pkg/worker.go').length; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.index.sitesIn('deep/pkg/worker.go').length, 1);
  h.lens.refresh(Date.now() + 10000);
  const lenses = h.lens.provideCodeLenses(textDocument('/w/deep/pkg/worker.go') as never) as unknown as CodeLens[];
  assert.match(lenses[0].command.title, /1 hit/, 'the short "ok" statement matches by its reported location');
  h.lens.dispose();
});
