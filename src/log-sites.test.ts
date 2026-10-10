import assert from 'node:assert/strict';
import test from 'node:test';
import { eventLocation, extractLogSites, LogSiteIndex, LogSiteTracker, siteDurations, siteQuery } from './core/log-sites';
import { LogStore } from './core/log-store';
import { parseLogLine } from './core/log-event';
import type { LogEvent } from './core/types';

const event = (id: number, message: string, extra: Partial<LogEvent> = {}): LogEvent => ({ id, level: 'info', message, ...extra });

test('extracts logging calls and templates across languages', () => {
  const cases: [string, string, string, string | undefined][] = [
    ['a.ts', 'logger.info(`user ${id} logged in`);', 'user … logged in', 'info'],
    ['a.ts', '  console.error("payment %s failed: %d", id, code)', 'payment … failed: …', 'error'],
    ['a.js', 'this.logger.warn(\'cache miss for key\')', 'cache miss for key', 'warn'],
    ['a.py', 'logger.warning(f"retrying {attempt} of {total}")', 'retrying … of …', 'warn'],
    ['a.py', 'logging.info("Processing %(name)s now", {"name": n})', 'Processing … now', 'info'],
    ['a.py', 'print("Server started on port", port)', 'Server started on port', undefined],
    ['A.java', 'log.error("Order {} rejected by {}", id, svc);', 'Order … rejected by …', 'error'],
    ['a.kt', 'logger.info("Loaded $count items")', 'Loaded … items', 'info'],
    ['a.go', 'log.Printf("listening on %s:%d", host, port)', 'listening on …:…', undefined],
    ['a.go', 'zap.L().Errorw("request failed", "status", 500)', 'request failed', 'error'],
    ['a.go', 'slog.Info("user created", "id", id)', 'user created', 'info'],
    ['A.cs', '_logger.LogInformation("User {UserId} signed in", id);', 'User … signed in', 'info'],
    ['A.cs', 'Console.WriteLine($"Total: {total:C} due")', 'Total: … due', undefined],
    ['a.rs', 'error!("failed to bind {}: {:?}", addr, e);', 'failed to bind …: …', 'error'],
    ['a.rb', 'logger.info("Synced #{count} rows")', 'Synced … rows', 'info']
  ];
  for (const [file, source, template, level] of cases) {
    const [site] = extractLogSites(file, source);
    assert.ok(site, `${file}: ${source}`);
    assert.equal(site.template, template, source);
    assert.equal(site.level, level, source);
  }
});

test('ignores calls without a string literal and records positions', () => {
  const source = 'const x = 1;\nconsole.log(value);\nMath.log(2);\n  logger.info("ready to serve traffic")\nlogger.debug("x")';
  const sites = extractLogSites('src/app.ts', source);
  assert.deepEqual(sites.map(site => [site.line, site.column, site.matchable]), [[4, 3, true], [5, 1, false]]);
  assert.equal(sites[0].id, 'src/app.ts\0ready to serve traffic\x001');
  const repeated = extractLogSites('b.ts', 'log.info("same message here")\nlog.info("same message here")');
  assert.notEqual(repeated[0].id, repeated[1].id);
});

test('plain strings keep ${} literally while template literals interpolate it', () => {
  assert.equal(extractLogSites('a.ts', 'logger.info("cost ${price} total")')[0].template, 'cost ${price} total');
  assert.equal(extractLogSites('a.py', 'logger.info("{{literal}} braces kept")')[0].template, '{literal} braces kept');
});

test('matches messages by template text and resolves ties as unknown', () => {
  const index = new LogSiteIndex();
  index.setFile('src/auth.ts', extractLogSites('src/auth.ts', 'logger.info(`user ${id} logged in`)\nlogger.warn("token expired for session")'));
  index.setFile('src/a.ts', extractLogSites('src/a.ts', 'log.info("connected to database")'));
  index.setFile('src/b.ts', extractLogSites('src/b.ts', 'log.info("connected to database")'));
  assert.equal(index.match(event(1, 'user 4812 logged in'))?.site.line, 1);
  assert.equal(index.match(event(2, '2026-10-03 INFO user alice logged in from 10.0.0.1'))?.site.line, 1);
  assert.equal(index.match(event(3, 'token expired for session abc'))?.site.template, 'token expired for session');
  assert.equal(index.match(event(4, 'user logged out')), undefined);
  assert.equal(index.match(event(5, 'connected to database')), undefined, 'two identical statements are ambiguous');
});

test('matches events by reported code location before message text', () => {
  const index = new LogSiteIndex();
  index.setFile('src/jobs/worker.ts', extractLogSites('src/jobs/worker.ts', '\n\nlogger.debug("ok")\n\nlogger.info(\n  "multi-line call here"\n)'));
  assert.equal(index.match(event(1, 'ok', { location: { file: '/home/me/repo/src/jobs/worker.ts', line: 3 } }))?.exact, true);
  assert.equal(index.match(event(2, 'multi-line call here', { location: { file: 'C:\\repo\\src\\jobs\\worker.ts', line: 6 } }))?.site.line, 5);
  assert.equal(index.match(event(3, 'ok', { location: { file: '/other/worker2.ts', line: 3 } })), undefined);
  const fromFields = index.match(event(4, 'ok', { fields: { caller: 'jobs/worker.ts:3' } }));
  assert.deepEqual([fromFields?.site.line, fromFields?.exact], [3, true]);
});

test('reads code locations from common logger fields', () => {
  const parse = (line: string) => parseLogLine(line, 'stdout', 1, new Date());
  assert.deepEqual(eventLocation(parse('{"msg":"x","code.filepath":"/a/b.py","code.lineno":12}')), { file: '/a/b.py', line: 12 });
  assert.deepEqual(eventLocation(parse('{"msg":"x","source":{"file":"Svc.java","line":40}}')), { file: 'Svc.java', line: 40 });
  assert.deepEqual(eventLocation(parse('{"msg":"x","pathname":"/srv/app.py","lineno":"7"}')), { file: '/srv/app.py', line: 7 });
  assert.deepEqual(eventLocation(parse('{"msg":"x","caller":"file:///w/app.js:10:5"}')), { file: '/w/app.js', line: 10 });
  assert.deepEqual(eventLocation(parse('{"msg":"x","attributes":[{"key":"code.file.path","value":{"stringValue":"s.go"}},{"key":"code.line.number","value":{"intValue":"9"}}]}')), { file: 's.go', line: 9 });
  assert.equal(eventLocation(parse('{"msg":"x","caller":"main"}')), undefined);
});

test('builds a single-term query that the store applies to the site messages', () => {
  const [site] = extractLogSites('a.ts', 'logger.info(`user ${id} logged in (via "sso")`)');
  const query = siteQuery(site);
  assert.equal(query, 'message:/user.*logged\\s+in\\s+\\(via\\s+\\x22sso\\x22\\)/');
  const store = new LogStore();
  store.add(parseLogLine('user 7 logged in (via "sso")', 'stdout', 1, new Date()));
  store.add(parseLogLine('user 7 logged out', 'stdout', 2, new Date()));
  assert.deepEqual(store.page({ query }).events.map(item => item.id), [1]);
  const [long] = extractLogSites('a.ts', `logger.info("${'alpha '.repeat(30)}%s${' beta'.repeat(30)}%s tail")`);
  assert.ok(siteQuery(long).length <= 256);
});

test('tracks hits, errors, and recent samples per site', () => {
  const index = new LogSiteIndex();
  index.setFile('a.ts', extractLogSites('a.ts', 'logger.error(`payment ${id} declined`)'));
  const tracker = new LogSiteTracker(index);
  assert.equal(tracker.process([event(1, 'payment 1 declined', { level: 'error', timestampMs: 10 }), event(2, 'noise'),
    event(3, 'payment 2 declined', { level: 'warn' }), event(4, 'payment 3 declined'), event(5, 'payment 4 declined')]), true);
  const [stats] = tracker.stats.values();
  assert.deepEqual([stats.hits, stats.errors, stats.samples.map(sample => sample.id)], [4, 1, [3, 4, 5]]);
  assert.equal(tracker.process([event(5, 'payment 4 declined')]), false, 'already counted');
  tracker.reset();
  assert.equal(tracker.stats.size, 0);
});

test('statements keep the durations their recent events reported', () => {
  const index = new LogSiteIndex();
  index.setFile('a.ts', extractLogSites('a.ts', 'logger.info(`priced cart ${id}`)'));
  const tracker = new LogSiteTracker(index);
  const priced = (id: number, fields: Record<string, string | number | boolean>) => event(id, `priced cart ${id}`, { fields });
  tracker.process([priced(1, { durationMs: 40 }), priced(2, { duration_ms: '12.5' }), priced(3, {}), priced(4, { responseTime: 7 }),
    priced(5, { durationMs: -1 }), priced(6, { durationMs: 'slow' }), priced(7, { durationMs: true })]);
  const stats = () => [...tracker.stats.values()][0];
  assert.deepEqual(stats().durations?.map(entry => entry.ms), [40, 12.5, 7], 'aliases count; missing, negative and non-numeric values do not');
  assert.deepEqual(siteDurations(stats()), { count: 3, min: 7, p50: 12.5, p95: 40, p99: 40, max: 40 });
  tracker.evict(2);
  assert.deepEqual(stats().durations?.map(entry => entry.ms), [12.5, 7], 'evicted events take their durations with them');

  tracker.reset();
  tracker.process(Array.from({ length: 300 }, (_, i) => priced(i + 1, { durationMs: i + 1 })));
  const recent = siteDurations(stats())!;
  assert.deepEqual([recent.count, recent.min, recent.p50, recent.p95, recent.max], [256, 45, 172, 288, 300], 'only the latest 256 are kept');
  assert.equal(siteDurations({ hits: 1, errors: 0, samples: [], exact: 0 }), undefined);
});

test('evicting events subtracts what they counted', () => {
  const index = new LogSiteIndex();
  index.setFile('a.ts', extractLogSites('a.ts', 'logger.error(`payment ${id} declined`)\nlogger.info(`order ${id} shipped`)'));
  const tracker = new LogSiteTracker(index);
  tracker.findings = true;
  tracker.process([event(1, 'payment 1 declined', { level: 'error' }), event(2, 'noise'), event(3, 'order 3 shipped'),
    event(4, 'payment 4 declined'), event(5, 'payment 5 declined', { level: 'error' })]);
  const payment = () => tracker.stats.get(index.sitesIn('a.ts')[0].id);
  assert.deepEqual([payment()?.hits, payment()?.errors, payment()?.bareErrors, tracker.total], [3, 2, 2, 5]);
  assert.equal(tracker.siteOf(4), index.sitesIn('a.ts')[0].id);
  assert.equal(tracker.siteOf(2), null, 'counted but matched no statement');
  assert.equal(tracker.siteOf(9), undefined, 'not counted yet');
  assert.equal(tracker.evict(1), false, 'nothing older than the oldest retained event');
  assert.equal(tracker.evict(3), true);
  assert.deepEqual([payment()?.hits, payment()?.errors, payment()?.bareErrors, tracker.total], [2, 1, 1, 3]);
  tracker.evict(5);
  assert.equal(tracker.stats.has(index.sitesIn('a.ts')[1].id), false, 'a statement with no retained events is dropped');
  assert.deepEqual([payment()?.hits, payment()?.errors, tracker.total], [1, 1, 1]);
});

test('statements sharing common words still match their own messages', () => {
  const index = new LogSiteIndex();
  const source = Array.from({ length: 50 }, (_, i) => `logger.info(\`Processing request \${id} for tenant${i} completed\`)`).join('\n');
  index.setFile('a.ts', extractLogSites('a.ts', source));
  assert.equal(index.match(event(1, 'Processing request 9 for tenant17 completed'))?.site.line, 18);
  assert.equal(index.match(event(2, 'Processing request 9 for tenant99 completed')), undefined);
});

test('index changes invalidate cached matches', () => {
  const index = new LogSiteIndex();
  assert.equal(index.match(event(1, 'worker started successfully')), undefined);
  const before = index.version;
  index.setFile('w.py', extractLogSites('w.py', 'logger.info("worker started successfully")'));
  assert.notEqual(index.version, before);
  assert.equal(index.match(event(1, 'worker started successfully'))?.site.file, 'w.py');
  const unchanged = index.version;
  index.setFile('w.py', extractLogSites('w.py', 'logger.info("worker started successfully")'));
  assert.equal(index.version, unchanged);
  index.deleteFile('w.py');
  assert.equal(index.match(event(1, 'worker started successfully')), undefined);
});

test('skips logging calls that appear in comments', () => {
  const source = [
    '// logger.info("commented out entirely")',
    ' * Example: logger.warn("from a doc comment")',
    '# logger.error("python comment")',
    'const url = "http://x"; logger.info("after a url string")',
    '/* logger.info("inside a block comment")',
    '   logger.info("still inside the block") */',
    'logger.info("real call after the block")',
    'foo(); // see logger.info("trailing comment example")'
  ].join('\n');
  assert.deepEqual(extractLogSites('a.ts', source).map(site => site.template), ['after a url string', 'real call after the block']);
});

test('matches templates whose longest word touches a placeholder', () => {
  const index = new LogSiteIndex();
  index.setFile('a.py', extractLogSites('a.py', 'logger.info(f"cache_miss_{key} while loading")\nlogger.info(f"retrying{attempt}times")'));
  assert.equal(index.match(event(1, 'cache_miss_user42 while loading'))?.site.line, 1);
  assert.equal(index.match(event(2, 'retrying3times')), undefined, 'no word with real boundaries means location-only matching');
});

test('reads concatenated messages, format wrappers, and messages after a context argument', () => {
  const cases: [string, string, string][] = [
    ['A.java', 'log.warn("Order " + order.getId() + " rejected by " + svc);', 'Order … rejected by …'],
    ['a.ts', 'logger.info(user.name + " signed in from " + req.ip)', '… signed in from …'],
    ['a.py', 'print("Total: " + str(total) + " items")', 'Total: … items'],
    ['a.ts', 'logger.info({ userId, plan: getPlan(user) }, "subscription renewed")', 'subscription renewed'],
    ['A.java', 'log.info(AUDIT, "Password changed for {}", user)', 'Password changed for …'],
    ['A.java', 'LOG.error(String.format("Job %s failed after %d tries", job, n))', 'Job … failed after … tries'],
    ['a.go', 'log.Println(fmt.Sprintf("worker %d stopped", id))', 'worker … stopped'],
    ['A.cs', 'Console.WriteLine(string.Format("Saved {0} rows", count));', 'Saved … rows'],
    ['a.ts', 'console.log("a " + "b" + "c")', 'a bc']
  ];
  for (const [file, source, template] of cases) assert.equal(extractLogSites(file, source)[0]?.template, template, source);
  assert.deepEqual(extractLogSites('a.ts', 'logger.info(user)\nlogger.info(a, b)\nconsole.log(x + y)'), []);
  const index = new LogSiteIndex();
  index.setFile('A.java', extractLogSites('A.java', 'log.warn("Order " + order.getId() + " rejected by " + svc);'));
  assert.equal(index.match(event(1, 'Order 1234 rejected by fraud-check'))?.site.file, 'A.java');
});

test('attribution stays fast when a message repeats most of a template', () => {
  const index = new LogSiteIndex();
  index.setFile('b.js', extractLogSites('b.js', 'log.info(`a ${a} a ${b} a ${c} a ${d} a ${f} a ${g} epsilonzz ${e} zeta`)'));
  const message = ('epsilonzz ' + 'a b c d '.repeat(100)).slice(0, 512);
  const started = Date.now();
  assert.equal(index.match(event(1, message)), undefined);
  assert.ok(Date.now() - started < 1000, 'no backtracking blow-up');
  assert.equal(index.match(event(2, 'a 1 a 2 a 3 a 4 a 5 a   6 epsilonzz 7 zeta'))?.site.line, 1);
});

test('indexing a minified single-line file stays linear', () => {
  const text = 'var a=1;' + 'x.log(y);'.repeat(50000) + 'x.info("minified message here"); // x.info("commented out here")';
  const started = Date.now();
  const sites = extractLogSites('bundle.min.js', text);
  assert.ok(Date.now() - started < 1000, 'comment detection scans each line once');
  assert.deepEqual(sites.map(site => site.template), ['minified message here']);
});
