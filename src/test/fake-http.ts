import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

type Json = Record<string, unknown>;

/** A request a fake service received. */
export interface FakeRequest {
  method: string;
  path: string;
  url: URL;
  /** The body: parsed when it is JSON, else empty. */
  body: Json;
  text: string;
  headers: IncomingHttpHeaders;
}

export interface FakeAnswer {
  status: number;
  payload: unknown;
  headers?: Record<string, string>;
}

/**
 * An HTTP API on 127.0.0.1 for tests and local trials. `answer` says what each request gets; every request is
 * kept in `requests`, in order.
 */
export async function startFakeHttp(answer: (request: FakeRequest) => FakeAnswer | Promise<FakeAnswer>) {
  const requests: FakeRequest[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Json = {};
      try {
        body = text ? (JSON.parse(text) as Json) : {};
      } catch {
        body = {};
      }
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      const request = {
        method: incoming.method ?? 'GET',
        path: url.pathname,
        url,
        body,
        text,
        headers: incoming.headers,
      };
      requests.push(request);
      const { status, payload, headers } = await answer(request);
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
