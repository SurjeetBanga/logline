import { parentPort } from 'node:worker_threads';
import { decodeRequest, MalformedRequest, type OtlpSignal } from './otlp-decoder';

// Worker thread entry for OtlpDecoder: decodes one request body per message.
parentPort?.on(
  'message',
  ({ id, signal, json, body }: { id: number; signal: OtlpSignal; json: boolean; body: Uint8Array }) => {
    try {
      parentPort!.postMessage({ id, result: decodeRequest(signal, json, body) });
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
        malformed: error instanceof MalformedRequest,
      });
    }
  },
);
