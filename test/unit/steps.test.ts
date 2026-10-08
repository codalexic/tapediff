import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { toSteps } from '../../src/steps.js';
import type { Exchange, JsonValue } from '../../src/tape/schema.js';
import { readTape } from '../../src/tape/io.js';
import { exchange } from './tape-fixtures.js';
import { scenario } from '../helpers/steps-scenarios.js';

const make = (
  body: JsonValue,
  response: JsonValue,
  extra: Partial<Exchange> = {},
): Exchange => ({
  ...structuredClone(exchange),
  request: { ...exchange.request, body },
  response: { status: 200, headers: {}, body: response },
  ...extra,
});

it.each([
  {
    provider: 'openai',
    endpoint: '/v1/chat/completions',
    body: {
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'developer', content: [{ type: 'text', text: 'Be helpful' }] },
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: 'Old answer' },
      ],
    },
  },
  {
    provider: 'openai',
    endpoint: '/v1/responses',
    body: { instructions: 'Be helpful', input: 'Weather?' },
  },
  {
    provider: 'openai',
    endpoint: '/v1/responses',
    body: {
      input: [
        { role: 'developer', content: 'Be helpful' },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Weather?' },
            { type: 'input_image' },
          ],
        },
      ],
    },
  },
  {
    provider: 'anthropic',
    endpoint: '/v1/messages',
    body: {
      system: [{ type: 'text', text: 'Be helpful' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Weather?' },
            { type: 'tool_result', tool_use_id: 't', content: 'sunny' },
          ],
        },
      ],
    },
  },
] as const)(
  'extracts and dedupes $provider $endpoint prompts before calls',
  ({ provider, endpoint, body }) => {
    const first = make(
      body as unknown as JsonValue,
      {},
      { provider, endpoint, seq: 0 },
    );
    const steps = toSteps([first, { ...first, seq: 1 }]);
    expect(steps.filter((step) => step.kind === 'input')).toEqual([
      { kind: 'input', role: 'system', content: 'Be helpful' },
      { kind: 'input', role: 'user', content: 'Weather?' },
    ]);
    expect(steps[0]?.kind).toBe('input');
  },
);

it('keeps changed prompts and the same content under different roles', () => {
  const request = (content: string, seq: number) =>
    make(
      {
        messages: [
          { role: 'system', content: 'same' },
          { role: 'user', content },
        ],
      },
      {},
      { seq },
    );
  expect(
    toSteps([request('same', 0), request('changed', 1)]).filter(
      (step) => step.kind === 'input',
    ),
  ).toEqual([
    { kind: 'input', role: 'system', content: 'same' },
    { kind: 'input', role: 'user', content: 'same' },
    { kind: 'input', role: 'user', content: 'changed' },
  ]);
});

it.each(['chat', 'responses', 'anthropic'] as const)(
  'sorts, dedupes results, resolves %s ids from calls and history, and stays pure',
  (api) => {
    const data = scenario(api);
    const common = {
      provider:
        api === 'anthropic' ? ('anthropic' as const) : ('openai' as const),
      endpoint: data.endpoint,
    };
    const first = make(data.request(), data.output() as JsonValue, {
      ...common,
      seq: 0,
    });
    const second = make(data.request(true), data.output(true) as JsonValue, {
      ...common,
      seq: 1,
    });
    const third = { ...second, seq: 2 };
    const input = [third, first, second];
    const before = structuredClone(input);
    const steps = toSteps(input);
    expect(input).toEqual(before);
    expect(
      steps.filter((step) => step.kind === 'llm_call').map((step) => step.seq),
    ).toEqual([0, 1, 2]);
    expect(steps.filter((step) => step.kind === 'tool_result')).toEqual([
      {
        kind: 'tool_result',
        id: 'call_weather',
        name: 'get_weather',
        content: '18°C, sunny',
      },
      {
        kind: 'tool_result',
        id: 'call_time',
        name: 'get_time',
        content: '12:00',
      },
    ]);
    expect(steps.map((step) => step.kind)).toEqual([
      'input',
      'llm_call',
      'text',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'llm_call',
      'text',
      'llm_call',
      'text',
    ]);
    // Tapes can start with history: recover names without emitting old tool calls.
    expect(
      toSteps([second]).filter((step) => step.kind === 'tool_result'),
    ).toEqual(steps.filter((step) => step.kind === 'tool_result'));
  },
);

it('joins tool-result text blocks, preserves isError, and omits unresolved names', () => {
  const input = make(
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'missing',
              is_error: true,
              content: [
                { type: 'text', text: 'not ' },
                { type: 'image' },
                { type: 'text', text: 'found' },
              ],
            },
          ],
        },
      ],
    },
    {},
    { provider: 'anthropic' },
  );
  expect(toSteps([input])[0]).toEqual({
    kind: 'tool_result',
    id: 'missing',
    content: 'not found',
    isError: true,
  });
});

it('resolves names from earlier responses without assistant history and dedupes by id', () => {
  const first = make(
    {},
    {
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'a', function: { name: 'lookup', arguments: '{}' } },
            ],
          },
        },
      ],
    },
    { seq: 0 },
  );
  const second = make(
    {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'a',
          content: [
            { type: 'text', text: 'sun' },
            { type: 'text', text: 'ny' },
          ],
        },
        { role: 'tool', tool_call_id: 'b', content: 'sunny' },
      ],
    },
    {},
    { seq: 1 },
  );
  const third = make(
    {
      messages: [
        { role: 'tool', tool_call_id: 'a', content: 'changed history' },
      ],
    },
    {},
    { seq: 2 },
  );
  expect(
    toSteps([first, second, third]).filter(
      (step) => step.kind === 'tool_result',
    ),
  ).toEqual([
    { kind: 'tool_result', id: 'a', name: 'lookup', content: 'sunny' },
    { kind: 'tool_result', id: 'b', content: 'sunny' },
  ]);
});

it('preserves streamed text before and after a tool call and isolates choice indices', () => {
  const input = make({}, null);
  input.response.sse = [
    {
      t: 0,
      data: [
        { choices: [{ index: 0, delta: { content: 'Before' } }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'a',
                    function: { name: 'one', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { content: 'After' } },
            {
              index: 1,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'b',
                    function: { name: 'two', arguments: '[]' },
                  },
                ],
              },
            },
          ],
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    },
  ];
  expect(toSteps([input]).slice(1)).toEqual([
    { kind: 'text', content: 'Before' },
    { kind: 'tool_call', id: 'a', name: 'one', args: {} },
    { kind: 'text', content: 'After' },
    { kind: 'tool_call', id: 'b', name: 'two', args: [] },
  ]);
});

it.each(['{"city":', 'not JSON', 'null', '[1,2]'])(
  'parses arguments or retains raw %s',
  (args) => {
    const input = make(
      {},
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'a', function: { name: 'lookup', arguments: args } },
              ],
            },
          },
        ],
      },
    );
    const expected = args === 'null' ? null : args === '[1,2]' ? [1, 2] : args;
    expect(toSteps([input])[1]).toEqual({
      kind: 'tool_call',
      id: 'a',
      name: 'lookup',
      args: expected,
    });
  },
);

it('unknown providers emit only metadata, including on errors and aborts', () => {
  const input = make(
    {},
    { error: { message: 'failed' } },
    { provider: 'unknown', aborted: true },
  );
  expect(toSteps([input])).toHaveLength(1);
  expect(toSteps([input])[0]?.kind).toBe('llm_call');
});

it('handles HTTP text errors and aborts with no body', () => {
  const input = make({}, 'service unavailable');
  input.response.status = 503;
  expect(toSteps([input])[1]).toEqual({
    kind: 'error',
    status: 503,
    message: 'service unavailable',
  });
  input.response = { status: 200, headers: {} };
  input.aborted = true;
  expect(toSteps([input])[1]).toEqual({
    kind: 'error',
    status: 200,
    message: 'Exchange aborted',
  });
});

it.each(['chat', 'responses', 'anthropic'] as const)(
  'parses %s SSE across every character boundary and ignores keepalives',
  (api) => {
    const data = scenario(api);
    const input = make(data.request(), null, {
      provider: api === 'anthropic' ? 'anthropic' : 'openai',
      endpoint: data.endpoint,
      model: undefined,
      usage: undefined,
      costUsd: undefined,
    });
    input.response = {
      status: 200,
      headers: {},
      sse: Array.from(': keepalive\r\n\r\n' + data.events().join('')).map(
        (data) => ({ t: 0, data }),
      ),
    };
    const expected = make(data.request(), data.output() as JsonValue, {
      ...input,
      response: { status: 200, headers: {}, body: data.output() as JsonValue },
    });
    expect(toSteps([input])).toEqual(toSteps([expected]));
  },
);

it('keeps Responses done items in output_index order without a completed event', () => {
  const input = make({}, null, { endpoint: '/v1/responses' });
  input.response.sse = [
    {
      t: 0,
      data: 'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call","name":"lookup","arguments":"{}"}}\n\n',
    },
    {
      t: 1,
      data: 'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"First"}]}}\n\n',
    },
  ];
  expect(toSteps([input]).slice(1)).toEqual([
    { kind: 'text', content: 'First' },
    { kind: 'tool_call', id: 'call', name: 'lookup', args: {} },
  ]);
});

it('retains interrupted streamed arguments and reports Responses failure', () => {
  const input = make({}, null, { endpoint: '/v1/responses', aborted: true });
  input.response.sse = [
    {
      t: 0,
      data: [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'a',
            name: 'lookup',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"city":',
        },
        { type: 'response.failed', response: { error: { message: 'failed' } } },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    },
  ];
  expect(toSteps([input]).slice(1)).toEqual([
    { kind: 'tool_call', id: 'a', name: 'lookup', args: '{"city":' },
    { kind: 'error', status: 200, message: 'failed' },
  ]);
});

it.each(['chat', 'responses', 'anthropic'] as const)(
  'checked-in %s JSON and SSE fixtures produce identical steps',
  async (api) => {
    const read = async (mode: string) =>
      toSteps(
        (
          await readTape(
            fileURLToPath(
              new URL(`../fixtures/steps/${api}-${mode}.tape`, import.meta.url),
            ),
          )
        ).exchanges,
      );
    expect(await read('stream')).toEqual(await read('json'));
  },
);
