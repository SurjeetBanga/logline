import assert from 'node:assert/strict';
import test from 'node:test';
import { ChangedLines, ChangeScope, parseDiffRanges, touchesChanges, WHOLE_FILE, type LineRanges } from './changed-lines';
import { CHANGED_TERM, hasChangedScope, withChangedScope } from './changed-query';
import { extractLogSites, LogSiteIndex } from './log-sites';
import { LogStore } from './log-store';
import { matchesQuery } from './query';
import type { LogEvent } from './types';
import { SessionRegistry } from '../capture/session-registry';
import { AgentLogAccess } from '../vscode/agent-access';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -3,4 +3,5 @@ import x',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  '@@ -20,3 +21,2 @@ function f() {',
  ' keep();',
  '-removed();',
  ' keep();',
  '\\ No newline at end of file'
].join('\n');

function changedAt(files: Record<string, LineRanges>): ChangedLines {
  const changes = new ChangedLines();
  changes.set(new Map(Object.entries(files)));
  return changes;
}

test('a diff marks the lines it adds or changes, and where it removed lines', () => {
  // Lines 4 and 5 replace and add; the removal after line 21 marks line 22.
  assert.deepEqual(parseDiffRanges(DIFF), [[4, 5], [22, 22]]);
  assert.deepEqual(parseDiffRanges(''), []);
  assert.deepEqual(parseDiffRanges('@@ -0,0 +1,2 @@\n+one\n+two\n'), [[1, 2]]);
});

test('changed lines match absolute, relative and Windows paths by their ending', () => {
  const changes = changedAt({ '/repo/src/app.ts': [[4, 5]], 'C:\\work\\lib\\util.py': WHOLE_FILE });
  assert.equal(changes.fileCount, 2);
  assert.equal(changes.contains('/repo/src/app.ts', 4), true);
  assert.equal(changes.contains('src/app.ts', 5), true);
  assert.equal(changes.contains('./src/app.ts', 5), true);
  assert.equal(changes.contains('file:///repo/src/app.ts', 4), true);
  assert.equal(changes.contains('src/app.ts', 6), false);
  assert.equal(changes.contains('other/app.ts', 4), false);
  assert.equal(changes.contains('pp.ts', 4), false);
  assert.equal(changes.contains('c:/work/lib/util.py', 9000), true);
  assert.equal(changes.contains('lib\\util.py', 1), true);
});

test('setting the same ranges again keeps the version', () => {
  const changes = changedAt({ '/repo/a.ts': [[1, 2]] });
  const version = changes.version;
  changes.set(new Map([['/repo/a.ts', [[1, 2]]]]));
  assert.equal(changes.version, version);
  changes.set(new Map([['/repo/a.ts', [[1, 3]]]]));
  assert.notEqual(changes.version, version);
});

test('an event touches changes through its location, its log statement, or a stack frame', () => {
  const changes = changedAt({ '/repo/src/app.ts': [[10, 12]], '/repo/src/db.ts': [[40, 40]] });
  const sites = new LogSiteIndex();
  sites.setFile('src/app.ts', extractLogSites('src/app.ts', '\n'.repeat(10) + 'logger.info("order placed for customer")'));

  assert.equal(touchesChanges({ id: 1, level: 'info', message: 'x', location: { file: '/repo/src/app.ts', line: 12 } }, changes), true);
  assert.equal(touchesChanges({ id: 2, level: 'info', message: 'x', location: { file: '/repo/src/app.ts', line: 30 } }, changes), false);
  assert.equal(touchesChanges({ id: 3, level: 'info', message: 'x', fields: { caller: 'src/db.ts:40' } }, changes), true);
  assert.equal(touchesChanges({ id: 4, level: 'info', message: 'order placed for customer 7' }, changes, sites), true);
  assert.equal(touchesChanges({ id: 5, level: 'info', message: 'order placed for customer 7' }, changes), false);
  const raw = 'TypeError: boom\n    at load (/repo/node_modules/lib/index.js:3:1)\n    at query (/repo/src/db.ts:40:7)';
  assert.equal(touchesChanges({ id: 6, level: 'error', message: 'TypeError: boom', raw }, changes), true);
  const json = (line: number) => JSON.stringify({ level: 'error', err: { type: 'Error', message: 'boom', stack: `Error: boom\n    at query (/repo/src/db.ts:${line}:7)` } });
  assert.equal(touchesChanges({ id: 7, level: 'error', message: 'boom', raw: json(40), isJson: true }, changes), true);
  assert.equal(touchesChanges({ id: 7, level: 'error', message: 'boom', raw: json(41), isJson: true }, changes), false);
  assert.equal(touchesChanges({ id: 8, level: 'info', message: 'x', location: { file: '/repo/src/app.ts', line: 11 } }, new ChangedLines()), false);
});

test('changed:true asks the scope, and without one matches nothing', () => {
  const event: LogEvent = { id: 1, level: 'error', message: 'boom' };
  assert.equal(matchesQuery(event, 'changed:true'), false);
  assert.equal(matchesQuery(event, '-changed:true'), true);
  assert.equal(matchesQuery(event, 'changed:false'), true);
  assert.equal(matchesQuery(event, 'changed:true', undefined, () => true), true);
  assert.equal(matchesQuery(event, 'level:error changed:true', undefined, () => true), true);
  assert.equal(matchesQuery(event, 'level:warn changed:true', undefined, () => true), false);
  // Any other value is an ordinary field search.
  assert.equal(matchesQuery({ ...event, fields: { changed: 'yes' } }, 'changed:yes'), true);
});

test('the store reruns a changed:true search when the diff changes', () => {
  const changes = changedAt({ '/repo/a.ts': [[5, 5]] });
  const store = new LogStore();
  store.changeScope = new ChangeScope(changes);
  store.add({ id: 1, level: 'error', message: 'one', location: { file: '/repo/a.ts', line: 5 } });
  store.add({ id: 2, level: 'error', message: 'two', location: { file: '/repo/a.ts', line: 9 } });
  assert.deepEqual(store.page({ query: 'changed:true' }).events.map(event => event.id), [1]);
  assert.deepEqual(store.page({ query: '-changed:true' }).events.map(event => event.id), [2]);
  changes.set(new Map([['/repo/a.ts', [[9, 9]]]]));
  assert.deepEqual(store.page({ query: 'changed:true' }).events.map(event => event.id), [2]);
  assert.deepEqual(store.reversePage({ query: 'changed:true' }).events.map(event => event.id), [2]);
});

test('the toggle adds changed:true to every alternative and removes it again', () => {
  assert.equal(withChangedScope('', true), CHANGED_TERM);
  assert.equal(withChangedScope('level:error', true), 'level:error changed:true');
  assert.equal(withChangedScope('a OR b', true), 'a changed:true OR b changed:true');
  assert.equal(withChangedScope('a changed:true OR b', true), 'a changed:true OR b changed:true');
  assert.equal(withChangedScope('a changed:true OR b changed:true', false), 'a OR b');
  assert.equal(withChangedScope('changed:true', false), '');
  assert.equal(hasChangedScope('a changed:true OR b changed:true'), true);
  assert.equal(hasChangedScope('a changed:true OR b'), false);
  assert.equal(hasChangedScope('-changed:true'), false);
  assert.equal(hasChangedScope(''), false);
});

test('agents can limit searches to changed code and learn whether there is a diff', () => {
  const changes = changedAt({ '/repo/a.ts': [[5, 5]] });
  const store = new LogStore();
  store.changeScope = new ChangeScope(changes);
  store.add({ id: 1, serverId: 'api', sessionId: 's', level: 'error', message: 'one', location: { file: '/repo/a.ts', line: 5 } });
  store.add({ id: 2, serverId: 'api', sessionId: 's', level: 'info', message: 'two', location: { file: '/repo/a.ts', line: 9 } });
  store.add({ id: 3, serverId: 'api', sessionId: 's', level: 'info', message: 'three' });
  const access = new AgentLogAccess(store, new SessionRegistry(), () => 3);
  const { shareId } = access.share(['api']);
  const all = access.search({ shareId: shareId! });
  assert.equal(all.events.length, 3);
  assert.equal('changedFiles' in all, false);
  const scoped = access.search({ shareId: shareId!, changedOnly: true });
  assert.deepEqual(scoped.events.map(event => event.id), [1]);
  assert.equal(scoped.changedFiles, null);
  access.changes = () => ({ files: 1 });
  const either = access.search({ shareId: shareId!, query: 'one OR two', changedOnly: true });
  assert.deepEqual(either.events.map(event => event.id), [1]);
  assert.equal(either.changedFiles, 1);
  assert.throws(() => access.search({ shareId: shareId!, changedOnly: 'yes' as unknown as boolean }), /changedOnly must be a boolean/);
  assert.throws(() => access.search({ shareId: shareId!, query: 'x'.repeat(250), changedOnly: true }), /at most 256 characters/);
});
