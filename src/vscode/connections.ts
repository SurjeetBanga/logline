import * as path from 'node:path';
import * as vscode from 'vscode';
import { DatadogConnector, type DatadogKeys } from '../capture/connectors/datadog';
import { iamPassword, listProfiles } from '../capture/connectors/aws-auth';
import { MongoConnector } from '../capture/connectors/mongo';
import { MysqlDriver } from '../capture/connectors/mysql-driver';
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
  mongoUrl,
  normalizeConnections,
  rangeMs,
  RANGE_CHOICES,
  secretKey,
  type ConnectionConfig,
  type DatadogConnection,
  type MongoConnection,
  type MysqlConnection,
  type PostgresConnection,
} from '../core/connections';
import { parseDatadogLink } from '../core/datadog-query';
import { slugify } from '../core/server-config';
import type { Settings } from '../core/settings';
import type { ConnectionView } from '../protocol/messages';
import type { AgentConnection } from '../core/agent-types';
import type { ProductionFetchResult } from './agent-access';
import {
  ConnectionSession,
  type ConnectionFormHost,
  type FormOpen,
  type FormProbe,
  type FormReply,
  type FormSecret,
} from './connection-session';
import type { DatadogSecret } from '../core/connection-form';

/** Where the connections agents may query are remembered, across workspaces. */
const AGENT_ACCESS_KEY = 'logline.agentConnections.v1';

type Secrets = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;

/** Whether a connection can be searched: Datadog always, a database once a log table is mapped. */
const searchable = (connection: ConnectionConfig) => connection.type === 'datadog' || connection.logs !== undefined;
/** Whether a connection runs queries typed by a person: SQL on a database, a filter or pipeline on MongoDB. */
const sqlCapable = (connection: ConnectionConfig) => connection.type !== 'datadog';
type SqlConnection = Exclude<ConnectionConfig, DatadogConnection | MongoConnection>;
/** A database that signs in with a user and a password, or an IAM token. */
type ServerConnection = PostgresConnection | MysqlConnection;
type PasswordConnection = ServerConnection | MongoConnection;

/** The server refused the user name or password: Postgres, MySQL, or MongoDB. */
const authFailed = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { code?: unknown; errno?: unknown; codeName?: unknown };
  return (
    failure.code === '28P01' ||
    failure.code === '28000' ||
    failure.code === 'ER_ACCESS_DENIED_ERROR' ||
    failure.errno === 1045 ||
    failure.codeName === 'AuthenticationFailed'
  );
};

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
    /** Shows the Connection form as a tab of the Logs panel; without it, Add and Edit do nothing. */
    showForm?: (open: FormOpen, focus: boolean) => Promise<void>,
  ) {
    this.form = showForm ? new ConnectionSession(this.formHost(), showForm) : undefined;
  }

  private readonly form?: ConnectionSession;

  /** A message from the Connection form in the Logs panel. */
  formRequest(session: number, request: unknown, reply: FormReply): Promise<void> {
    return this.form?.receive(session, request, reply) ?? Promise.resolve();
  }

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
      const tail = this.remote.tailOf(connection.id);
      return {
        id: connection.id,
        sourceId: connectionSourceId(connection.id),
        label: connectionLabel(connection),
        type: connection.type,
        mapped: searchable(connection),
        sql: sqlCapable(connection),
        ...(connection.type === 'mongodb' ? { language: 'mongo' as const } : {}),
        watching: this.watched?.watching(connection.id) ?? [],
        agents: this.agentsAllowed(connection),
        tailing: this.remote.tailing(connection.id),
        ...(tail ? { tail } : {}),
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
    // IAM sign-in makes a new token for each connection; otherwise the password typed now, or the saved one.
    const secret = connection.auth
      ? iamPassword({ ...connection, ...connection.auth })
      : (password ?? (await this.secrets?.get(secretKey(connection))));
    return connection.type === 'mysql' ? new MysqlDriver(connection, secret) : new PostgresDriver(connection, secret);
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
        : connection.type === 'mongodb'
          ? new MongoConnector(connection, await this.secrets?.get(secretKey(connection)), this.timeoutMs)
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
      ...(connection.type === 'datadog' ? { maxRowsSetting: 'datadogMaxRows' } : {}),
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
    const signsInWithPassword =
      (connection.type === 'postgres' || connection.type === 'mysql') && !connection.auth
        ? true
        : connection.type === 'mongodb' && mongoUrl(connection.url)?.user !== undefined;
    if (signsInWithPassword && (authFailed(cause) || /password|authentication failed/i.test(error))) {
      const target = connection as PasswordConnection;
      const saved = (await this.secrets?.get(secretKey(target))) !== undefined;
      const user = target.type === 'mongodb' ? mongoUrl(target.url)?.user : target.user;
      const choice = await vscode.window.showErrorMessage(
        `${connectionLabel(connection)}: the server ${saved ? 'refused the saved password' : 'needs a password'} for ${user} (${error}).`,
        'Enter Password…',
      );
      if (choice) await this.askPassword(target);
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
      { title: `How Logline signs in to ${site}`, ignoreFocusOut: true },
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

  private async askPassword(connection: PasswordConnection): Promise<void> {
    const where =
      connection.type === 'mongodb'
        ? `${mongoUrl(connection.url)?.user}@${mongoUrl(connection.url)?.hosts}/${connection.database}`
        : `${connection.user}@${connection.host}/${connection.database}`;
    const password = await vscode.window.showInputBox({
      title: `Password for ${where}`,
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
  async fetch(
    id: string,
    query: string,
    range: string,
    window?: { fromMs: number; toMs: number },
    /** A query in the store's own syntax, sent as typed instead of `query`. */
    native?: string,
  ): Promise<void> {
    if (!this.trusted('searching a connection')) return;
    const connection = await this.pick(id, 'Search connection', searchable, 'No connection has logs to search.');
    if (!connection) return;
    const span = rangeMs(range) ?? 3600000;
    const now = Date.now();
    // A window is named in the time zone the panel shows times in.
    const utc = this.config.get<string>('timezone', 'local') === 'utc';
    const time = (ms: number) =>
      utc ? new Date(ms).toISOString().slice(11, 19) : new Date(ms).toTimeString().slice(0, 8);
    // A search still running is replaced by this one, rather than waited for.
    this.remote.cancelFetches(connection.id);
    try {
      const info = await this.remote.fetch(await this.target(connection), {
        query,
        ...(native !== undefined ? { native } : {}),
        fromMs: window?.fromMs ?? now - span,
        toMs: window?.toMs ?? now,
        title: `${(native ?? query).trim() || 'All rows'} · ${window ? `${time(window.fromMs)}–${time(window.toMs)}${utc ? ' UTC' : ''}` : `last ${range}`}`,
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
    if (!this.trusted('running a query')) return;
    const connection = await this.pick(id, 'Run a query on', sqlCapable, 'No database connection yet.');
    if (!connection || connection.type === 'datadog') return;
    const rows = this.config.get('connectionMaxRows', 5000).toLocaleString();
    const mongo = connection.type === 'mongodb';
    const sql = await vscode.window.showInputBox({
      title: `${mongo ? 'Run a query' : 'Run SQL'} on ${connectionLabel(connection)}`,
      prompt: mongo
        ? `A filter or a pipeline of stages, in JSON, on ${connection.logs?.table ?? 'the log collection'}. Read-only. At most ${rows} documents.`
        : `One SELECT, read-only. At most ${rows} rows.`,
      placeHolder: mongo
        ? `{ "${connection.logs?.level ?? 'level'}": "error" }`
        : connection.logs
          ? `SELECT * FROM ${connection.logs.table} WHERE ${connection.logs.level ?? 'level'} = 'ERROR'`
          : 'SELECT * FROM logs ORDER BY created_at DESC',
      ignoreFocusOut: true,
    });
    if (!sql?.trim()) return;
    try {
      const info = await this.remote.fetch(await this.target(connection), {
        query: '',
        sql,
        title: `${mongo ? 'Query' : 'SQL'}: ${sql.trim().replace(/\s+/g, ' ').slice(0, 80)}`,
        // The SQL chose the rows, so the panel's search is cleared rather than left to hide some of them.
        started: (runId) => void this.showSource(connectionSourceId(connection.id), runId, ''),
      });
      await this.failed(connection, info.error);
    } catch (error) {
      await this.failed(connection, errorText(error), error);
    }
  }

  /** Start or stop reading new rows from a connection as they are added; starting again follows `query` instead. */
  async tail(id: string | undefined, query: string, enabled?: boolean, native?: string): Promise<void> {
    const connection = await this.pick(id, 'Tail connection', searchable, 'No connection has logs to search.');
    if (!connection) return;
    const on = enabled ?? !this.remote.tailing(connection.id);
    if (!on) {
      this.remote.stopTails(connection.id);
      return;
    }
    if (!this.trusted('tailing a connection')) return;
    // A tail of the same filter keeps going.
    const tail = this.remote.tailOf(connection.id);
    if (tail?.query === (native ?? query) && tail.native === (native !== undefined)) return;
    const followed = (native ?? query).trim();
    // Every log of a Datadog organization can be thousands a minute: say so before tailing them all. A tail
    // already running stays when the answer is no.
    if (connection.type === 'datadog' && (!followed || followed === '*')) {
      const answer = await vscode.window.showWarningMessage(
        `Tail every log in ${connectionLabel(connection)}?`,
        {
          modal: true,
          detail:
            'A tail of every log can bring thousands of logs a minute and fill the panel quickly. Choose a service in the Service list, or type a filter, to tail fewer.',
        },
        'Tail Every Log',
      );
      if (answer !== 'Tail Every Log') return;
    }
    // A tail of another filter gives way to this one.
    this.remote.stopTails(connection.id);
    try {
      const runId = this.remote.tail(await this.target(connection), query, `Tail: ${followed || 'all rows'}`, native);
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

  /** The services that logged over a range, to choose one; none when the store does not know services. */
  async services(id: string, range: string): Promise<{ services: { name: string; count: number }[]; error?: string }> {
    const connection = this.find(id);
    if (!connection || !vscode.workspace.isTrusted) return { services: [] };
    const now = Date.now();
    try {
      const connector = await this.connector(connection);
      return { services: (await connector.services?.(now - (rangeMs(range) ?? 3600000), now)) ?? [] };
    } catch (error) {
      return { services: [], error: errorText(error) };
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
    // The password or keys are kept by what they open, for every workspace that connects there.
    const secret =
      connection.type === 'sqlite' ||
      ((connection.type === 'postgres' || connection.type === 'mysql') && connection.auth) ||
      (connection.type === 'mongodb' && !mongoUrl(connection.url)?.user)
        ? undefined
        : connection.type === 'datadog'
          ? 'Keys'
          : 'Password';
    const forget = secret && `Remove and Forget ${secret}`;
    const answer = await vscode.window.showWarningMessage(
      `Remove ${connectionLabel(connection)}?`,
      {
        modal: true,
        detail: [
          'Fetched rows stay in the Logs panel until cleared.',
          ...(secret ? [`Other workspaces that connect there keep the saved ${secret.toLowerCase()}.`] : []),
        ].join(' '),
      },
      'Remove',
      ...(forget ? [forget] : []),
    );
    if (answer !== 'Remove' && (!forget || answer !== forget)) return;
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
    if (connection.type !== 'sqlite' && answer === forget) await this.secrets?.delete(secretKey(connection));
    this.remote.stopConnection(connection.id);
    this.form?.removed(connection.id);
  }

  /** Open the Connection form to add one: its database, a test, and which table and columns hold logs. */
  async add(): Promise<void> {
    if (!this.trusted('adding a connection')) return;
    await this.form?.open();
  }

  /** Open the Connection form on a saved connection, to rename it, sign in again, or map its table anew. */
  async edit(id?: string): Promise<void> {
    if (!this.trusted('editing a connection')) return;
    const connection = await this.pick(id, 'Edit connection');
    if (connection) await this.form?.open(connection);
  }

  /** What the Connection form needs: AWS profiles, secrets, a connection to test, and saving. */
  private formHost(): ConnectionFormHost {
    return {
      profiles: () => {
        const kinds = {
          keys: 'Access key',
          sso: 'SSO',
          process: 'credential_process',
          role: 'Assumes a role (needs credential_process)',
        };
        return listProfiles().map((item) => ({
          name: item.name,
          description: [kinds[item.kind], item.region].filter(Boolean).join(' · '),
        }));
      },
      savedSecret: async (connection) => {
        if (connection.type === 'sqlite') return undefined;
        if (connection.type === 'datadog') {
          const keys = await this.keys(connection);
          const complete = 'token' in keys ? keys.token : keys.apiKey && keys.appKey;
          return complete ? { keys: keys as DatadogSecret } : undefined;
        }
        const password = await this.secrets?.get(secretKey(connection));
        return password === undefined ? undefined : { password };
      },
      probe: (connection, secret) => this.probe(connection, secret),
      browse: () => this.browseSqlite(),
      uniqueId: (label) => this.uniqueId(label),
      save: async (connection, secret, editing) => {
        if (connection.type === 'datadog' && secret.keys)
          await this.secrets?.store(secretKey(connection), JSON.stringify(secret.keys));
        else if (
          connection.type !== 'sqlite' &&
          connection.type !== 'datadog' &&
          !(connection.type !== 'mongodb' && connection.auth) &&
          secret.password !== undefined
        )
          await this.secrets?.store(secretKey(connection), secret.password);
        else if (connection.type !== 'sqlite' && connection.type !== 'datadog' && secret.forget)
          await this.secrets?.delete(secretKey(connection));
        // Agents' permission belongs to the database or API a connection opens, so an edit that points it
        // elsewhere does not take the permission along: the person allows that one on its own.
        const lostAgents =
          !!editing && this.agentsAllowed(editing) && this.identity(editing) !== this.identity(connection);
        await this.save(connection, editing?.id);
        if (editing) this.reopen(editing);
        await this.showSource(connectionSourceId(connection.id));
        // The form closes once this returns, so the question is not waited for.
        if (lostAgents) {
          const allow = 'Allow Agents…';
          void vscode.window
            .showInformationMessage(
              `Saved ${connectionLabel(connection)}. It now opens another database, so agents may not query it until you allow them again.`,
              allow,
            )
            .then((answer) => (answer === allow ? this.allowAgents(connection.id) : undefined));
          return;
        }
        const next =
          connection.type === 'datadog' || connection.logs
            ? 'Pick a time range and press Run in the Logs panel.'
            : `Use ${connection.type === 'mongodb' ? 'Run query' : 'Run SQL'} in the Logs panel to query it.`;
        void vscode.window.showInformationMessage(
          `${editing ? 'Saved' : 'Added'} ${connectionLabel(connection)}. ${editing ? '' : next}`.trim(),
        );
      },
    };
  }

  /** A connector for a connection being added or edited, to test it and read its tables before it is saved. */
  private async probe(connection: ConnectionConfig, secret: FormSecret): Promise<FormProbe> {
    return connection.type === 'datadog'
      ? new DatadogConnector(connection, secret.keys ?? {}, this.timeoutMs)
      : connection.type === 'mongodb'
        ? new MongoConnector(connection, secret.password, this.timeoutMs)
        : new SqlConnector(connection, await this.driver(connection, secret.password), this.timeoutMs);
  }

  /**
   * Save a connection in the settings: in place of `replace` where that one is
   * kept, else added to the workspace settings, or the user settings without a workspace.
   */
  private async save(connection: ConnectionConfig, replace?: string): Promise<void> {
    const settings = vscode.workspace.getConfiguration('logline');
    const inspected = settings.inspect<unknown[]>('connections');
    const isReplaced = (item: unknown) =>
      !!item && typeof item === 'object' && (item as { id?: unknown }).id === replace;
    if (replace !== undefined)
      for (const [target, value] of [
        [vscode.ConfigurationTarget.Workspace, inspected?.workspaceValue],
        [vscode.ConfigurationTarget.Global, inspected?.globalValue],
      ] as const) {
        if (!Array.isArray(value) || !value.some(isReplaced)) continue;
        await settings.update(
          'connections',
          value.map((item) => (isReplaced(item) ? connection : item)),
          target,
        );
        return;
      }
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
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

  /** Ask for a SQLite file; one inside the workspace is saved relative to it, so the setting works on every clone. */
  private async browseSqlite(): Promise<{ path: string; outside: boolean } | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const [file] =
      (await vscode.window.showOpenDialog({
        title: 'SQLite database',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Choose',
        defaultUri: folder,
        filters: { 'SQLite databases': ['db', 'sqlite', 'sqlite3', 'db3'], 'All files': ['*'] },
      })) ?? [];
    if (!file) return undefined;
    if (file.scheme !== 'file') {
      void vscode.window.showWarningMessage('Logline can only open SQLite files on the local filesystem.');
      return undefined;
    }
    const relative = folder ? path.relative(folder.fsPath, file.fsPath) : '';
    const inside = folder && relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    return inside ? { path: relative.split(path.sep).join('/'), outside: false } : { path: file.fsPath, outside: true };
  }

  dispose(): void {
    this.form?.dispose();
    for (const { connector } of this.open.values()) void connector.dispose();
    this.open.clear();
  }
}

// The URL readers are shared with the connection form, so they live in core.
export { parseMongoUrl, parsePostgresUrl, parseServerUrl } from '../core/connections';
