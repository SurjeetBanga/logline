// Child process entry for the SQLite driver: one read-only database per
// process. A process, unlike a worker thread, can be ended while SQLite is in
// the middle of a query, so a query that runs too long cannot hang the editor.
interface Statement {
  all(...params: unknown[]): Record<string, unknown>[];
  setReadBigInts(enabled: boolean): void;
}
interface Database {
  prepare(sql: string): Statement;
}
type SqliteModule = { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database };

const file = process.argv[2];
// Read as BigInt so integers past 2^53 cannot throw; sent as numbers whenever they fit.
const value = (item: unknown) => (typeof item === 'bigint' && Number.isSafeInteger(Number(item)) ? Number(item) : item);
let database: Database | undefined;
process.on('message', ({ id, sql, params }: { id: number; sql: string; params: unknown[] }) => {
  try {
    if (!database) {
      const sqlite = require('node:sqlite') as SqliteModule;
      database = new sqlite.DatabaseSync(file, { readOnly: true });
    }
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    const rows = statement
      .all(...params)
      .map((row) => Object.fromEntries(Object.entries(row).map(([name, item]) => [name, value(item)])));
    process.send!({ id, rows });
  } catch (error) {
    process.send!({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
// The editor closed or restarted the extension host.
process.on('disconnect', () => process.exit(0));

// A module, so the names above stay out of the global scope.
export {};
