import assert from 'node:assert/strict';
import test from 'node:test';
import { withVscode } from '../test/vscode-mock';

class Uri {
  constructor(readonly path: string) {}
  toString() {
    return `file://${this.path}`;
  }
}
class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
class Selection extends Range {
  constructor(
    start: Position,
    end: Position,
    readonly active = end,
  ) {
    super(start, end);
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

// A document whose edits splice its lines, enough for line inserts and deletes.
class Document {
  isDirty = false;
  saved = 0;
  readonly eol = 1;
  constructor(
    readonly uri: Uri,
    public lines: string[],
  ) {}
  get lineCount() {
    return this.lines.length;
  }
  getText(range?: Range) {
    if (!range) return this.lines.join('\n');
    return this.lines[range.start.line].slice(range.start.character, range.end.character);
  }
  lineAt(line: number) {
    return {
      text: this.lines[line],
      range: { end: new Position(line, this.lines[line].length) },
      rangeIncludingLineBreak: new Range(new Position(line, 0), new Position(line + 1, 0)),
    };
  }
  getWordRangeAtPosition(position: Position, pattern: RegExp) {
    const text = this.lines[position.line];
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
      const end = match.index + match[0].length;
      if (match.index <= position.character && position.character <= end)
        return new Range(new Position(position.line, match.index), new Position(position.line, end));
    }
    return undefined;
  }
  apply(inserts: { at: Position; text: string }[], deletes: Range[]) {
    for (const range of [...deletes].sort((a, b) => b.start.line - a.start.line)) {
      this.lines.splice(range.start.line, range.end.line - range.start.line);
    }
    for (const { at, text } of [...inserts].sort((a, b) => b.at.line - a.at.line)) {
      const added = text.replace(/\n$/, '').split('\n');
      if (at.character === 0) this.lines.splice(at.line, 0, ...added);
      else this.lines.splice(at.line + 1, 0, ...added.slice(1));
    }
    this.isDirty = true;
  }
  async save() {
    this.saved++;
    this.isDirty = false;
    return true;
  }
}

function harness(documents: Document[], answer: string | undefined = 'Remove') {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const contexts: unknown[] = [];
  const messages: string[] = [];
  const window = {
    activeTextEditor: undefined as unknown,
    showInformationMessage: (message: string) => messages.push(message),
    showWarningMessage: async (message: string) => {
      messages.push(message);
      return answer;
    },
    withProgress: (_options: unknown, task: () => unknown) => task(),
  };
  const byUri = (uri: Uri) => documents.find((document) => document.uri.toString() === uri.toString())!;
  class WorkspaceEdit {
    readonly deletes: { uri: Uri; range: Range }[] = [];
    delete(uri: Uri, range: Range) {
      this.deletes.push({ uri, range });
    }
  }
  const vscode = {
    Position,
    Range,
    WorkspaceEdit,
    EndOfLine: { LF: 1, CRLF: 2 },
    ProgressLocation: { Window: 10 },
    window,
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        if (id === 'setContext') contexts.push(args[1]);
      },
    },
    workspace: {
      textDocuments: documents,
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      findFiles: async () => documents.map((document) => document.uri),
      openTextDocument: async (uri: Uri) => byUri(uri),
      asRelativePath: (uri: Uri) => uri.path.replace(/^\/w\//, ''),
      applyEdit: async (edit: WorkspaceEdit) => {
        for (const document of documents) {
          const ranges = edit.deletes.filter((item) => item.uri === document.uri).map((item) => item.range);
          if (ranges.length) document.apply([], ranges);
        }
        return true;
      },
      fs: {},
    },
  };
  // Each harness loads the module afresh against its own mock.
  delete require.cache[require.resolve('./log-insert')];
  const module = withVscode(vscode, () => require('./log-insert') as typeof import('./log-insert'));
  // What usage counts were told: never the expression or the file, only the language and whether the file's logger was used.
  const recorded: [string, unknown][] = [];
  const usage = {
    command() {},
    milestone: (name: string) => recorded.push(['milestone', name]),
    record: (event: string, properties: unknown) => recorded.push([event, properties]),
  };
  const inserter = new module.LogInserter(usage as never);
  const edit = (document: Document, selections: Selection[]) => {
    window.activeTextEditor = {
      document,
      selections,
      edit: async (build: (builder: unknown) => void) => {
        const inserts: { at: Position; text: string }[] = [];
        const deletes: Range[] = [];
        build({
          insert: (at: Position, text: string) => inserts.push({ at, text }),
          delete: (range: Range) => deletes.push(range),
        });
        document.apply(inserts, deletes);
        return true;
      },
    };
  };
  return { inserter, commands, contexts, messages, edit, module, recorded };
}

const cursor = (line: number, character: number) =>
  new Selection(new Position(line, character), new Position(line, character));

test('Insert Log writes a line for the name at each cursor, and the file can be cleaned again', async () => {
  const document = new Document(new Uri('/w/src/checkout.ts'), [
    'export function checkout(req) {',
    '  const order = load(req.params.id);',
    '  const total = order.total;',
    '  return total;',
    '}',
  ]);
  const h = harness([document]);
  h.edit(document, [cursor(1, 9), cursor(2, 18)]);
  assert.equal(await h.commands.get('logline.insertLog')!(), true);
  assert.deepEqual(document.lines, [
    'export function checkout(req) {',
    '  const order = load(req.params.id);',
    '  console.log("checkout: order", order); // logline',
    '  const total = order.total;',
    '  console.log("checkout: order.total", order.total); // logline',
    '  return total;',
    '}',
  ]);
  assert.equal(h.contexts.at(-1), true, 'Source Control offers to remove them');
  assert.deepEqual(h.recorded, [
    ['log_inserted', { language: 'js', styled: false }],
    ['milestone', 'first_insert_log'],
  ]);
  assert.equal(await h.commands.get('logline.removeInsertedLogsInFile')!(), 2);
  assert.equal(document.lines.length, 5);
  assert.equal(h.contexts.at(-1), false);
  h.inserter.dispose();
});

test('a selection is logged as written, and keywords at the cursor log that the line ran', async () => {
  const document = new Document(new Uri('/w/a.py'), ['def run(items):', '    n = len(items) + 1']);
  const h = harness([document]);
  assert.equal(
    h.module.expressionAt(document as never, new Selection(new Position(1, 8), new Position(1, 22)) as never),
    'len(items) + 1',
  );
  assert.equal(h.module.expressionAt(document as never, cursor(0, 1) as never), '');
  h.edit(document, [cursor(0, 1)]);
  await h.commands.get('logline.insertLog')!();
  assert.equal(document.lines[1], '    print("run: reached line 2") # logline');
  h.inserter.dispose();
});

test('languages Insert Log does not write say so', async () => {
  const document = new Document(new Uri('/w/main.c'), ['int main() {}']);
  const h = harness([document]);
  h.edit(document, [cursor(0, 0)]);
  assert.equal(await h.commands.get('logline.insertLog')!(), false);
  assert.match(h.messages[0], /JavaScript, TypeScript, Python/);
  h.inserter.dispose();
});

test('removing in the workspace confirms, removes marked lines, and saves files that were saved', async () => {
  const saved = new Document(new Uri('/w/a.ts'), ['x();', 'console.log("a: x", x); // logline', 'y();']);
  const unsaved = new Document(new Uri('/w/b.py'), ['print("b: y") # logline', 'z()']);
  unsaved.isDirty = true;
  const untouched = new Document(new Uri('/w/c.ts'), ['// not logline here', 'w();']);
  const declined = harness([saved, unsaved, untouched], 'Cancel');
  assert.equal(await declined.commands.get('logline.removeInsertedLogs')!(), 0);
  assert.match(declined.messages[0], /Remove 2 inserted log lines from 2 files\?/);
  assert.equal(saved.lines.length, 3);
  declined.inserter.dispose();

  const h = harness([saved, unsaved, untouched]);
  assert.equal(await h.commands.get('logline.removeInsertedLogs')!(), 2);
  assert.deepEqual(saved.lines, ['x();', 'y();']);
  assert.deepEqual(unsaved.lines, ['z()']);
  assert.deepEqual(untouched.lines, ['// not logline here', 'w();']);
  assert.deepEqual([saved.saved, unsaved.saved], [1, 0], 'a file with unsaved changes is left for its owner to save');
  assert.equal(await h.commands.get('logline.removeInsertedLogs')!(), 0);
  assert.match(h.messages.at(-1)!, /No inserted logs/);
  h.inserter.dispose();
});
