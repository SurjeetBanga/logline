import { errorText } from '../capture/connectors/types';
import {
  draftFromConnection,
  emptyDraft,
  keepUnmodeled,
  normalizeDraft,
  normalizeMapping,
  readDraft,
  draftSecretKey,
  sampleText,
  type DatadogSecret,
  type FormProfile,
  type FormDraft,
  type FormRequest,
  type FormUpdate,
} from '../core/connection-form';
import {
  DATADOG_SITES,
  secretKey,
  suggestMapping,
  type ColumnInfo,
  type ConnectionConfig,
  type LogTableMapping,
} from '../core/connections';

/** A connection opened from the form before it is saved: to test it, list its tables, and preview rows. */
export interface FormProbe {
  test(): Promise<string>;
  tables?(): Promise<string[]>;
  columns?(table: string): Promise<ColumnInfo[]>;
  sample?(table: string, limit?: number): Promise<Record<string, unknown>[]>;
  dispose(): Promise<void>;
}

export interface FormSecret {
  password?: string;
  keys?: DatadogSecret;
  /** Delete the saved password: the edit asked to forget it and typed none. */
  forget?: boolean;
}

/** What the form needs from the connection manager. */
export interface ConnectionFormHost {
  profiles(): FormProfile[];
  /** The password or keys saved for a connection, if any. */
  savedSecret(connection: ConnectionConfig): Promise<FormSecret | undefined>;
  probe(connection: ConnectionConfig, secret: FormSecret): Promise<FormProbe>;
  /** Ask for a SQLite file: its path as saved, and whether it is outside the workspace. */
  browse(): Promise<{ path: string; outside: boolean } | undefined>;
  uniqueId(label: string): string;
  /** Save a new connection, or replace `editing`, with the secret typed. */
  save(connection: ConnectionConfig, secret: FormSecret, editing?: ConnectionConfig): Promise<void>;
}

const UNREADABLE = 'The form sent a connection Logline cannot read, or of another type. Close it and try again.';

/** Turns a failure into one line for the form. */
const message = (error: unknown) => errorText(error) || 'Unknown error';

/** Where the open form's answers go: the Logs view, which shows the form as a tab. */
export type FormReply = (update: FormUpdate) => void;

/** The form to show in the Logs panel: a session number, so answers meant for an earlier form are dropped. */
export interface FormOpen {
  session: number;
  title: string;
  /** The connection being edited; none while one is added. */
  connectionId?: string;
}

/**
 * The Connection form, shown as a tab of the Logs panel: adds a connection, or
 * edits one. It keeps the connection opened by the last good test, so choosing
 * a table and previewing its rows needs no new sign-in, and saves only what
 * was tested. One form is open at a time; opening another replaces it.
 */
export class ConnectionSession {
  /** The open form's number; 0 while none is open. */
  private session = 0;
  private sessions = 0;
  private reply?: FormReply;
  private editing?: ConnectionConfig;
  private savedSecret?: FormSecret;
  /** The last draft tested, secrets left out, to fill the form again when the Logs view is made anew. */
  private lastDraft?: FormDraft;
  private probe?: FormProbe;
  /** The connection and secret the open probe was tested with. */
  private tested?: string;
  private columns = new Map<string, string[]>();
  /** Requests are answered in order; a newer test makes an older one's answer stale. */
  private generation = 0;

  /**
   * @param show Shows the form in the Logs panel: delivered with the panel's next snapshot, and with
   *   `focus`, the panel is brought into view first.
   */
  constructor(
    private readonly host: ConnectionFormHost,
    private readonly show: (open: FormOpen, focus: boolean) => Promise<void>,
  ) {}

  /** Open the form to add a connection, or to edit `editing`. */
  async open(editing?: ConnectionConfig): Promise<void> {
    // The form already open on this connection, or adding one, is shown again rather than started over.
    if (this.session && this.editing?.id === editing?.id) return this.show(this.opening(), true);
    this.close();
    const session = (this.session = ++this.sessions);
    this.editing = editing;
    const saved = editing ? await this.host.savedSecret(editing) : undefined;
    // A form opened meanwhile owns the session now: this secret is not for it.
    if (this.session !== session) return;
    this.savedSecret = saved;
    await this.show(this.opening(), true);
  }

  /** A Logs view started, such as after its panel was hidden: show the open form in it again. */
  async viewReset(): Promise<void> {
    if (this.session) await this.show(this.opening(), false);
  }

  private opening(): FormOpen {
    return this.editing
      ? { session: this.session, title: `Edit ${this.editing.label}`, connectionId: this.editing.id }
      : { session: this.session, title: 'Add connection' };
  }

  private post(session: number, update: FormUpdate): void {
    if (session === this.session) this.reply?.(update);
  }

  /** A message from the form numbered `session`, answered through `reply`. */
  async receive(session: number, value: unknown, reply: FormReply): Promise<void> {
    if (!value || typeof value !== 'object') return;
    // A new Logs view asks whether a form is open, and shows it again if one is.
    if ((value as { type?: unknown }).type === 'resume') return this.viewReset();
    // A form from before the last open, or one already closed, is told to close.
    if (session !== this.session) return reply({ type: 'close' });
    this.reply = reply;
    const request = value as Partial<FormRequest> & Record<string, unknown>;
    switch (request.type) {
      case 'ready':
        this.post(session, {
          type: 'init',
          mode: this.editing ? 'edit' : 'add',
          draft: this.lastDraft ?? (this.editing ? draftFromConnection(this.editing) : emptyDraft()),
          ...(this.editing && this.editing.type !== 'datadog' && this.editing.logs
            ? { mapping: this.editing.logs }
            : {}),
          secret: this.savedSecret !== undefined,
          ...(this.savedSecret && this.editing && this.editing.type !== 'sqlite'
            ? { secretKey: secretKey(this.editing) }
            : {}),
          profiles: this.host.profiles(),
          sites: DATADOG_SITES,
        });
        return;
      case 'test':
        return this.test(session, request.draft);
      case 'browse': {
        const file = await this.host.browse();
        if (file) this.post(session, { type: 'file', ...file });
        return;
      }
      case 'table':
        if (typeof request.table === 'string') return this.table(session, request.table);
        return;
      case 'save':
        return this.save(session, request.draft, request.mapping);
      case 'cancel':
        this.post(session, { type: 'close' });
        this.close();
        return;
    }
  }

  /** The connection a draft describes and the secret to open it with: typed now, else the saved one. */
  private read(value: unknown) {
    const draft = normalizeDraft(value);
    if (!draft) return undefined;
    // An edited connection keeps its type, whatever the form sends.
    if (this.editing && draft.type !== this.editing.type) return undefined;
    // The saved secret opens only the server or site it was saved for: not one the edit points at instead.
    const keeps =
      this.savedSecret !== undefined &&
      !draft.forgetSecret &&
      this.editing !== undefined &&
      this.editing.type !== 'sqlite' &&
      draftSecretKey(draft) === secretKey(this.editing);
    const saved = keeps ? this.savedSecret : undefined;
    const read = readDraft(draft, { secret: keeps });
    const result = read.connection ? { ...read, connection: keepUnmodeled(read.connection, this.editing) } : read;
    const secret: FormSecret = {
      ...(result.password !== undefined
        ? { password: result.password }
        : saved?.password !== undefined
          ? { password: saved.password }
          : draft.forgetSecret
            ? { forget: true }
            : {}),
      ...(result.keys ? { keys: result.keys } : saved?.keys ? { keys: saved.keys } : {}),
    };
    return { draft, result, secret, key: JSON.stringify([result.connection, secret]) };
  }

  private async test(session: number, value: unknown): Promise<void> {
    const generation = ++this.generation;
    const read = this.read(value);
    // The form waits for an answer, so a draft that cannot be read still gets one.
    if (!read) return this.post(session, { type: 'tested', ok: false, error: UNREADABLE });
    const { draft, result, secret, key } = read;
    this.lastDraft = { ...draft, password: '', apiKey: '', appKey: '', token: '' };
    if (!result.connection) {
      const [first] = Object.values(result.errors);
      this.post(session, { type: 'tested', ok: false, error: first ?? 'Fill in the connection first.' });
      return;
    }
    this.dropProbe();
    let probe: FormProbe | undefined;
    try {
      probe = await this.host.probe(result.connection, secret);
      const detail = await probe.test();
      const tables = probe.tables ? await probe.tables() : undefined;
      if (generation !== this.generation || session !== this.session) {
        await probe.dispose();
        return;
      }
      this.probe = probe;
      this.tested = key;
      this.post(session, { type: 'tested', ok: true, detail, ...(tables ? { tables } : {}) });
    } catch (error) {
      await probe?.dispose();
      if (generation === this.generation) this.post(session, { type: 'tested', ok: false, error: message(error) });
    }
  }

  private async table(session: number, table: string): Promise<void> {
    const probe = this.probe;
    if (!probe?.columns) return this.post(session, { type: 'columns', table, error: 'Test the connection again.' });
    // A newer test replaces the probe; what this one read then belongs to a connection no longer shown.
    const current = () => this.probe === probe && this.session === session;
    try {
      // The preview is optional: a table whose rows cannot be read can still be mapped from its columns.
      let previewError: string | undefined;
      const [columns, sample] = await Promise.all([
        probe.columns(table),
        probe.sample?.(table, 5).catch((error: unknown) => {
          previewError = message(error);
          return undefined;
        }),
      ]);
      if (!current()) return;
      const suggested = suggestMapping(columns);
      // A collection without a time field still knows when each document was created, from its _id.
      if (!suggested.timestamp && columns.some((column) => column.name === '_id' && column.type === 'objectId'))
        suggested.timestamp = '_id';
      const rows = sample ? sampleText(sample) : [];
      this.columns.set(
        table,
        columns.map((column) => column.name),
      );
      this.post(session, {
        type: 'columns',
        table,
        columns,
        suggested,
        rows,
        ...(previewError ? { previewError } : {}),
      });
    } catch (error) {
      if (current()) this.post(session, { type: 'columns', table, error: message(error) });
    }
  }

  private async save(session: number, value: unknown, mappingValue: unknown): Promise<void> {
    const fail = (error: string) => this.post(session, { type: 'saveFailed', error });
    const read = this.read(value);
    if (!read) return fail(UNREADABLE);
    const { draft, result, secret, key } = read;
    const connection = result.connection;
    if (!connection) return fail(Object.values(result.errors)[0] ?? 'Fill in the connection first.');
    if (key !== this.tested) return fail('Test the connection first: it changed since the last test.');
    const label = draft.label.trim();
    if (!label) return fail('Give the connection a name.');
    let logs: LogTableMapping | null | undefined = null;
    if (connection.type !== 'datadog') {
      const table =
        mappingValue && typeof mappingValue === 'object' ? (mappingValue as { table?: unknown }).table : undefined;
      logs = normalizeMapping(mappingValue, typeof table === 'string' ? (this.columns.get(table) ?? []) : []);
      if (logs === undefined) return fail('Choose the log table and its time column, or No log table.');
      // A time format set by hand in settings stays while the table and time column do.
      const before = this.editing?.type !== 'datadog' ? this.editing?.logs : undefined;
      if (logs && before?.timestampFormat && before.table === logs.table && before.timestamp === logs.timestamp)
        logs.timestampFormat = before.timestampFormat;
    }
    const saved = {
      ...connection,
      id: this.editing?.id ?? this.host.uniqueId(label),
      label,
      ...(logs ? { logs } : {}),
    } as ConnectionConfig;
    const editing = this.editing;
    try {
      await this.host.save(saved, secret, editing);
    } catch (error) {
      return fail(message(error));
    }
    this.post(session, { type: 'close' });
    if (session === this.session) this.close();
  }

  private dropProbe(): void {
    void this.probe?.dispose();
    this.probe = undefined;
    this.tested = undefined;
    this.columns.clear();
  }

  /** End the open form, if any; its tab closes the next time it hears from the panel. */
  close(): void {
    this.dropProbe();
    this.generation++;
    this.session = 0;
    this.reply = undefined;
    this.editing = undefined;
    this.savedSecret = undefined;
    this.lastDraft = undefined;
  }

  /** A connection was removed: a form editing it closes, since there is nothing left to save it over. */
  removed(id: string): void {
    if (this.editing?.id !== id) return;
    this.post(this.session, { type: 'close' });
    this.close();
  }

  dispose(): void {
    this.close();
  }
}
