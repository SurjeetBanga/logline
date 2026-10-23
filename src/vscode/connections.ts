import * as path from 'node:path';
import * as vscode from 'vscode';
import { PostgresDriver } from '../capture/connectors/postgres-driver';
import { SqlConnector } from '../capture/connectors/sql';
import { openSqlite } from '../capture/connectors/sqlite-driver';
import { errorText, type SqlDriver } from '../capture/connectors/types';
import type { RemoteSource, RemoteTarget } from '../capture/remote-source';
import {
  connectionLabel,
  connectionSourceId,
  MAPPED_FIELDS,
  normalizeConnections,
  rangeMs,
  RANGE_CHOICES,
  secretKey,
  suggestMapping,
  type ColumnInfo,
  type ConnectionConfig,
  type LogTableMapping,
  type MappedField,
  type PostgresConnection,
} from '../core/connections';
import { slugify } from '../core/server-config';
import type { Settings } from '../core/settings';
import type { ConnectionView } from '../protocol/messages';

type Secrets = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;

const ROLE_LABELS: Record<MappedField, string> = {
  timestamp: 'Time',
  level: 'Level',
  message: 'Message',
  service: 'Service',
  traceId: 'Trace id',
};

/** Postgres refused the user name or password. */
const authFailed = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && (error.code === '28P01' || error.code === '28000');

/**
 * Saved connections (`logline.connections`): opens their databases on first
 * use, keeps passwords in secret storage, and runs the commands that add,
 * test, search, and tail them.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly open = new Map<string, { key: string; connector: SqlConnector }>();

  constructor(
    private readonly config: Settings,
    readonly remote: RemoteSource,
    private readonly secrets: Secrets | undefined,
    /** Select a source, and one of its runs, in the Logs panel. */
    private readonly showSource: (sourceId: string, runId?: string) => Promise<void>,
  ) {}

  list(): ConnectionConfig[] {
    return this.config.get<ConnectionConfig[]>('connections', []);
  }

  find(id: string): ConnectionConfig | undefined {
    return this.list().find((connection) => connection.id === id);
  }

  views(): ConnectionView[] {
    return this.list().map((connection) => {
      const last = this.remote.last(connection.id);
      return {
        id: connection.id,
        sourceId: connectionSourceId(connection.id),
        label: connectionLabel(connection),
        type: connection.type,
        mapped: connection.logs !== undefined,
        tailing: this.remote.tailing(connection.id),
        ...(last ? { last } : {}),
      };
    });
  }

  /** Close connections whose settings changed, and stop the runs of removed ones. */
  refresh(): void {
    const current = new Map(this.list().map((connection) => [connection.id, JSON.stringify(connection)]));
    for (const [id, open] of this.open) {
      if (current.get(id) === open.key) continue;
      this.open.delete(id);
      void open.connector.dispose();
      if (!current.has(id)) this.remote.stopConnection(id);
    }
  }

  /** A SQLite path from settings, relative to the first workspace folder unless absolute. */
  resolvePath(file: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const expanded = file.replace(/\$\{workspaceFolder\}/g, folder ?? '');
    return path.isAbsolute(expanded) ? expanded : path.resolve(folder ?? '', expanded);
  }

  private async driver(connection: ConnectionConfig, password?: string): Promise<SqlDriver> {
    if (connection.type === 'sqlite') return openSqlite(this.resolvePath(connection.path));
    return new PostgresDriver(connection, password ?? (await this.secrets?.get(secretKey(connection))));
  }

  private async connector(connection: ConnectionConfig): Promise<SqlConnector> {
    const key = JSON.stringify(connection);
    const open = this.open.get(connection.id);
    if (open?.key === key) return open.connector;
    if (open) void open.connector.dispose();
    const connector = new SqlConnector(
      connection,
      await this.driver(connection),
      () => this.config.get('connectionTimeoutSeconds', 10) * 1000,
    );
    this.open.set(connection.id, { key, connector });
    return connector;
  }

  private async target(connection: ConnectionConfig): Promise<RemoteTarget> {
    return {
      id: connection.id,
      sourceId: connectionSourceId(connection.id),
      label: connectionLabel(connection),
      connector: await this.connector(connection),
    };
  }

  private trusted(action: string): boolean {
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showWarningMessage(`Trust this workspace before ${action}.`);
    return false;
  }

  /** The connection to act on: the one named, else the only one, else one the person picks. */
  private async pick(id: string | undefined, title: string, mappedOnly = false): Promise<ConnectionConfig | undefined> {
    const connections = this.list().filter((connection) => !mappedOnly || connection.logs);
    if (id) {
      const connection = this.find(id);
      if (!connection) void vscode.window.showWarningMessage('That connection is no longer in logline.connections.');
      return connection;
    }
    if (!connections.length) {
      const add = await vscode.window.showInformationMessage(
        mappedOnly ? 'No connection has a log table to search.' : 'No connections yet.',
        'Add Connection…',
      );
      if (add) await this.add();
      return undefined;
    }
    if (connections.length === 1) return connections[0];
    const choice = await vscode.window.showQuickPick(
      connections.map((connection) => ({
        label: connectionLabel(connection),
        description: connection.logs?.table,
        connection,
      })),
      { title },
    );
    return choice?.connection;
  }

  /** Report a failed fetch, offering to save a password when Postgres refused the login. */
  private async failed(connection: ConnectionConfig, error: string | undefined, cause?: unknown): Promise<void> {
    if (!error) return;
    if (connection.type === 'postgres' && (authFailed(cause) || /password/i.test(error))) {
      const saved = (await this.secrets?.get(secretKey(connection))) !== undefined;
      const choice = await vscode.window.showErrorMessage(
        `${connectionLabel(connection)}: the server ${saved ? 'refused the saved password' : 'needs a password'} for ${connection.user} (${error}).`,
        'Enter Password…',
      );
      if (choice) await this.askPassword(connection);
      return;
    }
    void vscode.window.showErrorMessage(`${connectionLabel(connection)}: ${error}`);
  }

  private async askPassword(connection: PostgresConnection): Promise<void> {
    const password = await vscode.window.showInputBox({
      title: `Password for ${connection.user}@${connection.host}/${connection.database}`,
      password: true,
      ignoreFocusOut: true,
      prompt: 'Kept in VS Code secret storage, never in settings.',
    });
    if (password === undefined) return;
    await this.secrets?.store(secretKey(connection), password);
    // The next query reconnects with the new password.
    const open = this.open.get(connection.id);
    this.open.delete(connection.id);
    void open?.connector.dispose();
  }

  /** Fetch the newest rows that match a search over a range into a new run. */
  async fetch(id: string, query: string, range: string): Promise<void> {
    if (!this.trusted('searching a connection')) return;
    const connection = await this.pick(id, 'Search connection', true);
    if (!connection) return;
    const span = rangeMs(range) ?? 3600000;
    const now = Date.now();
    try {
      const info = await this.remote.fetch(await this.target(connection), {
        query,
        fromMs: now - span,
        toMs: now,
        title: `${query.trim() || 'All rows'} · last ${range}`,
        // The panel shows the new run, not every earlier one of the same search.
        started: (runId) => void this.showSource(connectionSourceId(connection.id), runId),
      });
      await this.failed(connection, info.error);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  /** Run SQL typed by the person into a new run. */
  async runSql(id?: string): Promise<void> {
    if (!this.trusted('running SQL')) return;
    const connection = await this.pick(id, 'Run SQL on');
    if (!connection) return;
    const sql = await vscode.window.showInputBox({
      title: `Run SQL on ${connectionLabel(connection)}`,
      prompt: `One SELECT, read-only. At most ${this.config.get('connectionMaxRows', 5000).toLocaleString()} rows.`,
      placeHolder: connection.logs
        ? `SELECT * FROM ${connection.logs.table} WHERE ${connection.logs.level ?? 'level'} = 'ERROR'`
        : 'SELECT * FROM logs ORDER BY created_at DESC',
      ignoreFocusOut: true,
    });
    if (!sql?.trim()) return;
    try {
      const info = await this.remote.fetch(await this.target(connection), {
        query: '',
        sql,
        title: `SQL: ${sql.trim().replace(/\s+/g, ' ').slice(0, 80)}`,
        started: (runId) => void this.showSource(connectionSourceId(connection.id), runId),
      });
      await this.failed(connection, info.error);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  /** Start or stop reading new rows from a connection as they are added. */
  async tail(id: string | undefined, query: string, enabled?: boolean): Promise<void> {
    const connection = await this.pick(id, 'Tail connection', true);
    if (!connection) return;
    const on = enabled ?? !this.remote.tailing(connection.id);
    if (!on) {
      this.remote.stopTails(connection.id);
      return;
    }
    if (!this.trusted('tailing a connection') || this.remote.tailing(connection.id)) return;
    try {
      const runId = this.remote.tail(await this.target(connection), query, `Tail: ${query.trim() || 'all rows'}`);
      await this.showSource(connectionSourceId(connection.id), runId);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  /** The SQL a search would run, for the Logs panel to show before it runs. */
  async preview(
    id: string,
    query: string,
    range: string,
  ): Promise<{ statement?: string; local: string[]; error?: string }> {
    const connection = this.find(id);
    if (!connection?.logs || !vscode.workspace.isTrusted) return { local: [] };
    const span = rangeMs(range) ?? 3600000;
    const now = Date.now();
    try {
      return await (await this.connector(connection)).preview(query, now - span, now);
    } catch (error) {
      return { local: [], error: errorText(error) };
    }
  }

  /** Ask for a search and a range in the Command Palette, then fetch. */
  async query(id?: string): Promise<void> {
    if (!this.trusted('searching a connection')) return;
    const connection = await this.pick(id, 'Search connection', true);
    if (!connection) return;
    const query = await vscode.window.showInputBox({
      title: `Search ${connectionLabel(connection)}`,
      prompt: 'A Logline search, such as level:error user_id:42. Leave empty for every row.',
      ignoreFocusOut: true,
    });
    if (query === undefined) return;
    const range = await vscode.window.showQuickPick(
      RANGE_CHOICES.map((label) => ({ label, description: label === '1h' ? 'default' : undefined })),
      { title: 'Time range' },
    );
    if (!range) return;
    await this.fetch(connection.id, query, range.label);
  }

  async test(id?: string): Promise<void> {
    const connection = await this.pick(id, 'Test connection');
    if (!connection || !this.trusted('testing a connection')) return;
    try {
      const detail = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${connectionLabel(connection)}…` },
        async () => (await this.connector(connection)).test(),
      );
      void vscode.window.showInformationMessage(`${connectionLabel(connection)}: connected · ${detail}`);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  async remove(id?: string): Promise<void> {
    const connection = await this.pick(id, 'Remove connection');
    if (!connection) return;
    const answer = await vscode.window.showWarningMessage(
      `Remove ${connectionLabel(connection)}?`,
      { modal: true, detail: 'Fetched rows stay in the Logs panel until cleared.' },
      'Remove',
    );
    if (answer !== 'Remove') return;
    const settings = vscode.workspace.getConfiguration('logline');
    const inspected = settings.inspect<unknown[]>('connections');
    for (const [target, value] of [
      [vscode.ConfigurationTarget.WorkspaceFolder, inspected?.workspaceFolderValue],
      [vscode.ConfigurationTarget.Workspace, inspected?.workspaceValue],
      [vscode.ConfigurationTarget.Global, inspected?.globalValue],
    ] as const) {
      if (!Array.isArray(value)) continue;
      const kept = value.filter(
        (item) => !(item && typeof item === 'object' && (item as { id?: unknown }).id === connection.id),
      );
      if (kept.length !== value.length) await settings.update('connections', kept, target);
    }
    if (connection.type === 'postgres') await this.secrets?.delete(secretKey(connection));
    this.remote.stopConnection(connection.id);
  }

  /** Walk through adding a connection: the database, a test, and which table and columns hold logs. */
  async add(): Promise<void> {
    if (!this.trusted('adding a connection')) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'SQLite', description: 'A database file on this machine', type: 'sqlite' as const },
        { label: 'Postgres', description: 'A server, by host, database, and user', type: 'postgres' as const },
      ],
      { title: 'Add Connection (1/4): Database' },
    );
    if (!kind) return;
    const draft = kind.type === 'sqlite' ? await this.sqliteDraft() : await this.postgresDraft();
    if (!draft) return;
    const { connection, password } = draft;
    const driver = await this.driver(connection, password);
    const probe = new SqlConnector(connection, driver, () => this.config.get('connectionTimeoutSeconds', 10) * 1000);
    try {
      let tables: string[];
      try {
        tables = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Connecting to ${connectionLabel(connection)}…` },
          async () => {
            await probe.test();
            return probe.tables();
          },
        );
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not connect: ${errorText(error)}`);
        return;
      }
      const logs = await this.chooseMapping(probe, tables);
      if (logs === undefined) return;
      const label = await vscode.window.showInputBox({
        title: 'Add Connection (4/4): Name',
        prompt: 'Shown in the Logs panel’s source list.',
        value: connection.label,
        ignoreFocusOut: true,
      });
      if (!label?.trim()) return;
      const ids = new Set(this.list().map((existing) => existing.id));
      const base = slugify(label);
      let id = base;
      for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
      const saved: ConnectionConfig = {
        ...connection,
        id,
        label: label.trim(),
        ...(logs ? { logs } : {}),
      };
      if (saved.type === 'postgres' && password) await this.secrets?.store(secretKey(saved), password);
      const settings = vscode.workspace.getConfiguration('logline');
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      const inspected = settings.inspect<unknown[]>('connections');
      const current =
        target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
      await settings.update('connections', [...(Array.isArray(current) ? current : []), saved], target);
      await this.showSource(connectionSourceId(id));
      void vscode.window.showInformationMessage(
        logs
          ? `Added ${connectionLabel(saved)}. Pick a time range and press Run in the Logs panel.`
          : `Added ${connectionLabel(saved)}. Use Run SQL in the Logs panel to query it.`,
      );
    } finally {
      await probe.dispose();
    }
  }

  private async sqliteDraft(): Promise<{ connection: ConnectionConfig; password?: string } | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const [file] =
      (await vscode.window.showOpenDialog({
        title: 'Add Connection (2/4): SQLite database',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Connect',
        defaultUri: folder,
        filters: { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] },
      })) ?? [];
    if (!file) return undefined;
    if (file.scheme !== 'file') {
      void vscode.window.showWarningMessage('Logline can only open SQLite files on the local filesystem.');
      return undefined;
    }
    // A file inside the workspace is saved relative to it, so the setting works on every clone.
    const relative = folder ? path.relative(folder.fsPath, file.fsPath) : '';
    const inside = folder && relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    return {
      connection: {
        id: 'draft',
        label: path.basename(file.fsPath).replace(/\.(?:db|sqlite3?|db3)$/i, ''),
        type: 'sqlite',
        path: inside ? relative.split(path.sep).join('/') : file.fsPath,
      },
    };
  }

  private async postgresDraft(): Promise<{ connection: ConnectionConfig; password?: string } | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'Add Connection (2/4): Postgres',
      prompt: 'A connection URL. A password in it is moved to VS Code secret storage.',
      placeHolder: 'postgres://user@localhost:5432/database',
      ignoreFocusOut: true,
      validateInput: (value) => (parsePostgresUrl(value) ? undefined : 'Enter postgres://user@host:port/database'),
    });
    const parsed = input ? parsePostgresUrl(input) : undefined;
    if (!parsed) return undefined;
    let password = parsed.password;
    if (password === undefined) {
      password = await vscode.window.showInputBox({
        title: `Password for ${parsed.connection.user}@${parsed.connection.host}`,
        prompt: 'Leave empty if the server needs none. Kept in VS Code secret storage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) return undefined;
    }
    return { connection: parsed.connection, password: password || undefined };
  }

  /** Pick the log table and confirm its columns; null means none (typed SQL only). */
  private async chooseMapping(probe: SqlConnector, tables: string[]): Promise<LogTableMapping | null | undefined> {
    const none = { label: 'No log table', description: 'Only run SQL you type', table: undefined };
    const choice = await vscode.window.showQuickPick(
      [...tables.map((table) => ({ label: table, description: undefined, table })), none],
      { title: 'Add Connection (3/4): Log table', placeHolder: 'The table that holds one row per log event' },
    );
    if (!choice) return undefined;
    if (choice.table === undefined) return null;
    const columns = await probe.columns(choice.table);
    const mapping: Partial<Record<MappedField, string>> = suggestMapping(columns);
    for (;;) {
      const confirm = {
        label: '$(check) Use these columns',
        description: mapping.timestamp ? undefined : 'Choose the time column first',
        role: undefined,
      };
      const picked = await vscode.window.showQuickPick(
        [
          confirm,
          ...MAPPED_FIELDS.map((role) => ({
            label: ROLE_LABELS[role],
            description: mapping[role] ?? (role === 'timestamp' ? 'required' : 'none'),
            role,
          })),
        ],
        {
          title: `Add Connection (3/4): Columns of ${choice.table}`,
          placeHolder: 'Other columns become fields. Choose a role to change its column.',
          ignoreFocusOut: true,
        },
      );
      if (!picked) return undefined;
      if (!picked.role) {
        if (mapping.timestamp) return { table: choice.table, timestamp: mapping.timestamp, ...mapping };
        continue;
      }
      const role = picked.role;
      const column = await vscode.window.showQuickPick(
        [
          ...(role === 'timestamp' ? [] : [{ label: 'None', description: undefined, column: undefined }]),
          ...columns.map((info: ColumnInfo) => ({ label: info.name, description: info.type, column: info.name })),
        ],
        { title: `${ROLE_LABELS[role]} column` },
      );
      if (!column) continue;
      if (column.column === undefined) delete mapping[role];
      else mapping[role] = column.column;
    }
  }

  dispose(): void {
    for (const { connector } of this.open.values()) void connector.dispose();
    this.open.clear();
  }
}

/** Read `postgres://user:password@host:port/database?sslmode=require` into a connection. */
export function parsePostgresUrl(value: string): { connection: PostgresConnection; password?: string } | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return undefined;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (!database || !user || !url.hostname) return undefined;
  const ssl = ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '');
  const [connection] = normalizeConnections([
    {
      id: 'draft',
      label: database,
      type: 'postgres',
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database,
      user,
      ssl,
    },
  ]);
  return connection?.type === 'postgres'
    ? { connection, ...(url.password ? { password: decodeURIComponent(url.password) } : {}) }
    : undefined;
}
