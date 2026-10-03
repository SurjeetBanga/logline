import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { decodeLogsRequest, decodeTraceRequest, ProtoError } from '../core/otlp-proto';
import { readLogs, readSpans, type OtlpLog, type Span } from '../core/otlp';

export type OtlpSignal = 'logs' | 'traces';
export type Decoded = { logs: OtlpLog[] } | { spans: Span[] };

/** Thrown for request bodies that are not valid OTLP; the message is safe to return to the client. */
export class MalformedRequest extends Error { }

/** Decode and normalize one OTLP request body. Used inline for small bodies and inside the worker for large ones. */
export function decodeRequest(signal: OtlpSignal, json: boolean, body: Uint8Array): Decoded {
  let request: unknown;
  try {
    request = json ? JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8'))
      : signal === 'logs' ? decodeLogsRequest(body) : decodeTraceRequest(body);
  } catch (error) {
    throw new MalformedRequest(error instanceof ProtoError || error instanceof SyntaxError ? `Malformed request: ${error.message}` : 'Malformed request.');
  }
  return signal === 'logs' ? { logs: readLogs(request) } : { spans: readSpans(request) };
}

interface Pending { worker: Worker; resolve(value: Decoded): void; reject(error: Error): void; }

/**
 * Decodes request bodies above a size threshold on a worker thread, so a
 * large export cannot stall the extension host while it is parsed.
 */
export class OtlpDecoder {
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 0;

  constructor(private readonly threshold = 1024 * 1024) { }

  decode(signal: OtlpSignal, json: boolean, body: Buffer): Promise<Decoded> {
    if (body.length < this.threshold) {
      try { return Promise.resolve(decodeRequest(signal, json, body)); } catch (error) { return Promise.reject(error); }
    }
    const worker = this.start();
    const id = ++this.next;
    // A private copy can be transferred instead of cloned.
    const copy = new Uint8Array(body);
    return new Promise<Decoded>((resolve, reject) => {
      this.pending.set(id, { worker, resolve, reject });
      worker.postMessage({ id, signal, json, body: copy }, [copy.buffer]);
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.failAll(new Error('The OpenTelemetry decoder stopped.'));
    void worker?.terminate();
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, 'otlp-worker.js'));
    worker.unref();
    worker.on('message', (message: { id: number; result?: Decoded; error?: string; malformed?: boolean }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.result) pending.resolve(message.result);
      else pending.reject(message.malformed ? new MalformedRequest(message.error) : new Error(message.error));
    });
    // A crashed worker fails its own requests; the next large request starts
    // a new one. Its exit can follow after a replacement took new requests.
    const failed = (error: Error) => { if (this.worker === worker) this.worker = undefined; this.failAll(error, worker); };
    worker.on('error', failed);
    worker.on('exit', code => failed(new Error(`The OpenTelemetry decoder exited with code ${code}.`)));
    return this.worker = worker;
  }

  private failAll(error: Error, worker?: Worker): void {
    for (const [id, pending] of this.pending) {
      if (worker && pending.worker !== worker) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
