// Turns what a browser reports over the Chrome DevTools Protocol (console calls, uncaught
// exceptions, its own log entries, and network requests) into the JSON records Logline
// ingests as log lines. Nothing here talks to a browser; `capture/browser-capture.ts` does.

type Json = Record<string, unknown>;

/** Which requests become events: page loads and API calls, every request, or none. */
export type RequestMode = 'api' | 'all' | 'off';
export const REQUEST_MODES: readonly RequestMode[] = ['api', 'all', 'off'];

/** One browser event as a JSON log line's fields. */
export interface BrowserRecord {
  timestamp: string;
  level: string;
  message: string;
  /** What reported it: a console call, an uncaught exception, the browser itself, or a request. */
  kind: 'console' | 'exception' | 'browser' | 'request';
  [field: string]: unknown;
}

const MAX_ARGUMENTS = 10;
const MAX_ARGUMENT = 1000;
const MAX_MESSAGE = 8000;
const MAX_URL = 2000;
const MAX_PENDING = 2000;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length)}…` : value);

function iso(ms: number | undefined, now: number): string {
  // A page can report any number; one a Date cannot hold falls back to the arrival time.
  const time = ms !== undefined && Math.abs(ms) <= 8.64e15 ? ms : now;
  return new Date(time).toISOString();
}

/** A console argument or thrown value as text: its value, or the browser's description of an object. */
function describe(value: unknown): string {
  if (!isObject(value)) return '';
  if (typeof value.value === 'string') return value.value;
  if (typeof value.value === 'number' || typeof value.value === 'boolean') return String(value.value);
  if (typeof value.unserializableValue === 'string') return value.unserializableValue;
  if (value.type === 'undefined') return 'undefined';
  if (value.subtype === 'null') return 'null';
  const preview = isObject(value.preview) ? value.preview : undefined;
  const properties = preview && Array.isArray(preview.properties) ? preview.properties.filter(isObject) : [];
  // An error's description is its message and stack; other objects are clearer by their properties.
  if (value.subtype !== 'error' && properties.length) {
    const array = value.subtype === 'array';
    const parts = properties.map((property) => {
      const shown = property.type === 'string' ? JSON.stringify(property.value ?? '') : String(property.value ?? '');
      return array ? shown : `${String(property.name)}: ${shown}`;
    });
    if (preview?.overflow) parts.push('…');
    return array ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`;
  }
  return text(value.description) ?? text(value.className) ?? String(value.type ?? '');
}

/** Console arguments as one line, applying `%s`-style specifiers and dropping `%c` styles. */
export function formatArguments(args: unknown): string {
  const values = Array.isArray(args) ? args.slice(0, MAX_ARGUMENTS) : [];
  const parts: string[] = [];
  let next = 0;
  const first = values[0];
  if (isObject(first) && typeof first.value === 'string' && first.value.includes('%')) {
    next = 1;
    parts.push(
      first.value.replace(/%([sdifoOc%])/g, (match, specifier: string) => {
        if (specifier === '%') return '%';
        if (next >= values.length) return match;
        const value = clip(describe(values[next++]), MAX_ARGUMENT);
        return specifier === 'c' ? '' : value;
      }),
    );
  }
  for (; next < values.length; next++) parts.push(clip(describe(values[next]), MAX_ARGUMENT));
  return clip(parts.join(' ').trim(), MAX_MESSAGE);
}

const CONSOLE_LEVELS: Record<string, string> = {
  error: 'error',
  assert: 'error',
  warning: 'warn',
  debug: 'debug',
  trace: 'trace',
};

/** The top frame of a stack as `url:line`, with the line counted from 1 as editors do. */
function topFrame(stack: unknown): string | undefined {
  const frames = isObject(stack) && Array.isArray(stack.callFrames) ? stack.callFrames : [];
  const frame = frames.find((item) => isObject(item) && text(item.url));
  if (!isObject(frame)) return undefined;
  const line = number(frame.lineNumber);
  return clip(`${String(frame.url)}${line !== undefined ? `:${line + 1}` : ''}`, MAX_URL);
}

/** A record for `Runtime.consoleAPICalled`; undefined for calls that say nothing, such as `console.clear`. */
export function consoleRecord(params: unknown, now = Date.now()): BrowserRecord | undefined {
  if (!isObject(params)) return undefined;
  const type = text(params.type) ?? 'log';
  if (type === 'clear' || type === 'endGroup' || type === 'profile' || type === 'profileEnd') return undefined;
  const message = formatArguments(params.args);
  if (!message) return undefined;
  const at = topFrame(params.stackTrace);
  return {
    timestamp: iso(number(params.timestamp), now),
    level: CONSOLE_LEVELS[type] ?? 'info',
    message,
    kind: 'console',
    ...(at ? { at } : {}),
  };
}

/** A record for `Runtime.exceptionThrown`: the error with its stack, so it reads as an exception. */
export function exceptionRecord(params: unknown, now = Date.now()): BrowserRecord | undefined {
  if (!isObject(params) || !isObject(params.exceptionDetails)) return undefined;
  const details = params.exceptionDetails;
  const thrown = describe(details.exception);
  // "Uncaught" alone says nothing; the thrown value's description holds the message and stack.
  const message = thrown || text(details.text) || 'Uncaught exception';
  const line = number(details.lineNumber);
  const at =
    topFrame(details.stackTrace) ??
    (text(details.url) ? `${String(details.url)}${line !== undefined ? `:${line + 1}` : ''}` : undefined);
  // The first line is the message; the whole text, when it has frames, is the stack the details show.
  const first = message.split('\n', 1)[0];
  // "Uncaught (in promise)" for a rejection nothing handled, which reads differently from a throw.
  const said = text(details.text) ?? '';
  const prefix = thrown && /^Uncaught\b/.test(said) ? said.replace(/:\s*$/, '') : 'Uncaught';
  return {
    timestamp: iso(number(params.timestamp), now),
    level: 'error',
    message: clip(/^Uncaught\b/.test(first) ? first : `${prefix} ${first}`, MAX_ARGUMENT),
    kind: 'exception',
    ...(message.includes('\n') ? { stack: clip(message, MAX_MESSAGE) } : {}),
    ...(at ? { at: clip(at, MAX_URL) } : {}),
  };
}

const LOG_LEVELS: Record<string, string> = { verbose: 'debug', info: 'info', warning: 'warn', error: 'error' };

/**
 * A record for `Log.entryAdded`: what the browser itself reports, such as a request blocked by CORS or
 * a Content Security Policy. With `requests` captured, its "Failed to load resource" lines are left
 * out, since the request's own event says the same with more detail.
 */
export function browserLogRecord(params: unknown, requests: RequestMode, now = Date.now()): BrowserRecord | undefined {
  const entry = isObject(params) && isObject(params.entry) ? params.entry : undefined;
  const message = entry && text(entry.text);
  if (!entry || !message) return undefined;
  if (requests !== 'off' && message.startsWith('Failed to load resource')) return undefined;
  const line = number(entry.lineNumber);
  const url = text(entry.url);
  return {
    timestamp: iso(number(entry.timestamp), now),
    level: LOG_LEVELS[text(entry.level) ?? ''] ?? 'info',
    message: clip(message, MAX_MESSAGE),
    kind: 'browser',
    ...(text(entry.source) ? { reporter: entry.source } : {}),
    ...(url ? { at: clip(`${url}${line !== undefined ? `:${line + 1}` : ''}`, MAX_URL) } : {}),
  };
}

const API_TYPES = new Set(['document', 'fetch', 'xhr', 'websocket', 'eventsource']);

/** Whether a request of this type becomes an event; one that failed does unless requests are off. */
export function wantsRequest(type: string | undefined, failed: boolean, mode: RequestMode): boolean {
  if (mode === 'off') return false;
  return mode === 'all' || failed || API_TYPES.has((type ?? '').toLowerCase());
}

/** The trace id of a W3C `traceparent` header among a request's headers. */
export function traceIdOf(headers: unknown): string | undefined {
  if (!isObject(headers)) return undefined;
  for (const name in headers) {
    if (name.toLowerCase() !== 'traceparent') continue;
    const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}/.exec(String(headers[name]).trim());
    if (match && !/^0+$/.test(match[1])) return match[1];
  }
  return undefined;
}

interface Pending {
  method: string;
  url: string;
  type?: string;
  /** Seconds on the browser's monotonic clock, and since the epoch, when the request started. */
  started: number;
  wall?: number;
  traceId?: string;
  status?: number;
  mime?: string;
  /** When the response's headers arrived: on the browser's clock, and on this machine's in milliseconds. */
  responded?: number;
  respondedAt?: number;
  /** When any of the body last arrived, on this machine's clock. */
  activeAt?: number;
  /** Already reported by `sweep`; kept so that a failure after it is still reported. */
  reported?: boolean;
}

/** A response none of whose body has arrived for this long is reported as it stands. */
export const UNREAD_RESPONSE_MS = 2000;

/**
 * Joins the events of one network request into a single record when it ends, so a request is one
 * line with its status and duration. Requests still in flight are bounded; the oldest are forgotten.
 *
 * A browser only reports a request finished once its body was read. A page that never reads it, as
 * code that throws on a failed status does, would leave the request unreported, so `sweep` reports a
 * request whose response has gone quiet: answered, with none of its body arriving for a while. A
 * response that is still streaming is left until it ends. A request reported this way stays known,
 * so a failure that ends it later is reported too; its ordinary end is not reported twice.
 */
export class RequestTracker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly mode: () => RequestMode) {}

  get size(): number {
    return this.pending.size;
  }

  /** Forget requests in flight, such as when their page's session ends. */
  clear(prefix = ''): void {
    for (const id of [...this.pending.keys()]) if (id.startsWith(prefix)) this.pending.delete(id);
  }

  /**
   * Handle one `Network.*` event; returns a record when it ends a request worth showing. `scope`
   * keeps the request ids of different tabs apart.
   */
  handle(method: string, params: unknown, scope = '', now = Date.now()): BrowserRecord | undefined {
    if (!isObject(params) || typeof params.requestId !== 'string' || this.mode() === 'off') return undefined;
    const id = `${scope}:${params.requestId}`;
    switch (method) {
      case 'Network.requestWillBeSent': {
        const request = isObject(params.request) ? params.request : {};
        const url = text(request.url) ?? '';
        // A redirect reuses the request id: the hop before it ends with the redirect's status.
        const earlier = this.pending.get(id);
        const redirect = isObject(params.redirectResponse) ? params.redirectResponse : undefined;
        const record =
          earlier && redirect
            ? this.finish(id, earlier, number(params.timestamp), now, { status: number(redirect.status) })
            : undefined;
        this.pending.delete(id);
        if (/^https?:/i.test(url)) {
          if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
          this.pending.set(id, {
            method: text(request.method) ?? 'GET',
            url,
            type: text(params.type),
            started: number(params.timestamp) ?? 0,
            wall: number(params.wallTime),
            traceId: traceIdOf(request.headers),
          });
        }
        return record;
      }
      case 'Network.webSocketCreated': {
        const url = text(params.url) ?? '';
        if (!/^wss?:/i.test(url)) return undefined;
        if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(id, { method: 'GET', url, type: 'WebSocket', started: 0 });
        return undefined;
      }
      // A socket still known here never completed its handshake: the server was down, or refused it.
      case 'Network.webSocketFrameError':
      case 'Network.webSocketClosed': {
        const request = this.pending.get(id);
        if (!request || request.type !== 'WebSocket') return undefined;
        return this.finish(id, request, number(params.timestamp), now, {
          failure: text(params.errorMessage) ?? 'closed before it connected',
        });
      }
      case 'Network.webSocketWillSendHandshakeRequest': {
        const request = this.pending.get(id);
        if (request) {
          request.started = number(params.timestamp) ?? 0;
          request.wall = number(params.wallTime);
        }
        return undefined;
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const request = this.pending.get(id);
        const response = isObject(params.response) ? params.response : {};
        return request
          ? this.finish(id, request, number(params.timestamp), now, { status: number(response.status) })
          : undefined;
      }
      case 'Network.responseReceived': {
        const request = this.pending.get(id);
        const response = isObject(params.response) ? params.response : {};
        if (request) {
          request.status = number(response.status);
          request.mime = text(response.mimeType);
          request.type ??= text(params.type);
          request.traceId ??= traceIdOf(response.headers);
          request.responded = number(params.timestamp);
          request.respondedAt = now;
        }
        return undefined;
      }
      case 'Network.dataReceived': {
        const request = this.pending.get(id);
        if (request) request.activeAt = now;
        return undefined;
      }
      case 'Network.loadingFinished': {
        const request = this.pending.get(id);
        if (request?.reported) this.pending.delete(id);
        return request && !request.reported
          ? this.finish(id, request, number(params.timestamp), now, { bytes: number(params.encodedDataLength) })
          : undefined;
      }
      case 'Network.loadingFailed': {
        const request = this.pending.get(id);
        if (!request) return undefined;
        request.type ??= text(params.type);
        const reason = text(params.blockedReason) ?? text(params.errorText) ?? 'failed';
        // Already reported with its answer: only a real failure after that is news.
        if (request.reported) {
          this.pending.delete(id);
          if (params.canceled === true) return undefined;
          request.status = undefined;
        }
        return this.finish(id, request, number(params.timestamp), now, {
          failure: params.canceled === true ? 'canceled' : reason,
        });
      }
      default:
        return undefined;
    }
  }

  /**
   * Records for requests answered at least `afterMs` ago with none of their body arriving since: the
   * page is not reading them. Each is reported once, with the time its headers took, beside the
   * `scope` its events were handled with.
   */
  sweep(now = Date.now(), afterMs = UNREAD_RESPONSE_MS): [scope: string, record: BrowserRecord][] {
    const records: [string, BrowserRecord][] = [];
    for (const [id, request] of [...this.pending]) {
      if (request.reported || request.respondedAt === undefined) continue;
      if (now - Math.max(request.respondedAt, request.activeAt ?? 0) < afterMs) continue;
      const record = this.finish(id, request, request.responded, now, {}, true);
      // Unwanted requests, such as a script in `api` mode, are not worth remembering either.
      if (record) records.push([id.slice(0, id.indexOf(':')), record]);
      else this.pending.delete(id);
    }
    return records;
  }

  private finish(
    id: string,
    request: Pending,
    ended: number | undefined,
    now: number,
    result: { status?: number; bytes?: number; failure?: string },
    keep = false,
  ): BrowserRecord | undefined {
    if (keep) request.reported = true;
    else this.pending.delete(id);
    const status = result.status ?? request.status;
    // A request canceled after it was answered was answered: the page dropped the body unread.
    if (result.failure === 'canceled' && status !== undefined) result = { ...result, failure: undefined };
    // A request the page itself canceled, such as on navigation, is not a failure of the app.
    const canceled = result.failure === 'canceled';
    const failed = (!!result.failure && !canceled) || (status !== undefined && status >= 400);
    if (!wantsRequest(request.type, failed, this.mode())) return undefined;
    const durationMs =
      ended !== undefined && request.started > 0 && ended >= request.started
        ? Math.round((ended - request.started) * 1000)
        : undefined;
    let path = request.url;
    let host: string | undefined;
    try {
      const parsed = new URL(request.url);
      path = parsed.pathname;
      host = parsed.host;
    } catch {
      // Kept as the browser reported it.
    }
    const outcome = result.failure ?? (status !== undefined ? String(status) : 'no response');
    return {
      timestamp: iso(request.wall !== undefined ? request.wall * 1000 + (durationMs ?? 0) : undefined, now),
      level: failed && (result.failure || status! >= 500) ? 'error' : failed ? 'warn' : 'info',
      message: `${request.method} ${clip(path, 200)} ${outcome}${durationMs !== undefined ? ` (${durationMs} ms)` : ''}`,
      kind: 'request',
      method: request.method,
      url: clip(request.url, MAX_URL),
      path: clip(path, MAX_URL),
      ...(host ? { host } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(request.type ? { type: request.type.toLowerCase() } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(result.bytes !== undefined ? { bytes: Math.round(result.bytes) } : {}),
      ...(request.mime ? { contentType: request.mime } : {}),
      ...(result.failure ? { failure: clip(result.failure, 200) } : {}),
      ...(request.traceId ? { traceId: request.traceId } : {}),
    };
  }
}

// The host must end there: `localhost.example.com` and `127.0.0.1.nip.io` are other machines.
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?![\w-]|\.[\w-])(?::\d{1,5})?(?:\/[^\s"'<>)\]]*)?/gi;
// Colours and cursor moves (CSI), and hyperlinks and titles (OSC), which sit against an address in a terminal's output.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The local addresses a dev server printed, such as `http://localhost:5173/`, in the order they
 * appear. An address a server listens on but a browser cannot open (`0.0.0.0`, `[::]`) becomes `localhost`.
 */
export function localUrls(output: string): string[] {
  const found = new Set<string>();
  const plain = output.slice(0, 65536).replace(ESCAPES, ' ');
  for (const match of plain.matchAll(LOCAL_URL)) {
    const url = match[0].replace(/[.,;:]+$/, '').replace(/\/\/(?:0\.0\.0\.0|\[::\])/i, '//localhost');
    found.add(url);
    if (found.size >= 10) break;
  }
  return [...found];
}

/** A URL a person typed, as one a browser can open: `localhost:3000` gains `http://`. Undefined when it is not http(s). */
export function browserUrl(input: string): string | undefined {
  const typed = input.trim();
  if (!typed || typed.length > MAX_URL || /\s/.test(typed)) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The source a browser's events are captured under: one per site, so reruns of it are runs of one source. */
export function browserSource(url: string): { serverId: string; server: string } {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Named by what was given.
  }
  return { serverId: `browser:${host}`, server: `Browser · ${host}` };
}
