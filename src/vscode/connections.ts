import * as path from 'node:path';
import * as vscode from 'vscode';
import { DatadogConnector, type DatadogKeys } from '../capture/connectors/datadog';
import { PostgresDriver } from '../capture/connectors/postgres-driver';
import { SqlConnector } from '../capture/connectors/sql';
import { openSqlite } from '../capture/connectors/sqlite-driver';
import { errorText, type Connector, type RemoteRecord, type SqlDriver } from '../capture/connectors/types';
import type { RemoteMetrics } from '../capture/remote-metrics';
import type { RemoteSource, RemoteTarget } from '../capture/remote-source';
import type { MetricSeriesData } from '../core/metric-query';
import {
  connectionLabel,
  connectionSourceId,
  datadogApiBase,
  DATADOG_SITES,
  MAPPED_FIELDS,
  normalizeConnections,
  rangeMs,
  RANGE_CHOICES,
  secretKey,
  suggestMapping,
  type ColumnInfo,
  type ConnectionConfig,
  type DatadogConnection,
  type LogTableMapping,
  type MappedField,
  type PostgresConnection,
} from '../core/connections';
import { parseDatadogLink } from '../core/datadog-query';
import { slugify } from '../core/server-config';
import type { Settings } from '../core/settings';
import type { ConnectionView } from '../protocol/messages';
import type { AgentConnection } from '../core/agent-types';
import type { ProductionFetchResult } from './agent-access';

/** Where the connections agents may query are remembered, across workspaces. */
const AGENT_ACCESS_KEY = 'logline.agentConnections.v1';

type Secrets = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;

const ROLE_LABELS: Record<MappedField, string> = {
  timestamp: 'Time',
  level: 'Level',
  message: 'Message',
  service: 'Service',
  traceId: 'Trace id',
};

/** Whether a connection can be searched: Datadog always, a database once a log table is mapped. */
const searchable = (connection: ConnectionConfig) => connection.type === 'datadog' || connection.logs !== undefined;
const sqlCapable = (connection: ConnectionConfig) => connection.type !== 'datadog';
type SqlConnection = Exclude<ConnectionConfig, DatadogConnection>;

/** Postgres refused the user name or password. */
const authFailed = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && (error.code === '28P01' || error.code === '28000');

/**
 * Saved connections (`logline.connections`): opens their databases on first
 * use, keeps passwords in secret storage, and runs the commands that add,
 * test, search, and tail them.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly open = new Map<string, { key: string; connector: Connector }>();

  constructor(
    private readonly config: Settings,
    readonly remote: RemoteSource,
    private readonly secrets: Secrets | undefined,
    /** Select a source, and one of its runs, in the Logs panel. */
    private readonly showSource: (sourceId: string, runId?: string, query?: string) => Promise<void>,
    /** Watched metric queries, polled into the Metrics list. */
    private readonly watched?: RemoteMetrics,
    /** Remembers which connections agents may query; outside settings, so a workspace cannot grant it. */
    private readonly consent?: Pick<vscode.Memento, 'get' | 'update'>,
  ) {}

  /** What a connection opens: the same database or API, whatever a workspace calls it. */
  private identity(connection: ConnectionConfig): string {
    if (connection.type === 'sqlite') return `sqlite:${this.resolvePath(connection.path)}`;
    return secretKey(connection);
  }

  private agentsAllowed(connection: ConnectionConfig): boolean {
    return (this.consent?.get<string[]>(AGENT_ACCESS_KEY, []) ?? []).includes(this.identity(connection));
  }

  /** Let agents fetch from a connection, after the person confirms what that means. */
  async allowAgents(id?: string): Promise<void> {
    const connection = await this.pick(id, 'Allow agents to query', searchable, 'No connection has logs to search.');
    if (!connection || !this.consent || this.agentsAllowed(connection)) return;
    const answer = await vscode.window.showWarningMessage(
      `Allow agents to query ${connectionLabel(connection)}?`,
      {
        modal: true,
        detail:
          'Agents you share logs with (Copilot, and Claude Code, Codex, or other MCP clients you connected) can fetch up to 24 hours of its logs at a time, at most 10 times a minute, into runs you can see in the Logs panel. Results are redacted. You can stop this at any time.',
      },
      'Allow',
    );
    if (answer !== 'Allow') return;
    const allowed = this.consent.get<string[]>(AGENT_ACCESS_KEY, []);
    await this.consent.update(AGENT_ACCESS_KEY, [...new Set([...allowed, this.identity(connection)])]);
  }

  async revokeAgents(id?: string): Promise<void> {
    const connection = await this.pick(
      id,
      'Stop agents querying',
      (candidate) => this.agentsAllowed(candidate),
      'Agents may not query any connection.',
    );
    if (!connection || !this.consent) return;
    const identity = this.identity(connection);
    await this.consent.update(
      AGENT_ACCESS_KEY,
      this.consent.get<string[]>(AGENT_ACCESS_KEY, []).filter((entry) => entry !== identity),
    );
  }

  /** Connections as agents see them. */
  agentConnections(): AgentConnection[] {
    return this.list()
      .filter(searchable)
      .map((connection) => ({
        id: connection.id,
        label: connectionLabel(connection),
        type: connection.type,
        agents: this.agentsAllowed(connection),
      }));
  }

  /**
   * A fetch an agent asked for, already checked by the agent boundary: the
   * newest logs that match its search, or every log of a trace, as a run.
   */
  async agentFetch(input: {
    connectionId: string;
    query: string;
    traceId?: string;
    range: string;
    limit: number;
  }): Promise<ProductionFetchResult> {
    const connection = this.find(input.connectionId);
    const sourceId = connectionSourceId(input.connectionId);
    if (!connection || !this.agentsAllowed(connection) || !vscode.workspace.isTrusted)
      return {
        sourceId,
        label: input.connectionId,
        fetched: 0,
        kept: 0,
        local: [],
        error: 'Agents may not query this connection.',
      };
    const now = Date.now();
    // A trace id is the store's own trace field: Datadog's trace_id, a mapped table's trace id column.
    const trace = input.traceId;
    const info = await this.remote.fetch(await this.target(connection), {
      query: trace && connection.type !== 'datadog' ? `traceId:${trace}` : input.query,
      ...(trace && connection.type === 'datadog' ? { native: `trace_id:${trace}` } : {}),
      fromMs: now - (rangeMs(input.range) ?? 3600000),
      toMs: now,
      limit: input.limit,
      title: `Agent: ${trace ? `trace ${trace.slice(0, 16)}` : input.query.trim() || 'all logs'} · last ${input.range}`,
    });
    return {
      sessionId: info.sessionId,
      sourceId,
      label: connectionLabel(connection),
      fetched: info.fetched,
      kept: info.kept,
      ...(info.total !== undefined ? { total: info.total } : {}),
      local: info.local,
      ...(info.statement ? { statement: info.statement } : {}),
      ...(info.error ? { error: info.error } : {}),
    };
  }

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
        mapped: searchable(connection),
        sql: sqlCapable(connection),
        watching: this.watched?.watching(connection.id) ?? [],
        agents: this.agentsAllowed(connection),
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
      if (!current.has(id)) {
        this.remote.stopConnection(id);
        this.watched?.stopConnection(id);
      }
    }
  }

  /** A SQLite path from settings, relative to the first workspace folder unless absolute. */
  resolvePath(file: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const expanded = file.replace(/\$\{workspaceFolder\}/g, folder ?? '');
    return path.isAbsolute(expanded) ? expanded : path.resolve(folder ?? '', expanded);
  }

  private timeoutMs = () => this.config.get('connectionTimeoutSeconds', 10) * 1000;

  private async driver(connection: SqlConnection, password?: string): Promise<SqlDriver> {
    if (connection.type === 'sqlite') return openSqlite(this.resolvePath(connection.path));
    return new PostgresDriver(connection, password ?? (await this.secrets?.get(secretKey(connection))));
  }

  /** Datadog keys saved for the connection's API; none when nothing was saved. */
  private async keys(connection: DatadogConnection): Promise<DatadogKeys> {
    try {
      const saved = JSON.parse((await this.secrets?.get(secretKey(connection))) ?? '{}') as DatadogKeys;
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  private async connector(connection: ConnectionConfig): Promise<Connector> {
    const key = JSON.stringify(connection);
    const open = this.open.get(connection.id);
    if (open?.key === key) return open.connector;
    if (open) void open.connector.dispose();
    const connector =
      connection.type === 'datadog'
        ? new DatadogConnector(connection, await this.keys(connection), this.timeoutMs)
        : new SqlConnector(connection, await this.driver(connection), this.timeoutMs);
    this.open.set(connection.id, { key, connector });
    return connector;
  }

  /** Forget an open connector, so the next query opens it again, such as with a new password. */
  private reopen(connection: ConnectionConfig): void {
    const open = this.open.get(connection.id);
    this.open.delete(connection.id);
    void open?.connector.dispose();
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

  /** The connection to act on: the one named, else the only one that fits, else one the person picks. */
  private async pick(
    id: string | undefined,
    title: string,
    fits: (connection: ConnectionConfig) => boolean = () => true,
    none = 'No connections yet.',
  ): Promise<ConnectionConfig | undefined> {
    const connections = this.list().filter(fits);
    if (id) {
      const connection = this.find(id);
      if (!connection) void vscode.window.showWarningMessage('That connection is no longer in logline.connections.');
      return connection;
    }
    if (!connections.length) {
      const add = await vscode.window.showInformationMessage(none, 'Add Connection…');
      if (add) await this.add();
      return undefined;
    }
    if (connections.length === 1) return connections[0];
    const choice = await vscode.window.showQuickPick(
      connections.map((connection) => ({
        label: connectionLabel(connection),
        description: connection.type === 'datadog' ? connection.site : connection.logs?.table,
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
    if (connection.type === 'datadog' && /refused the|no API key|keys? (?:are|is) missing/i.test(error)) {
      const choice = await vscode.window.showErrorMessage(`${connectionLabel(connection)}: ${error}`, 'Enter Keys…');
      if (choice) {
        const keys = await this.askKeys(connection.site);
        if (keys) {
          await this.secrets?.store(secretKey(connection), JSON.stringify(keys));
          this.reopen(connection);
        }
      }
      return;
    }
    void vscode.window.showErrorMessage(`${connectionLabel(connection)}: ${error}`);
  }

  /** Ask for Datadog API and application keys, or an access token, for a site. */
  private async askKeys(site: string): Promise<DatadogKeys | undefined> {
    const how = await vscode.window.showQuickPick(
      [
        {
          label: 'API and application keys',
          description: 'Organization Settings › API Keys and Application Keys',
          token: false,
        },
        { label: 'Access token', description: 'A personal or service access token', token: true },
      ],
      { title: `Add Connection (3/4): How Logline signs in to ${site}`, ignoreFocusOut: true },
    );
    if (!how) return undefined;
    const ask = (title: string, prompt: string) =>
      vscode.window.showInputBox({
        title,
        prompt,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Required'),
      });
    const note = 'Kept in VS Code secret storage, never in settings. It needs the logs_read_data permission.';
    if (how.token) {
      const token = await ask(`Datadog access token for ${site}`, note);
      return token ? { token: token.trim() } : undefined;
    }
    const apiKey = await ask(`Datadog API key for ${site}`, note);
    const appKey = apiKey && (await ask(`Datadog application key for ${site}`, note));
    return apiKey && appKey ? { apiKey: apiKey.trim(), appKey: appKey.trim() } : undefined;
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
    this.reopen(connection);
  }

  /** Fetch the newest rows that match a search over a range, or an exact window, into a new run. */
  async fetch(id: string, query: string, range: string, window?: { fromMs: number; toMs: number }): Promise<void> {
    if (!this.trusted('searching a connection')) return;
    const connection = await this.pick(id, 'Search connection', searchable, 'No connection has logs to search.');
    if (!connection) return;
    const span = rangeMs(range) ?? 3600000;
    const now = Date.now();
    // A window is named in the time zone the panel shows times in.
    const utc = this.config.get<string>('timezone', 'local') === 'utc';
    const time = (ms: number) =>
      utc ? new Date(ms).toISOString().slice(11, 19) : new Date(ms).toTimeString().slice(0, 8);
    try {
      const info = await this.remote.fetch(await this.target(connection), {
        query,
        fromMs: window?.fromMs ?? now - span,
        toMs: window?.toMs ?? now,
        title: `${query.trim() || 'All rows'} · ${window ? `${time(window.fromMs)}–${time(window.toMs)}${utc ? ' UTC' : ''}` : `last ${range}`}`,
        // The panel shows the new run, not every earlier one of the same search, with that search.
        started: (runId) => void this.showSource(connectionSourceId(connection.id), runId, query),
      });
      await this.failed(connection, info.error);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  /** Run SQL typed by the person into a new run. */
  async runSql(id?: string): Promise<void> {
    if (!this.trusted('running SQL')) return;
    const connection = await this.pick(id, 'Run SQL on', sqlCapable, 'No database connection yet.');
    if (!connection || connection.type === 'datadog') return;
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
        // The SQL chose the rows, so the panel's search is cleared rather than left to hide some of them.
        started: (runId) => void this.showSource(connectionSourceId(connection.id), runId, ''),
      });
      await this.failed(connection, info.error);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  /** Start or stop reading new rows from a connection as they are added. */
  async tail(id: string | undefined, query: string, enabled?: boolean): Promise<void> {
    const connection = await this.pick(id, 'Tail connection', searchable, 'No connection has logs to search.');
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
    if (!connection || !searchable(connection) || !vscode.workspace.isTrusted) return { local: [] };
    const span = rangeMs(range) ?? 3600000;
    const now = Date.now();
    try {
      return await (await this.connector(connection)).preview(query, now - span, now);
    } catch (error) {
      return { local: [], error: errorText(error) };
    }
  }

  /** Run a metric query over a range, for the Metrics tab's chart. */
  async metricQuery(
    id: string,
    query: string,
    range: string,
  ): Promise<{
    result?: { series: MetricSeriesData[]; statement: string; elapsedMs: number; fromMs: number; toMs: number };
    error?: string;
  }> {
    if (!vscode.workspace.isTrusted) return { error: 'Trust this workspace before querying a connection.' };
    const connection = this.find(id);
    if (!connection) return { error: 'That connection is no longer in logline.connections.' };
    const toMs = Date.now();
    const fromMs = toMs - (rangeMs(range) ?? 3600000);
    try {
      const connector = await this.connector(connection);
      if (!connector.queryMetrics) return { error: `${connectionLabel(connection)} has no metrics.` };
      return { result: { ...(await connector.queryMetrics(query, fromMs, toMs)), fromMs, toMs } };
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  /** Metric names for suggestions while a query is typed; none when the store cannot list them. */
  async metricNames(id: string, search: string): Promise<string[]> {
    const connection = this.find(id);
    if (!connection || !vscode.workspace.isTrusted) return [];
    try {
      return (await (await this.connector(connection)).listMetrics?.(search)) ?? [];
    } catch {
      return [];
    }
  }

  /** Start or stop polling a metric query into the Metrics list. */
  async watchMetric(id: string, query: string, enabled: boolean): Promise<void> {
    const connection = this.find(id);
    if (!connection || !this.watched) return;
    if (!enabled) {
      this.watched.unwatch(id, query);
      return;
    }
    if (!this.trusted('watching a metric')) return;
    const connector = await this.connector(connection);
    const { queryMetrics, listMetrics } = connector;
    if (!queryMetrics || !listMetrics) return;
    this.watched.watch(
      {
        id,
        label: connectionLabel(connection),
        connector: {
          queryMetrics: (...args) => queryMetrics.apply(connector, args),
          listMetrics: (...args) => listMetrics.apply(connector, args),
        },
      },
      query,
    );
  }

  /** Ask for a search and a range in the Command Palette, then fetch. */
  async query(id?: string): Promise<void> {
    if (!this.trusted('searching a connection')) return;
    const connection = await this.pick(id, 'Search connection', searchable, 'No connection has logs to search.');
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
    if (connection.type !== 'sqlite') await this.secrets?.delete(secretKey(connection));
    this.remote.stopConnection(connection.id);
  }

  /** Walk through adding a connection: the database, a test, and which table and columns hold logs. */
  async add(): Promise<void> {
    if (!this.trusted('adding a connection')) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'SQLite', description: 'A database file on this machine', type: 'sqlite' as const },
        { label: 'Postgres', description: 'A server, by host, database, and user', type: 'postgres' as const },
        { label: 'Datadog', description: 'Logs in a Datadog organization', type: 'datadog' as const },
      ],
      { title: 'Add Connection (1/4): Where the logs are' },
    );
    if (!kind) return;
    if (kind.type === 'datadog') return this.addDatadog();
    const draft = kind.type === 'sqlite' ? await this.sqliteDraft() : await this.postgresDraft();
    if (!draft) return;
    const { connection, password } = draft;
    const driver = await this.driver(connection, password);
    const probe = new SqlConnector(connection, driver, this.timeoutMs);
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
      const saved: ConnectionConfig = {
        ...connection,
        id: this.uniqueId(label),
        label: label.trim(),
        ...(logs ? { logs } : {}),
      };
      if (saved.type === 'postgres' && password) await this.secrets?.store(secretKey(saved), password);
      await this.save(saved);
      await this.showSource(connectionSourceId(saved.id));
      void vscode.window.showInformationMessage(
        logs
          ? `Added ${connectionLabel(saved)}. Pick a time range and press Run in the Logs panel.`
          : `Added ${connectionLabel(saved)}. Use Run SQL in the Logs panel to query it.`,
      );
    } finally {
      await probe.dispose();
    }
  }

  /** Save a new connection in the workspace settings, or the user settings without a workspace. */
  private async save(connection: ConnectionConfig): Promise<void> {
    const settings = vscode.workspace.getConfiguration('logline');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const inspected = settings.inspect<unknown[]>('connections');
    const current =
      target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    await settings.update('connections', [...(Array.isArray(current) ? current : []), connection], target);
  }

  private uniqueId(label: string): string {
    const ids = new Set(this.list().map((existing) => existing.id));
    const base = slugify(label);
    let id = base;
    for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
    return id;
  }

  private async addDatadog(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        ...DATADOG_SITES.map((site) => ({ label: site, description: site === 'datadoghq.com' ? 'US1' : undefined })),
        { label: 'Other…', description: 'The URL of a Datadog API, such as a proxy' },
      ],
      { title: 'Add Connection (2/4): Datadog site', placeHolder: 'The domain of your Datadog web app' },
    );
    if (!choice) return;
    const site =
      choice.label === 'Other…'
        ? (
            await vscode.window.showInputBox({
              title: 'Add Connection (2/4): Datadog API URL',
              placeHolder: 'https://datadog-proxy.example.com',
              ignoreFocusOut: true,
              validateInput: (value) =>
                datadogApiBase(value.trim()) ? undefined : 'Enter an https URL (http only on this machine)',
            })
          )?.trim()
        : choice.label;
    if (!site) return;
    const keys = await this.askKeys(site);
    if (!keys) return;
    const draft: DatadogConnection = { id: 'draft', label: 'datadog', type: 'datadog', site };
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to Datadog at ${site}…` },
        () => new DatadogConnector(draft, keys, this.timeoutMs).test(),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not connect: ${errorText(error)}`);
      return;
    }
    const label = await vscode.window.showInputBox({
      title: 'Add Connection (4/4): Name',
      prompt: 'Shown in the Logs panel’s source list, such as prod.',
      value: 'prod',
      ignoreFocusOut: true,
    });
    if (!label?.trim()) return;
    const saved: DatadogConnection = { ...draft, id: this.uniqueId(label), label: label.trim() };
    await this.secrets?.store(secretKey(saved), JSON.stringify(keys));
    await this.save(saved);
    await this.showSource(connectionSourceId(saved.id));
    void vscode.window.showInformationMessage(
      `Added ${connectionLabel(saved)}. Pick a time range and press Run in the Logs panel, or open a log link with Open Link.`,
    );
  }

  /**
   * Fetch what a Datadog link points at: its search over its time range and,
   * when it names a log with a trace id, that log's whole trace. A trace id on
   * its own fetches the trace.
   */
  async openLink(id?: string, input?: string): Promise<void> {
    if (!this.trusted('searching a connection')) return;
    const connection = await this.pick(
      id,
      'Open Datadog link',
      (candidate) => candidate.type === 'datadog',
      'No Datadog connection yet.',
    );
    if (!connection) return;
    const text =
      input ??
      (await vscode.window.showInputBox({
        title: `Open a Datadog link or trace id in ${connectionLabel(connection)}`,
        prompt: 'A Log Explorer link (its search, time range, and selected log are used), or a trace id.',
        placeHolder: 'https://app.datadoghq.com/logs?query=service:checkout&event=…',
        ignoreFocusOut: true,
        validateInput: (value) =>
          !value.trim() || parseDatadogLink(value) ? undefined : 'Paste a Log Explorer link or a trace id',
      }));
    const link = text ? parseDatadogLink(text) : undefined;
    if (!link) return;
    const sourceId = connectionSourceId(connection.id);
    // The link chose the logs, so the panel's search is cleared rather than left to hide some of them.
    const started = (runId: string) => void this.showSource(sourceId, runId, '');
    const target = await this.target(connection);
    const trace = async (traceId: string, aroundMs?: number) => {
      // A trace lasts seconds to minutes; half an hour each side of its log is plenty, and a day without one.
      const now = Date.now();
      const info = await this.remote.fetch(target, {
        query: '',
        native: `trace_id:${traceId}`,
        fromMs: aroundMs !== undefined ? aroundMs - 1800000 : now - 86400000,
        toMs: aroundMs !== undefined ? aroundMs + 1800000 : now,
        title: `Trace ${traceId.slice(0, 16)}`,
        started,
      });
      await this.failed(connection, info.error);
    };
    try {
      if (link.traceId) return await trace(link.traceId);
      let linked: RemoteRecord | undefined;
      const info = await this.remote.fetch(target, {
        query: '',
        native: link.query ?? '*',
        fromMs: link.fromMs,
        toMs: link.toMs,
        title: `Link: ${link.query ?? 'log'}`,
        started,
        inspect: (records) => {
          linked = records.find((record) => record.line.includes(`"datadog.id":${JSON.stringify(link.eventId)}`));
        },
      });
      await this.failed(connection, info.error);
      const traceId = linked && (JSON.parse(linked.line) as { traceId?: unknown }).traceId;
      if (typeof traceId === 'string' && traceId) await trace(traceId, linked!.timeMs);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  private async sqliteDraft(): Promise<{ connection: SqlConnection; password?: string } | undefined> {
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

  private async postgresDraft(): Promise<{ connection: SqlConnection; password?: string } | undefined> {
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
