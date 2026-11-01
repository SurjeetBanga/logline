import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestJson, retryAfter, type Fetch } from './http';

const base = { service: 'Example at https://logs.example.com', method: 'POST' as const, timeoutMs: 1000 };

test('a request sends JSON and reads the answer, error statuses included', async () => {
  let sent: RequestInit | undefined;
  const fetcher: Fetch = async (_url, init) => {
    sent = init;
    return new Response('{"errors":["no"]}', { status: 403 });
  };
  const answer = await requestJson({
    ...base,
    url: 'https://logs.example.com/search',
    headers: {},
    body: { q: 1 },
    fetcher,
  });
  assert.equal(sent?.body, '{"q":1}');
  assert.deepEqual(sent?.headers, { accept: 'application/json', 'content-type': 'application/json' });
  assert.equal(answer.ok, false);
  assert.equal(answer.status, 403);
  assert.deepEqual(answer.json, { errors: ['no'] });
  // A body that is not JSON is kept as text.
  const html = await requestJson({ ...base, url: 'x', headers: {}, fetcher: async () => new Response('<html>') });
  assert.equal(html.json, undefined);
  assert.equal(html.text, '<html>');
});

test('a request that gets no answer says why', async () => {
  const unreachable: Fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(requestJson({ ...base, url: 'x', headers: {}, fetcher: unreachable }), {
    message: 'Could not reach Example at https://logs.example.com: ECONNREFUSED',
  });
  const hang: Fetch = (_url, init) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  // AbortSignal.timeout does not keep the process alive, as the editor does; this timer does, while it waits.
  const alive = setTimeout(() => undefined, 5000);
  try {
    await assert.rejects(requestJson({ ...base, timeoutMs: 10, url: 'x', headers: {}, fetcher: hang }), {
      message: 'The query took longer than 10 ms and was stopped.',
    });
  } finally {
    clearTimeout(alive);
  }
  const cancel = new AbortController();
  const cancelled = requestJson({ ...base, url: 'x', headers: {}, signal: cancel.signal, fetcher: hang });
  cancel.abort();
  await assert.rejects(cancelled, { message: 'The query was cancelled.' });
});

test('a rate limit tells a tail how long to wait', () => {
  const error = retryAfter('Slow down.', 5000) as Error & { retryAfterMs: number };
  assert.equal(error.message, 'Slow down.');
  assert.equal(error.retryAfterMs, 5000);
});
