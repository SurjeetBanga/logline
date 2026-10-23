import { fork, spawn, type ChildProcess } from 'node:child_process';
import { isBuiltin } from 'node:module';
import * as path from 'node:path';
import type { SqlValue } from '../../core/remote-query';
import { timedOut, type QueryOptions, type Row, type SqlDriver } from './types';
const cancelled = () => new Error('The query was cancelled.');

interface Pending {
  resolve(rows: Row[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs queries with the editor runtime's built-in SQLite in a child process.
 * A query that times out or is cancelled ends the process; the next query
 * starts a new one. An idle process ends after a minute.
 */
export class SqliteProcessDriver implements SqlDriver {
  readonly dialect = 'sqlite';
  private child?: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly file: string,
    private readonly runtime = process.execPath,
    private readonly idleMs = 60000,
  ) {}

  query(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]> {
    if (options.signal?.aborted) return Promise.reject(cancelled());
    clearTimeout(this.idle);
    const child = this.start();
    const id = ++this.next;
    return new Promise<Row[]>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(timedOut(options.timeoutMs)), options.timeoutMs);
      options.signal?.addEventListener('abort', () => this.stop(cancelled()), { once: true });
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, sql, params });
    });
  }

  close(): Promise<void> {
    this.stop(new Error('The connection was closed.'));
    return Promise.resolve();
  }

  private start(): ChildProcess {
    if (this.child) return this.child;
    // The extension host's runtime is Electron; ELECTRON_RUN_AS_NODE runs it as Node.js.
    const child = fork(path.join(__dirname, 'sqlite-child.js'), [this.file], {
      execPath: this.runtime,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.unref();
    child.channel?.unref();
    child.on('message', (message: { id: number; rows?: Row[]; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.rows) pending.resolve(message.rows);
      else pending.reject(new Error(message.error ?? 'The query failed.'));
      if (!this.pending.size) {
        this.idle = setTimeout(() => this.stop(new Error('The connection was idle.')), this.idleMs);
        this.idle.unref?.();
      }
    });
    const failed = (error: Error) => {
      if (this.child === child) this.stop(error);
    };
    child.on('error', failed);
    child.on('exit', (code, signal) => failed(new Error(`The SQLite process stopped (${signal ?? `code ${code}`}).`)));
    return (this.child = child);
  }

  /** End the current process and fail what it was running. */
  private stop(error: Error): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    child?.kill('SIGKILL');
  }
}

/** An SQL literal for a parameter value. */
function literal(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Runs queries with the `sqlite3` command, for editor runtimes without
 * built-in SQLite. Each query is one read-only process.
 */
export class SqliteCliDriver implements SqlDriver {
  readonly dialect = 'sqlite';
  private readonly running = new Set<ChildProcess>();

  constructor(
    private readonly file: string,
    private readonly command = 'sqlite3',
  ) {}

  query(sql: string, params: SqlValue[], options: QueryOptions): Promise<Row[]> {
    // The shell binds `?` parameters, in order, to the keys ?1, ?2, … of its
    // parameter table, which lives in the writable temp schema.
    const bindings = params.map((value, index) => `('?${index + 1}', ${literal(value)})`).join(', ');
    const script = [
      '.parameter init',
      ...(bindings ? [`INSERT INTO temp.sqlite_parameters(key, value) VALUES ${bindings};`] : []),
      `${sql}\n;`,
      '',
    ].join('\n');
    return new Promise<Row[]>((resolve, reject) => {
      const child = spawn(this.command, ['-readonly', '-bail', '-json', this.file], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.running.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill();
      };
      const timer = setTimeout(() => stop(timedOut(options.timeoutMs)), options.timeoutMs);
      options.signal?.addEventListener('abort', () => stop(cancelled()), { once: true });
      child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) =>
        stop(
          error.code === 'ENOENT'
            ? new Error(
                "This editor's runtime has no built-in SQLite and the sqlite3 command was not found. Update the editor, or install sqlite3 on your PATH.",
              )
            : error,
        ),
      );
      child.on('close', (code) => {
        clearTimeout(timer);
        this.running.delete(child);
        if (failure) return reject(failure);
        const message = Buffer.concat(stderr)
          .toString('utf8')
          .trim()
          .replace(/^(?:Parse error|Runtime error|Error)(?: near line \d+)?: /, '');
        if (code !== 0) return reject(new Error(message || `sqlite3 exited with code ${code}.`));
        const text = Buffer.concat(stdout).toString('utf8').trim();
        try {
          resolve(text ? (JSON.parse(text) as Row[]) : []);
        } catch {
          reject(new Error('sqlite3 returned output that is not JSON. SQLite 3.33 or later is needed.'));
        }
      });
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(script);
    });
  }

  close(): Promise<void> {
    for (const child of this.running) child.kill();
    return Promise.resolve();
  }
}

/** Open a database file read-only with the best SQLite the editor runtime has. */
export function openSqlite(file: string): SqlDriver {
  return isBuiltin('node:sqlite') ? new SqliteProcessDriver(file) : new SqliteCliDriver(file);
}
