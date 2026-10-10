import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzip, inflate } from 'node:zlib';
import { isEntrySpan, logLine, readLogs, readSpans, spanLine, type OtlpLog, type Span } from '../core/otlp';
import { MalformedRequest, OtlpDecoder } from './otlp-decoder';
import type { Settings } from '../core/settings';
import type { SpanStore } from '../core/traces';
import type { SessionSummary } from '../core/types';
import type { Ingestion } from './ingestion';
import type { RuntimeState } from './runtime-state';
import type { SessionRegistry } from './session-registry';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_DECODED = 64 * 1024 * 1024;
// Records added per turn of the event loop, so a large export arrives in
// steps the Logs panel and editor stay responsive through.
const CHUNK = 500;
export type SpanRows = 'none' | 'entry' | 'all';

export interface ReceiverStatus { running: boolean; endpoint?: string; error?: string; }

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/**
 * A local OTLP/HTTP receiver. Log records become Logline events, spans go to
 * the span store (and optionally appear as rows), and each service that
 * sends telemetry becomes a source. It binds to loopback only and refuses
 * browser requests, so web pages cannot inject telemetry.
 */
export class OtlpReceiver {
  private server?: Server;
  private readonly records = new Map<string, SessionSummary>();
  private starting?: Promise<ReceiverStatus>;
  private readonly decoder: OtlpDecoder;
  endpoint?: string;
  error?: string;
  /** The port asked for at the last start, which can differ from the one in use after a fallback. */
  requestedPort?: number;

  constructor(private readonly config: Settings, private readonly registry: SessionRegistry,
    private readonly ingestion: Ingestion, private readonly state: RuntimeState, private readonly spans: SpanStore,
    decodeThreshold?: number) {
    this.decoder = new OtlpDecoder(decodeThreshold);
  }

  get running(): boolean { return Boolean(this.server?.listening); }
  status(): ReceiverStatus { return { running: this.running, endpoint: this.endpoint, error: this.error }; }

  /** Listen on the preferred port, or an ephemeral one when it is taken. */
  start(port = this.config.get('otlp.port', 4318)): Promise<ReceiverStatus> {
    if (this.running) return Promise.resolve(this.status());
    return this.starting ??= this.listen(port).finally(() => { this.starting = undefined; });
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    this.requestedPort = undefined;
    for (const record of this.records.values()) {
      if (record.status !== 'running') continue;
      record.status = 'exited'; record.endedAt = Date.now(); record.captureComplete = true; record.exitReason = 'receiver stopped';
    }
    this.records.clear();
    this.decoder.dispose();
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      // Exporters keep connections alive; close them so shutdown does not wait on idle sockets.
      server.closeAllConnections?.();
      await closed;
      this.state.status = 'OpenTelemetry receiver stopped';
      this.state.notify();
    }
  }

  /** Accept a decoded OTLP logs request; returns the number of records ingested. */
  acceptLogs(request: unknown): number { return this.ingestLogs(readLogs(request)); }

  /** Accept a decoded OTLP traces request; returns the number of new spans. */
  acceptSpans(request: unknown): number { return this.ingestSpans(readSpans(request)); }

  private ingestLogs(logs: readonly OtlpLog[]): number {
    let accepted = 0;
    for (const log of logs) {
      const record = this.record(log.service);
      const event = this.ingestion.accept(logLine(log), 'otlp', { serverId: record.serverId, server: record.server, sessionId: record.id, persist: true });
      if (event) { record.events++; accepted++; }
    }
    if (accepted) this.state.notify();
    return accepted;
  }

  private ingestSpans(spans: readonly Span[]): number {
    const rows = this.config.get<string>('otlp.showSpans', 'entry') as SpanRows;
    let accepted = 0;
    for (const span of spans) {
      // Every sending service is a source, even without rows, so sharing it
      // with an agent also shares its spans.
      const record = this.record(span.service);
      span.sessionId = record.id;
      if (!this.spans.add(span)) continue;
      accepted++;
      if (rows === 'none' || (rows === 'entry' && !isEntrySpan(span))) continue;
      if (this.ingestion.accept(spanLine(span), 'otlp', { serverId: record.serverId, server: record.server, sessionId: record.id, persist: true })) record.events++;
    }
    if (accepted) this.state.notify();
    return accepted;
  }

  private record(service: string): SessionSummary {
    let record = this.records.get(service);
    if (record) return record;
    record = {
      id: randomBytes(8).toString('hex'), serverId: `otel:${service}`, server: `OTel · ${service}`, status: 'running', startedAt: Date.now(), events: 0,
      sourceKind: 'otel', owned: false, canStop: false, captureComplete: false, command: `${service} via OpenTelemetry`
    };
    this.records.set(service, record);
    this.registry.records.set(record.id, record);
    return record;
  }

  private listen(port: number): Promise<ReceiverStatus> {
    this.requestedPort = port;
    const attempt = (target: number) => new Promise<Server>((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      server.once('error', reject);
      server.listen(target, '127.0.0.1', () => { server.off('error', reject); resolve(server); });
    });
    return attempt(port).catch(error => {
      // Another collector already owns the port; never take it over.
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && port !== 0) return attempt(0);
      throw error;
    }).then(server => {
      server.on('error', error => { this.error = error.message; this.state.notify(); });
      this.server = server;
      const actual = (server.address() as AddressInfo).port;
      this.endpoint = `http://127.0.0.1:${actual}`;
      this.error = port === 0 || actual === port ? undefined : `Port ${port} is in use; receiving on ${actual} instead.`;
      this.state.status = `OpenTelemetry receiver on ${this.endpoint}`;
      this.state.notify();
      return this.status();
    }, error => {
      this.error = `Could not start the OpenTelemetry receiver: ${(error as Error).message}`;
      this.state.status = this.error;
      this.state.notify();
      return this.status();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: string | Buffer = '', type = 'text/plain; charset=utf-8') => {
      if (response.headersSent) return;
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    try {
      // Browsers attach Origin to cross-site requests; a Host other than
      // loopback means DNS rebinding. Neither is a local exporter.
      if (request.headers.origin !== undefined) throw new HttpError(403, 'Browser requests are not accepted.');
      const port = (this.server?.address() as AddressInfo | null)?.port;
      const host = request.headers.host ?? '';
      if (!['127.0.0.1', 'localhost', '[::1]'].some(name => host === `${name}:${port}`)) throw new HttpError(403, 'Unexpected Host header.');
      const path = (request.url ?? '').split('?')[0];
      if (request.method === 'GET' && path === '/') { reply(200, 'Logline OpenTelemetry receiver (OTLP/HTTP)\n'); return; }
      if (!['/v1/logs', '/v1/traces', '/v1/metrics'].includes(path)) throw new HttpError(404, 'Use /v1/logs or /v1/traces.');
      if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
      const contentType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const json = contentType === 'application/json';
      if (!json && contentType !== 'application/x-protobuf') throw new HttpError(415, 'Use application/json or application/x-protobuf.');
      const body = await this.readBody(request);
      // Metrics are accepted and dropped so exporters configured for every signal do not log errors.
      if (path !== '/v1/metrics') {
        const decoded = await this.decoder.decode(path === '/v1/logs' ? 'logs' : 'traces', json, body).catch(error => {
          throw error instanceof MalformedRequest ? new HttpError(400, error.message) : error;
        });
        const items: readonly (OtlpLog | Span)[] = 'logs' in decoded ? decoded.logs : decoded.spans;
        for (let start = 0; start < items.length && this.running; start += CHUNK) {
          if (start) await new Promise(resolve => setImmediate(resolve));
          const chunk = items.slice(start, start + CHUNK);
          if ('logs' in decoded) this.ingestLogs(chunk as OtlpLog[]); else this.ingestSpans(chunk as Span[]);
        }
      }
      // An empty ExportServiceResponse means full success in either encoding.
      reply(200, json ? '{}' : Buffer.alloc(0), json ? 'application/json' : 'application/x-protobuf');
    } catch (error) {
      if (error instanceof HttpError) reply(error.status, `${error.message}\n`);
      else reply(500, 'Internal error\n');
      request.resume();
    }
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    const encoding = (request.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (!['identity', 'gzip', 'deflate'].includes(encoding)) return Promise.reject(new HttpError(415, 'Unsupported content encoding.'));
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          tooLarge = true;
          // Discard the rest so the 413 reply can still be delivered.
          request.removeAllListeners('data');
          request.resume();
          reject(new HttpError(413, 'Request body is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      request.on('error', reject);
      request.on('end', () => {
        // Already refused; do not decompress the truncated body.
        if (tooLarge) return;
        const body = Buffer.concat(chunks);
        if (encoding === 'identity') { resolve(body); return; }
        (encoding === 'gzip' ? gunzip : inflate)(body, { maxOutputLength: MAX_DECODED }, (error, result) => {
          if (error) reject(new HttpError((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, 'Could not decompress the request body.'));
          else resolve(result);
        });
      });
    });
  }
}
