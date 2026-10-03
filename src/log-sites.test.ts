import assert from 'node:assert/strict';
import test from 'node:test';
import { eventLocation, extractLogSites, LogSiteIndex, LogSiteTracker, siteQuery } from './core/log-sites';
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
