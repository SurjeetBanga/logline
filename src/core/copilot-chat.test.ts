import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishedTools, markdownText, plainMessage, replayChatLine, replyText } from './copilot-chat';

test('replaying sets, pushes, replaces from a start, and deletes', () => {
  let state = replayChatLine(undefined, { kind: 0, v: { requests: [{ response: ['a', 'b', 'c'] }], title: 'x' } });
  state = replayChatLine(state, { kind: 2, k: ['requests', 0, 'response'], v: ['d'] });
  assert.deepEqual((state!.requests as any)[0].response, ['a', 'b', 'c', 'd']);
  state = replayChatLine(state, { kind: 2, k: ['requests', 0, 'response'], v: ['B'], i: 1 });
  assert.deepEqual((state!.requests as any)[0].response, ['a', 'B']);
  state = replayChatLine(state, { kind: 2, k: ['requests', 0, 'response'], v: [], i: 0 });
  assert.deepEqual((state!.requests as any)[0].response, []);
  state = replayChatLine(state, { kind: 2, k: ['requests', 0, 'followups'], v: ['f'] });
  assert.deepEqual((state!.requests as any)[0].followups, ['f']);
  state = replayChatLine(state, { kind: 3, k: ['title'] });
  assert.equal(state!.title, undefined);
  state = replayChatLine(state, { kind: 2, k: ['requests'], v: [{ requestId: 'r2' }] });
  state = replayChatLine(state, { kind: 3, k: ['requests', 0] });
  assert.deepEqual(state!.requests, [{ requestId: 'r2' }]);
  // What cannot be applied leaves the session as it was.
  for (const entry of [
    { kind: 1, k: [], v: 1 },
    { kind: 1, k: ['a', 'b'], v: 1 },
    { kind: 9, k: ['x'], v: 1 },
  ])
    assert.equal(replayChatLine(state, entry), state);
  assert.equal(replayChatLine(undefined, { kind: 1, k: ['x'], v: 1 }), undefined);
});

test('replaying drops what is never read, such as tool output and the prompt sent', () => {
  const state = replayChatLine(undefined, {
    kind: 0,
    v: {
      requests: [
        {
          agent: { big: true },
          variableData: {},
          result: { metadata: { resolvedModel: 'm', renderedUserMessage: ['…'] }, timings: {} },
          response: [
            { kind: 'thinking', value: 'long' },
            { kind: 'toolInvocationSerialized', resultDetails: { output: ['…'], isError: true } },
            { kind: 'toolInvocationSerialized', resultDetails: { output: ['…'] } },
          ],
        },
        { result: { metadata: { other: 1 } } },
        'junk',
      ],
    },
  });
  const [request, second] = state!.requests as any[];
  assert.equal(request.agent, undefined);
  assert.deepEqual(request.result.metadata, { resolvedModel: 'm' });
  assert.deepEqual(second.result.metadata, {});
  assert.equal(request.response[0].value, '');
  assert.deepEqual(request.response[1].resultDetails, { isError: true });
  assert.deepEqual(request.response[2].resultDetails, {});
});

test('tool calls, reply text, and messages with file links', () => {
  const calls = finishedTools({
    response: [
      { kind: 'toolInvocationSerialized', toolCallId: 'a', isComplete: true, invocationMessage: 'Searching' },
      {
        kind: 'toolInvocationSerialized',
        toolCallId: 'b',
        toolId: 'run_in_terminal',
        isComplete: true,
        toolSpecificData: { kind: 'terminal', command: 'ls' },
        resultDetails: { isError: true },
      },
      { kind: 'toolInvocationSerialized', isComplete: true },
      { kind: 'markdownContent', content: { value: 'Hi ' } },
      { value: 'there' },
    ],
  });
  assert.deepEqual(
    calls.map(({ id, tool, said, command, failed, denied }) => [id, tool, said, command, failed, denied]),
    [
      ['a', 'tool', 'Searching', undefined, false, false],
      ['b', 'run_in_terminal', '', 'ls', true, false],
    ],
  );
  assert.deepEqual(finishedTools({}), []);
  assert.equal(
    replyText({ response: [{ kind: 'markdownContent', content: { value: 'Hi ' } }, { value: 'there' }] }),
    'Hi there',
  );
  assert.equal(replyText({}), '');
  assert.equal(markdownText({ value: 'x' }), 'x');
  assert.equal(markdownText(3), '');
  assert.deepEqual(
    plainMessage('Read [](file:///work/shop/src/a.ts#1-5) and [b](file:///work/shop/b.ts)', '/work/shop/'),
    {
      text: 'Read src/a.ts and b',
      file: 'src/a.ts',
    },
  );
  assert.deepEqual(plainMessage('Edited [](file:///c%3A/shop/a.ts)', 'C:\\shop'), {
    text: 'Edited a.ts',
    file: 'a.ts',
  });
  assert.deepEqual(plainMessage('See [docs](https://example.com) `x`'), { text: 'See docs x' });
  assert.deepEqual(plainMessage('Bad [](file://%zz)'), { text: 'Bad file://%zz' });
});
