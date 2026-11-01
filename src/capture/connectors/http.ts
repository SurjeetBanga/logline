import { errorText, timedOut } from './types';

export type Json = Record<string, unknown>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** An answer from a log service's HTTP API; `json` is undefined when the body is not JSON. */
export interface JsonAnswer {
  ok: boolean;
  status: number;
  headers: Headers;
  json: Json | undefined;
  text: string;
}

export const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

/**
 * Send one request to a log service and read its answer, stopped after
 * `timeoutMs` or when `signal` is aborted. A request that never got an answer
 * throws a sentence that says why; any answer, error statuses included, is
 * returned for the connector to explain in its service's terms.
 */
export async function requestJson(request: {
  /** The service, and where it was reached, for messages: `Datadog at https://api.datadoghq.com`. */
  service: string;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  fetcher: Fetch;
}): Promise<JsonAnswer> {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  if (request.body !== undefined) headers['content-type'] ??= 'application/json';
  const timeout = AbortSignal.timeout(request.timeoutMs);
  let response: Response;
  try {
    response = await request.fetcher(request.url, {
      method: request.method,
      headers,
      ...(request.body !== undefined
        ? { body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body) }
        : {}),
      signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (request.signal?.aborted) throw new Error('The query was cancelled.');
    if (timeout.aborted) throw timedOut(request.timeoutMs);
    throw new Error(`Could not reach ${request.service}: ${errorText(error)}`);
  }
  const text = await response.text();
  let json: Json | undefined;
  try {
    json = text ? object(JSON.parse(text)) : {};
  } catch {
    json = undefined;
  }
  return { ok: response.ok, status: response.status, headers: response.headers, json, text };
}

/** An error that tells a tail how long to wait before reading again, such as after a rate limit. */
export function retryAfter(message: string, retryAfterMs: number): Error {
  return Object.assign(new Error(message), { retryAfterMs });
}
