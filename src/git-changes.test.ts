import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChangedLines } from './core/changed-lines';
import { withVscode } from './test/vscode-mock';

type Listener = () => void;
const event = <T = void>() => {
  const listeners = new Set<(value: T) => void>();
  return { fire: (value: T) => { for (const listener of listeners) listener(value); },
    on: (listener: (value: T) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } };
};

test('git changes follow the working tree of each repository', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'logline-git-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    writeFileSync(join(root, 'app.ts'), ['one', 'two', 'three', 'four'].join('\n') + '\n');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    writeFileSync(join(root, 'app.ts'), ['one', 'TWO', 'three', 'four'].join('\n') + '\n');
    writeFileSync(join(root, 'new.ts'), 'fresh\n');

    const uri = (file: string) => ({ scheme: 'file', fsPath: join(root, file) });
    const stateChanged = event();
    const repository = {
      rootUri: { scheme: 'file', fsPath: root },
      state: {
        HEAD: { commit: git('rev-parse', 'HEAD').trim() },
        indexChanges: [] as { uri: unknown; status: number }[],
        workingTreeChanges: [{ uri: uri('app.ts'), status: 5 }],
        untrackedChanges: [{ uri: uri('new.ts'), status: 7 }],
        onDidChange: (listener: Listener) => stateChanged.on(listener)
      },
      diffWith: async (ref: string, path: string) => git('diff', ref, '--', path)
    };
    const saved = event<{ uri: { scheme: string; fsPath: string } }>();
    const api = { repositories: [repository], onDidOpenRepository: () => ({ dispose() { } }), onDidCloseRepository: () => ({ dispose() { } }) };
    const { GitChanges } = withVscode({
      extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => api } }) },
      workspace: { onDidSaveTextDocument: (listener: (document: { uri: { scheme: string; fsPath: string } }) => void) => saved.on(listener) }
    }, () => require('./vscode/git-changes') as typeof import('./vscode/git-changes'));

    const changes = new ChangedLines();
    let notified: Listener = () => { };
    // The tracker's own timers are unref'd; this one keeps the process alive while waiting, and fails a wait that never ends.
    const next = () => new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('GitChanges reported no change')), 10000);
      notified = () => { clearTimeout(guard); resolve(); };
    });
    let ready = next();
    const tracker = new GitChanges(changes, () => notified());
    try {
      await ready;
      assert.deepEqual(tracker.status(), { files: 2 });
      assert.equal(changes.contains(join(root, 'app.ts'), 2), true);
      assert.equal(changes.contains(join(root, 'app.ts'), 3), false);
      assert.equal(changes.contains('new.ts', 1), true, 'an untracked file is changed throughout');

      // Saving a changed file diffs it again.
      ready = next();
      writeFileSync(join(root, 'app.ts'), ['one', 'TWO', 'three', 'FOUR'].join('\n') + '\n');
      saved.fire({ uri: uri('app.ts') });
      await ready;
      assert.equal(changes.contains('app.ts', 4), true);

      // An agent or formatter rewrites the file without a save event; git reports a change and the file is diffed again.
      ready = next();
      writeFileSync(join(root, 'app.ts'), ['ONE', 'two', 'three', 'four'].join('\n') + '\n');
      utimesSync(join(root, 'app.ts'), new Date(), new Date(Date.now() + 5000));
      stateChanged.fire();
      await ready;
      assert.equal(changes.contains('app.ts', 1), true, 'the new edit counts');
      assert.equal(changes.contains('app.ts', 4), false, 'the reverted edit no longer counts');

      // A commit leaves nothing changed.
      ready = next();
      git('add', '.');
      git('commit', '-q', '-m', 'done');
      repository.state.HEAD = { commit: git('rev-parse', 'HEAD').trim() };
      repository.state.workingTreeChanges = [];
      repository.state.untrackedChanges = [];
      stateChanged.fire();
      await ready;
      assert.deepEqual(tracker.status(), { files: 0 });
      assert.equal(changes.fileCount, 0);
    } finally { tracker.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
