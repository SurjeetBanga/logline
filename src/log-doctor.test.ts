import assert from 'node:assert/strict';
import test from 'node:test';
import { findSensitiveValues, hasRequestContext, isQuietFailure, SensitiveScanner, uncaughtExceptionVariable } from './core/log-findings';
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

test('failures logged below warning are recognized, and denials of failure are not', () => {
  const quiet = (line: string) => isQuietFailure(event(1, line));
  assert.equal(quiet('{"level":"info","msg":"payment failed for order 12"}'), true);
  assert.equal(quiet('{"level":"debug","msg":"upstream call","status":503}'), true);
  assert.equal(quiet('{"level":"info","msg":"retrying","stack":"Error: boom\\n    at run (/srv/a.js:1:1)"}'), true);
  assert.equal(quiet('{"level":"info","msg":"connection refused by db"}'), true);
  for (const line of ['{"level":"info","msg":"batch done with no errors"}', '{"level":"info","msg":"sync complete, errors=0"}',
    '{"level":"error","msg":"payment failed"}', '{"level":"warn","msg":"payment failed"}', '{"level":"info","msg":"terror alert level"}']) {
    assert.equal(quiet(line), false, line);
  }
  assert.equal(hasRequestContext(event(1, '{"msg":"x","trace_id":"abc"}')), true);
  assert.equal(hasRequestContext(event(1, '{"msg":"x","req":{"id":"r1"}}')), true, 'nested req.id');
  assert.equal(hasRequestContext(event(1, '{"msg":"x","user":"u1"}')), false);
});

test('the sensitive scanner reports leaks per source, skips claimed events and follows retention', () => {
  const scanner = new SensitiveScanner();
  const at = (id: number, serverId: string, line: string) => ({ ...event(id, line), serverId, server: serverId.toUpperCase() });
  const events = [
    at(1, 'lib', `{"msg":"auth","token":"Bearer ${JWT}"}`),
    at(2, 'lib', `{"msg":"auth","token":"Bearer ${JWT}"}`),
    at(3, 'api', '{"msg":"signup ann@acme.io"}'),
    at(4, 'api', '{"msg":"signup bob@acme.io"}')
  ];
  scanner.scan(events, item => item.id === 4);
  const summary = () => scanner.findings.map(found => [found.server, found.value.kind, found.count, found.lastId]);
  assert.deepEqual(summary(), [['LIB', 'jwt', 2, 2], ['API', 'email', 1, 3]], 'event 4 belongs to a statement finding');
  const version = scanner.version;
  scanner.scan(events);
  assert.equal(scanner.version, version, 'events are scanned once');
  scanner.evict(2);
  assert.deepEqual(summary(), [['LIB', 'jwt', 1, 2], ['API', 'email', 1, 3]]);
  scanner.evict(4);
  assert.deepEqual(summary(), []);
  scanner.reset();
  assert.equal(scanner.watermark, 0);
});

test('log doctor flags quiet failures, oversized events and errors without request context, and leaks in unmatched output', async () => {
  const source = [
    'function handle(req) {',
    '  logger.info("charge failed for order", { order: req.order });',
    '  logger.debug("payload dump", { body: req.body });',
    '  logger.error("lookup broke", { key: req.key });',
    '}'
  ].join('\n');
  const uri = { path: '/w/src/handle.ts', toString: () => 'file:///w/src/handle.ts' };
  const diagnostics = new Map<string, Diagnostic[]>();
  let report = '';
  const mock = {
    Range, Position, Diagnostic, WorkspaceEdit, CodeAction,
    CodeActionKind: { QuickFix: 'quickfix' }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
      createDiagnosticCollection: () => ({ clear: () => diagnostics.clear(), set: (target: typeof uri, list: Diagnostic[]) => diagnostics.set(target.path, list), delete: () => undefined, dispose() { } }),
      registerCodeActionsProvider: () => ({ dispose() { } })
    },
    commands: { registerCommand: () => ({ dispose() { } }) },
    window: { showTextDocument: async () => undefined },
    workspace: {
      textDocuments: [{ uri, getText: () => source }],
      onDidChangeConfiguration: () => ({ dispose() { } }), onDidChangeTextDocument: () => ({ dispose() { } }),
      openTextDocument: async ({ content }: { content: string }) => { report = content; return {}; }
    }
  };
  // The module binds the VS Code API it was first loaded with; load it against this mock.
  delete require.cache[require.resolve('./vscode/log-doctor')];
  const { LogDoctor } = withVscode(mock, () => require('./vscode/log-doctor') as typeof import('./vscode/log-doctor'));
  const index = new LogSiteIndex();
  index.setFile('src/handle.ts', extractLogSites('src/handle.ts', source));
  const tracker = new LogSiteTracker(index);
  tracker.findings = true;
  let id = 0;
  tracker.process([
    // Most structured logs carry a request id; the errors below do not.
    ...Array.from({ length: 60 }, () => event(++id, JSON.stringify({ level: 'info', msg: 'served', requestId: `r${id}` }))),
    ...Array.from({ length: 4 }, () => event(++id, JSON.stringify({ level: 'info', msg: 'charge failed for order', order: id }))),
    ...Array.from({ length: 3 }, () => event(++id, JSON.stringify({ level: 'debug', msg: 'payload dump', body: 'x'.repeat(9000) }))),
    ...Array.from({ length: 3 }, () => event(++id, JSON.stringify({ level: 'error', msg: 'lookup broke', key: id })))
  ]);
  const scanner = new SensitiveScanner();
  scanner.scan([{ ...event(++id, `{"msg":"vendor sdk auth","header":"Bearer ${JWT}"}`), serverId: 'vendor', server: 'Vendor SDK' }]);
  const lens = { siteUri: () => uri, onDidChangeCodeLenses: () => ({ dispose() { } }), schedule() { } };
  const doctor = new LogDoctor({ config: { get: <T>(_key: string, fallback: T) => fallback }, index, tracker, lens: lens as never,
    askCopilot: async () => undefined, unclaimed: () => ({ findings: scanner.findings, version: scanner.version }) });
  await doctor.refresh();
  const byCode = new Map(diagnostics.get('/w/src/handle.ts')!.map(diagnostic => [diagnostic.code, diagnostic]));
  assert.match(byCode.get('quiet-failure')!.message, /Logged 4 failures below warning level \(100% of its events\)/);
  assert.match(byCode.get('oversized')!.message, /Logs 8\.8 KB per event on average/);
  assert.match(byCode.get('contextless')!.message, /Logged 3 warnings or errors without a trace or request id, though 86% of structured logs carry one/);
  const lines = source.split('\n');
  const document = { uri, lineAt: (line: number) => ({ lineNumber: line, text: lines[line] }) };
  const [raise] = doctor.provideCodeActions(document as never, undefined as never, { diagnostics: [byCode.get('quiet-failure')] } as never) as unknown as CodeAction[];
  assert.equal(raise.title, 'Raise to error');
  assert.equal(raise.edit!.edits[0].text, 'error');
  // A leak in output no statement accounts for is listed first, with an example to open.
  assert.equal(doctor.total, 4);
  assert.deepEqual(doctor.views()[0], { code: 'secret', severity: 'warning', source: 'Vendor SDK', eventId: id,
    message: 'Vendor SDK logged a JSON Web Token in field header in 1 event (eyJh…[jwt]), from code Logline has not matched to a log statement, such as a library, another repository, or imported logs.' });
  await (doctor as unknown as { showHealth(): Promise<void> }).showHealth();
  assert.match(report, /- \*\*1\*\* logged secrets such as tokens or keys/);
  assert.match(report, /## In output not matched to a statement\n[\s\S]*\| Vendor SDK \| Vendor SDK logged a JSON Web Token/);
  assert.match(report, /\*\*Failures logged below warning\.\*\* Error filters, alerts/);
  doctor.dispose();
});
