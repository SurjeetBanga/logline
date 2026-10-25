import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { mongoUrl, type ColumnInfo, type LogTableMapping, type MongoConnection } from '../../core/connections';
import { boundSeries, rowsToSeries } from '../../core/metric-query';
import { buildMongoLogQuery, checkMongoQuery, filterText, type MongoFilter } from '../../core/mongo-query';
import { rowRoles, rowToLine, setField, type RowRoles } from '../../core/remote-query';
import { timedOut, type Connector, type FetchRequest, type FetchResult, type MetricResult } from './types';

// The parts of the MongoDB driver this connector uses.
interface Cursor {
  sort(spec: Record<string, 1 | -1>): Cursor;
  limit(count: number): Cursor;
  maxTimeMS(ms: number): Cursor;
  toArray(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}
interface Collection {
  find(filter: MongoFilter): Cursor;
  aggregate(pipeline: MongoFilter[], options: { maxTimeMS: number }): Cursor;
  countDocuments(filter: MongoFilter, options: { maxTimeMS: number }): Promise<number>;
}
interface Database {
  collection(name: string): Collection;
  command(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  listCollections(
    filter?: MongoFilter,
    options?: { nameOnly: boolean },
  ): { toArray(): Promise<{ name: string; type?: string }[]> };
}
interface Client {
  connect(): Promise<unknown>;
  db(name: string): Database;
  close(): Promise<void>;
}
export interface MongoModule {
  MongoClient: new (url: string, options: Record<string, unknown>) => Client;
  EJSON: { parse(text: string, options?: { relaxed: boolean }): unknown };
  ObjectId: { createFromTime(seconds: number): unknown };
}

// The package bundles the driver into out/vendor/mongodb.js; tests and development builds can also load it from node_modules.
function loadMongo(): MongoModule {
  const bundled = path.join(__dirname, '..', '..', 'vendor', 'mongodb.js');
  return require(existsSync(bundled) ? bundled : 'mongodb') as MongoModule;
}

const SAMPLE = 200;
const DEPTH = 4;
const METRIC_ROWS = 50000;
/** Time stored as a date, ISO text, seconds or milliseconds, or only in the `_id`. */
type MongoTime = 'native' | 'iso' | 'epoch_s' | 'epoch_ms' | 'objectId';

const bsonType = (value: unknown): string | undefined => (value as { _bsontype?: string } | null)?._bsontype;

/** A field's type as a sample shows it: number, string, date, boolean, objectId, array, or object. */
function typeOf(value: unknown): string {
  if (value instanceof Date) return 'date';
  const bson = bsonType(value);
  if (bson === 'ObjectId' || bson === 'ObjectID') return 'objectId';
  if (bson === 'Long' || bson === 'Int32' || bson === 'Double' || bson === 'Decimal128') return 'number';
  // Binary, UUID, Timestamp, and the other BSON values are one value each, not objects to look inside.
  if (bson) return bson.toLowerCase();
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' && value !== null ? 'object' : typeof value;
}

/** A document's values as plain JSON: dates as ISO text, ids as hex, and numbers as numbers where they fit. */
export function plainDocument(value: unknown, depth = 0): unknown {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const bson = bsonType(value);
  if (bson) {
    const text = String((value as { toString(): string }).toString());
    if (bson === 'Long' || bson === 'Int32' || bson === 'Double' || bson === 'Decimal128') {
      const number = Number(text);
      return Number.isSafeInteger(number) || (Number.isFinite(number) && !Number.isInteger(number)) ? number : text;
    }
    if (bson === 'Binary') return `<${(value as { length?: () => number }).length?.() ?? 0} bytes>`;
    return (value as { toHexString?: () => string }).toHexString?.() ?? text;
  }
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((item) => plainDocument(item, depth + 1));
  if (value && typeof value === 'object') {
    const plain: Record<string, unknown> = {};
    for (const key in value)
      if (Object.hasOwn(value, key))
        setField(plain, key, plainDocument((value as Record<string, unknown>)[key], depth + 1));
    return plain;
  }
  return value;
}

/** Every field path in a sample of documents, nested objects included to a few levels, with the type seen most. */
export function sampleFields(documents: Record<string, unknown>[]): ColumnInfo[] {
  const seen = new Map<string, Map<string, number>>();
  const visit = (value: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      const type = typeOf(item);
      if (type === 'object' && depth < DEPTH) visit(item as Record<string, unknown>, name, depth + 1);
      else {
        const counts = seen.get(name) ?? new Map<string, number>();
        counts.set(type, (counts.get(type) ?? 0) + 1);
        seen.set(name, counts);
      }
    }
  };
  for (const document of documents) visit(document, '', 0);
  return [...seen.entries()].map(([name, counts]) => ({
    name,
    type: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0],
  }));
}

function valueAt(document: Record<string, unknown>, field: string): unknown {
  if (Object.hasOwn(document, field)) return document[field];
  let value: unknown = document;
  for (const part of field.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Searches a log collection in MongoDB, and runs read-only filters and pipelines typed by a person. */
export class MongoConnector implements Connector {
  private client?: Promise<Client>;
  private described?: Promise<{ fields: ColumnInfo[]; time: MongoTime }>;

  constructor(
    readonly connection: MongoConnection,
    /** The password for the URL's user, kept in secret storage. */
    private readonly password: string | undefined,
    private readonly timeoutMs: () => number,
    private readonly load: () => MongoModule = loadMongo,
  ) {}

  get mapping(): LogTableMapping | undefined {
    return this.connection.logs;
  }

  private module?: MongoModule;
  private driver(): MongoModule {
    this.module ??= this.load();
    return this.module;
  }

  private database(): Promise<Database> {
    this.client ??= (async () => {
      const url = mongoUrl(this.connection.url);
      const client = new (this.driver().MongoClient)(this.connection.url, {
        appName: 'Logline',
        // Reads go to a secondary when there is one, away from the primary's writes.
        readPreference: 'secondaryPreferred',
        serverSelectionTimeoutMS: this.timeoutMs(),
        connectTimeoutMS: this.timeoutMs(),
        ...(url?.user && this.password !== undefined ? { auth: { username: url.user, password: this.password } } : {}),
      });
      await client.connect();
      return client;
    })().catch((error: unknown) => {
      this.client = undefined;
      throw error;
    });
    return this.client.then((client) => client.db(this.connection.database));
  }

  /** Run a read, turning the server's time limit into the same error as the other stores. */
  private async read<T>(work: (database: Database) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('The query was cancelled.');
    try {
      return await work(await this.database());
    } catch (error) {
      const failure = error as { code?: number; codeName?: string; name?: string };
      if (failure.code === 50 || failure.codeName === 'MaxTimeMSExpired') throw timedOut(this.timeoutMs());
      // A lost connection is opened again on the next read.
      if (failure.name === 'MongoNetworkError' || failure.name === 'MongoServerSelectionError') void this.dispose();
      throw error;
    }
  }

  async test(): Promise<string> {
    return this.read(async (database) => {
      const info = await database.command({ buildInfo: 1 });
      const collections = await database.listCollections({}, { nameOnly: true }).toArray();
      return `MongoDB ${String(info.version ?? '')} · ${collections.length} collection${collections.length === 1 ? '' : 's'}`;
    });
  }

  async tables(): Promise<string[]> {
    return this.read(async (database) =>
      (await database.listCollections({}, { nameOnly: true }).toArray())
        .filter((item) => item.type !== 'system' && !item.name.startsWith('system.'))
        .map((item) => item.name)
        .sort(),
    );
  }

  /** The fields of a collection, from a sample of its documents. */
  async columns(collection: string): Promise<ColumnInfo[]> {
    return this.read(async (database) => {
      const documents = await database
        .collection(collection)
        .aggregate([{ $sample: { size: SAMPLE } }], { maxTimeMS: this.timeoutMs() })
        .toArray();
      return sampleFields(documents);
    });
  }

  /** The mapped collection's fields and how its time is stored, read once per connection. */
  private describe(): Promise<{ fields: ColumnInfo[]; time: MongoTime }> {
    const mapping = this.mapping;
    if (!mapping) return Promise.reject(new Error('Map a log collection for this connection first, or use Run query.'));
    this.described ??= (async () => {
      const fields = await this.columns(mapping.table);
      if (!fields.length) throw new Error(`Collection ${mapping.table} is empty or was not found.`);
      if (mapping.timestamp === '_id') return { fields, time: 'objectId' as const };
      const type = fields.find((field) => field.name === mapping.timestamp)?.type;
      const time: MongoTime =
        mapping.timestampFormat ??
        (type === 'date'
          ? 'native'
          : type === 'objectId'
            ? 'objectId'
            : type === 'number'
              ? await this.epoch(mapping)
              : 'iso');
      return { fields, time };
    })().catch((error: unknown) => {
      this.described = undefined;
      throw error;
    });
    return this.described;
  }

  private async epoch(mapping: LogTableMapping): Promise<MongoTime> {
    const [document] = await this.read((database) =>
      database
        .collection(mapping.table)
        .find({ [mapping.timestamp]: { $exists: true } })
        .limit(1)
        .maxTimeMS(this.timeoutMs())
        .toArray(),
    );
    const value = Number(plainDocument(valueAt(document ?? {}, mapping.timestamp)));
    return Math.abs(value) < 1e11 ? 'epoch_s' : 'epoch_ms';
  }

  /** The filter on the time field for a range, in the form the field stores time. */
  private timeFilter(time: MongoTime, fromMs?: number, toMs?: number): MongoFilter {
    if (fromMs === undefined && toMs === undefined) return {};
    const field = this.mapping!.timestamp;
    const at = (ms: number): unknown =>
      time === 'native'
        ? new Date(ms)
        : time === 'iso'
          ? new Date(ms).toISOString()
          : time === 'epoch_s'
            ? ms / 1000
            : time === 'epoch_ms'
              ? ms
              : this.driver().ObjectId.createFromTime(Math.floor(ms / 1000));
    return {
      [field]: {
        ...(fromMs !== undefined ? { $gte: at(fromMs) } : {}),
        ...(toMs !== undefined ? { $lte: at(toMs) } : {}),
      },
    };
  }

  private build(query: string, fields: ColumnInfo[], time: MongoTime, fromMs?: number, toMs?: number) {
    const built = buildMongoLogQuery({ mapping: this.mapping!, fields, query });
    const from = Math.max(fromMs ?? -Infinity, built.fromMs ?? -Infinity);
    const to = Math.min(toMs ?? Infinity, built.toMs ?? Infinity);
    const range = this.timeFilter(time, Number.isFinite(from) ? from : undefined, Number.isFinite(to) ? to : undefined);
    const parts = [range, built.filter].filter((part) => Object.keys(part).length);
    const filter = parts.length > 1 ? { $and: parts } : (parts[0] ?? {});
    const sortField = this.mapping!.timestamp;
    return { built, filter, sortField };
  }

  private roles(fields: ColumnInfo[], time: MongoTime): RowRoles {
    const mapping = this.mapping!;
    return {
      ...rowRoles(
        fields.map((field) => field.name),
        mapping,
      ),
      // An ObjectId holds when it was made; the line reads that time from a field of its own.
      timestamp: time === 'objectId' ? `${mapping.timestamp} time` : mapping.timestamp,
    };
  }

  /** A document as a JSON log line, with its mapped fields where Logline reads them, nested ones too. */
  private record(document: Record<string, unknown>, roles: RowRoles, time: MongoTime) {
    const row = plainDocument(document) as Record<string, unknown>;
    if (time === 'objectId') {
      const id = valueAt(row, this.mapping!.timestamp);
      if (typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id))
        row[`${this.mapping!.timestamp} time`] = new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString();
    }
    for (const field of Object.values(roles))
      if (field && field.includes('.') && !Object.hasOwn(row, field)) row[field] = valueAt(row, field);
    return rowToLine(row, roles, time === 'native' || time === 'objectId' ? 'iso' : time);
  }

  async preview(query: string, fromMs?: number, toMs?: number): Promise<{ statement: string; local: string[] }> {
    const { fields, time } = await this.describe();
    const { built, filter, sortField } = this.build(query, fields, time, fromMs, toMs);
    return {
      statement: `db.${this.mapping!.table}.find(${filterText(filter)}).sort({ "${sortField}": -1 })`,
      local: built.local,
    };
  }

  async fetchLogs(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    const { fields, time } = await this.describe();
    const { built, filter, sortField } = this.build(request.query, fields, time, request.fromMs, request.toMs);
    const collection = this.mapping!.table;
    const documents = await this.read(
      (database) =>
        database
          .collection(collection)
          .find(filter)
          .sort({ [sortField]: request.order === 'desc' ? -1 : 1 })
          .limit(request.limit)
          .maxTimeMS(this.timeoutMs())
          .toArray(),
      signal,
    );
    let total: number | undefined;
    if (request.countTotal && documents.length >= request.limit)
      total = await this.read(
        (database) => database.collection(collection).countDocuments(filter, { maxTimeMS: this.timeoutMs() }),
        signal,
      );
    const roles = this.roles(fields, time);
    return {
      records: documents.map((document) => this.record(document, roles, time)),
      ...(total !== undefined ? { total } : {}),
      pushed: built.pushed,
      local: built.local,
      statement: `db.${collection}.find(${filterText(filter)})`,
      elapsedMs: Date.now() - started,
    };
  }

  /** Parse and check a typed query: Extended JSON, a filter or a pipeline that only reads. */
  private typed(text: string) {
    let value: unknown;
    try {
      value = this.driver().EJSON.parse(text, { relaxed: true });
    } catch (error) {
      throw new Error(`Write the query as JSON, such as { "level": "error" }: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const checked = checkMongoQuery(value);
    if ('error' in checked) throw new Error(checked.error);
    return checked;
  }

  /** A typed filter or pipeline on the mapped collection, or on the collection the connection names. */
  private collectionFor(): string {
    const collection = this.mapping?.table;
    if (!collection) throw new Error('Choose a log collection for this connection to run queries on.');
    return collection;
  }

  async runSql(text: string, limit: number, signal?: AbortSignal): Promise<FetchResult> {
    const started = Date.now();
    const checked = this.typed(text);
    const collection = this.collectionFor();
    const documents = await this.read(
      (database) =>
        checked.kind === 'filter'
          ? database.collection(collection).find(checked.filter).limit(limit).maxTimeMS(this.timeoutMs()).toArray()
          : database
              .collection(collection)
              .aggregate([...checked.pipeline, { $limit: limit }], { maxTimeMS: this.timeoutMs() })
              .toArray(),
      signal,
    );
    const plain = documents.map((document) => plainDocument(document) as Record<string, unknown>);
    const roles = rowRoles(Object.keys(plain[0] ?? {}), this.mapping);
    return {
      records: plain.map((row) => rowToLine(row, roles, 'auto')),
      pushed: [],
      local: [],
      statement: text.trim(),
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * A typed pipeline that returns a time, a value, and optionally fields that
   * name series, such as one that groups by minute. Points outside the range are dropped.
   */
  async queryMetrics(text: string, fromMs: number, toMs: number, signal?: AbortSignal): Promise<MetricResult> {
    const started = Date.now();
    const checked = this.typed(text);
    if (checked.kind !== 'pipeline') throw new Error('A metric query is a pipeline that returns a time and a value.');
    const collection = this.collectionFor();
    const documents = await this.read(
      (database) =>
        database
          .collection(collection)
          .aggregate([...checked.pipeline, { $limit: METRIC_ROWS }], { maxTimeMS: this.timeoutMs() })
          .toArray(),
      signal,
    );
    const rows = documents.map((document) => {
      const row = plainDocument(document) as Record<string, unknown>;
      // A $group result keeps its key in _id; read a plain one as the time.
      if (row._id !== undefined && typeof row._id !== 'object' && row.time === undefined) {
        row.time = row._id;
        delete row._id;
      }
      return row;
    });
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    const series = rowsToSeries(rows, name)
      .map((one) => ({ ...one, points: one.points.filter(([time]) => time >= fromMs && time <= toMs) }))
      .filter((one) => one.points.length);
    return { series: boundSeries(series), statement: text.trim(), elapsedMs: Date.now() - started };
  }

  /** MongoDB has no catalog of metrics; pipelines are typed. */
  listMetrics(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.described = undefined;
    await client?.then((open) => open.close()).catch(() => undefined);
  }
}
