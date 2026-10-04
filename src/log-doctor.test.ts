import assert from 'node:assert/strict';
import test from 'node:test';
import { findSensitiveValues, uncaughtExceptionVariable } from './core/log-findings';
import { parseLogLine } from './core/log-event';
import { extractLogSites, LogSiteIndex, LogSiteTracker } from './core/log-sites';
import { withVscode } from './test/vscode-mock';

const event = (id: number, line: string, stream = 'stdout') => parseLogLine(line, stream, id, new Date(0));
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

test('sensitive values are found in fields and plain text, and only a masked preview is kept', () => {
  const found = findSensitiveValues(event(1, JSON.stringify({ level: 'info', msg: 'auth ok', ctx: { headers: { authorization: `Bearer ${JWT}` } }, user: 'ann@acme.io' })));
  const byKind = Object.fromEntries(found.map(value => [value.kind, value]));
  assert.equal(byKind.jwt.path, 'ctx.headers.authorization');
  assert.equal(byKind.jwt.category, 'secret');
  assert.equal(byKind.bearer, undefined, 'a JWT sent as a bearer token is reported once, as a JWT');
  assert.equal(byKind.credential, undefined);
  assert.equal(findSensitiveValues(event(3, '{"msg":"login","password":"hunter22"}'))[0]?.kind, 'credential');
  assert.equal(byKind.email.preview, 'a…@acme.io');
  for (const value of found) assert.ok(!value.preview.includes(JWT.slice(10, 30)), 'previews never repeat the secret');
  const text = findSensitiveValues(event(2, 'charging card 4242 4242 4242 4242 with key AKIAIOSFODNN7EXAMPLE', 'terminal'));
  assert.deepEqual(text.map(value => [value.kind, value.path, value.preview]).sort(),
    [['aws-key', 'message', 'AKIA…[aws-key]'], ['card', 'message', '•••• 4242']]);
  assert.deepEqual(findSensitiveValues(event(4, 'charging amex 3782 822463 10005', 'terminal')).map(value => [value.kind, value.preview]),
    [['card', '•••• 0005']], 'Amex numbers are grouped 4-6-5');
});

test('ordinary values are not reported as sensitive', () => {
  for (const line of [
    '{"level":"info","msg":"request done","requestId":"4111111111111111","timestampMs":1791028801123}',
    '{"level":"info","msg":"login","password":"[REDACTED]","tokenCount":12345678}',
    '{"level":"info","msg":"mail sent to user@example.com"}',
    'GET /api/orders/4242424242424242 200'
  ]) assert.deepEqual(findSensitiveValues(event(1, line, 'terminal')), [], line);
});

test('a catch block whose exception is not logged is detected across languages', () => {
  const js = 'try {\n  await pay();\n} catch (err) {\n  if (retry) {\n    retry();\n  }\n  logger.error("payment failed");\n}\n';
  assert.equal(uncaughtExceptionVariable(js, 7, 'ts'), 'err');
  assert.equal(uncaughtExceptionVariable(js.replace('"payment failed"', '"payment failed", err'), 7, 'ts'), undefined);
  const java = 'try {\n  run();\n} catch (IOException | SQLException e) {\n  log.error("job failed");\n}\n';
  assert.equal(uncaughtExceptionVariable(java, 4, 'java'), 'e');
  const kotlin = 'try { run() } catch (ex: Exception) {\n  log.error("job failed")\n}\n';
  assert.equal(uncaughtExceptionVariable(kotlin, 2, 'kt'), 'ex');
  const python = 'try:\n    run()\nexcept ValueError as exc:\n    if verbose:\n        print("x")\n    logger.error("job failed")\n';
  assert.equal(uncaughtExceptionVariable(python, 6, 'py'), 'exc');
  assert.equal(uncaughtExceptionVariable('def f():\n    logger.error("no try here")\n', 2, 'py'), undefined);
  assert.equal(uncaughtExceptionVariable('function f() {\n  log.error("outside");\n}\n', 2, 'js'), undefined);
});

class Range { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) { } }
class Position { constructor(readonly line: number, readonly character: number) { } }
class Diagnostic { source = ''; code = ''; constructor(readonly range: Range, readonly message: string, readonly severity: number) { } }
class WorkspaceEdit {
  readonly edits: { kind: string; at: unknown; text: string }[] = [];
  replace(_uri: unknown, range: Range, text: string) { this.edits.push({ kind: 'replace', at: range, text }); }
  insert(_uri: unknown, position: Position, text: string) { this.edits.push({ kind: 'insert', at: position, text }); }
}
class CodeAction { diagnostics: unknown[] = []; isPreferred = false; edit?: WorkspaceEdit; command?: unknown; constructor(readonly title: string, readonly kind: unknown) { } }

test('log doctor reports runtime evidence on statements and offers fixes', async () => {
  const source = [
    'export async function checkout(req) {',
    '  logger.info("auth ok", { headers: req.headers });',
    '  try {',
    '    await charge(req);',
    '  } catch (err) {',
    '    logger.error("payment failed for order");',
    '  }',
    '  logger.info(`cart ${req.id} has ${req.items} items`);',
    '}'
  ].join('\n');
  const uri = { path: '/w/src/checkout.ts', toString: () => 'file:///w/src/checkout.ts' };
  const collections = new Map<string, Diagnostic[]>();
  let sets = 0;
  const mock = {
    Range, Position, Diagnostic, WorkspaceEdit, CodeAction,
    CodeActionKind: { QuickFix: 'quickfix' }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
      createDiagnosticCollection: () => ({ clear: () => collections.clear(), set: (target: typeof uri, diagnostics: Diagnostic[]) => { sets++; collections.set(target.path, diagnostics); }, delete: (target: typeof uri) => collections.delete(target.path), dispose() { } }),
      registerCodeActionsProvider: () => ({ dispose() { } })
    },
    commands: { registerCommand: () => ({ dispose() { } }) },
    workspace: {
      textDocuments: [{ uri, getText: () => source }],
      onDidChangeConfiguration: () => ({ dispose() { } }),
      onDidChangeTextDocument: () => ({ dispose() { } }),
      asRelativePath: () => 'src/checkout.ts'
    }
  };
  const { LogDoctor, isIgnored, siteFindings } = withVscode(mock, () => require('./vscode/log-doctor') as typeof import('./vscode/log-doctor'));
  const index = new LogSiteIndex();
  index.setFile('src/checkout.ts', extractLogSites('src/checkout.ts', source));
  const tracker = new LogSiteTracker(index);
  tracker.findings = true;
  let id = 0;
  const events = [
    event(++id, JSON.stringify({ level: 'info', msg: 'auth ok', headers: { authorization: `Bearer ${JWT}` } })),
    event(++id, JSON.stringify({ level: 'error', msg: 'payment failed for order' })),
    ...Array.from({ length: 600 }, (_, n) => event(++id, `cart c${n} has ${n} items`, 'terminal'))
  ];
  tracker.process(events);
  const lens = { siteUri: () => uri, onDidChangeCodeLenses: () => ({ dispose() { } }), schedule() { } };
  let changes = 0;
  const doctor = new LogDoctor({ config: { get: <T>(_key: string, fallback: T) => fallback }, index, tracker, lens: lens as never, askCopilot: async () => undefined, onChanged: () => changes++ });
  await doctor.refresh();
  const secretSite = index.sitesIn('src/checkout.ts')[0];
  assert.deepEqual(doctor.findingsFor(secretSite.id).map(finding => finding.code), ['secret']);
  assert.deepEqual(doctor.views()[0], { siteId: secretSite.id, code: 'secret', severity: 'warning', message: doctor.findings[0].message, file: 'src/checkout.ts', line: 2 });
  const changesAfterFirst = changes;
  const revisionAfterFirst = doctor.revision;
  assert.equal(doctor.views(), doctor.views(), 'the panel list is built once per change');
  const diagnostics = collections.get('/w/src/checkout.ts')!;
  const byCode = new Map(diagnostics.map(diagnostic => [diagnostic.code, diagnostic]));
  assert.match(byCode.get('secret')!.message, /Logged a JSON Web Token in field headers\.authorization in 1 event \(eyJh…\[jwt\]\)/);
  assert.equal(byCode.get('secret')!.range.startLine, 1);
  assert.match(byCode.get('missing-exception')!.message, /without the caught exception 'err'/);
  assert.match(byCode.get('noisy')!.message, /Logged 99% of all retained events \(600 of 602\)/);
  assert.match(byCode.get('unstructured')!.message, /Formats 2 values into the message text/);
  assert.equal(doctor.findings[0].severity, 'warning');
  await doctor.refresh();
  assert.equal(sets, 1, 'nothing new was counted, so diagnostics are not re-sent');
  assert.equal(changes, changesAfterFirst, 'the Logs panel is not told about unchanged findings');
  assert.equal(doctor.revision, revisionAfterFirst);
  tracker.process([event(++id, 'cart c600 has 600 items', 'terminal')]);
  await doctor.refresh();
  assert.equal(sets, 2);
  assert.match(new Map(collections.get('/w/src/checkout.ts')!.map(diagnostic => [diagnostic.code, diagnostic])).get('noisy')!.message, /601 of 603/);

  const lines = source.split('\n');
  const document = { uri, lineAt: (line: number) => ({ lineNumber: line, text: lines[line] }) };
  const actions = (code: string) => doctor.provideCodeActions(document as never, undefined as never, { diagnostics: [byCode.get(code)] } as never) as unknown as CodeAction[];
  const pass = actions('missing-exception').find(action => action.title === "Pass 'err' to the log call")!;
  assert.deepEqual(pass.edit!.edits, [{ kind: 'insert', at: new Position(5, 43), text: ', err' }]);
  assert.equal(lines[5].slice(0, 43) + ', err' + lines[5].slice(43), '    logger.error("payment failed for order", err);');
  const lower = actions('noisy').find(action => action.title === 'Lower to debug')!;
  assert.equal(lower.edit!.edits[0].text, 'debug');
  assert.ok(actions('secret').some(action => action.title === 'Fix with Copilot'));
  const ignore = actions('secret').find(action => action.title === 'Ignore this secret finding')!;
  assert.equal(ignore.edit!.edits[0].text, '  // logline-ignore: secret\n');

  // Ignore comments and the security level narrow what is reported.
  assert.equal(isIgnored(['// logline-ignore: secret', 'log.info(token)'], 2, 'secret'), true);
  assert.equal(isIgnored(['// logline-ignore: noisy', 'log.info(token)'], 2, 'secret'), false);
  assert.equal(isIgnored(['log.info(token) // logline-ignore'], 1, 'secret'), true);
  const site = index.sitesIn('src/checkout.ts')[0];
  assert.deepEqual(siteFindings(site, tracker.stats.get(site.id)!, tracker.total, 'security').map(finding => finding.code), ['secret']);
  assert.deepEqual(siteFindings(site, tracker.stats.get(site.id)!, tracker.total, 'off'), []);
  doctor.dispose();
});
