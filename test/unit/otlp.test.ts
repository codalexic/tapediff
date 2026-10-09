import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { toOtlp, type Tape } from '../../src/export/otlp.js';
import { readTape } from '../../src/tape/io.js';
import { version } from '../../src/version.js';
import { exchange, header } from './tape-fixtures.js';

const scalar = z.union([
  z.strictObject({ stringValue: z.string() }),
  z.strictObject({ intValue: z.string().regex(/^-?\d+$/) }),
  z.strictObject({ doubleValue: z.number() }),
]);
const attributes = z.array(
  z.strictObject({
    key: z.string(),
    value: z.union([
      scalar,
      z.strictObject({
        arrayValue: z.strictObject({ values: z.array(scalar) }),
      }),
    ]),
  }),
);
const timestamp = z.string().regex(/^\d+$/);
const spanId = z
  .string()
  .regex(/^[a-f0-9]{16}$/)
  .refine((id) => !/^0+$/.test(id));
const spanSchema = z.strictObject({
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .refine((id) => !/^0+$/.test(id)),
  spanId,
  parentSpanId: spanId.optional(),
  name: z.string().min(1),
  kind: z.union([z.literal(1), z.literal(3)]),
  startTimeUnixNano: timestamp,
  endTimeUnixNano: timestamp,
  attributes,
  status: z.strictObject({ code: z.union([z.literal(0), z.literal(2)]) }),
  events: z
    .array(
      z.strictObject({ name: z.string(), timeUnixNano: timestamp, attributes }),
    )
    .optional(),
});
const otlpSchema = z.strictObject({
  resourceSpans: z
    .array(
      z.strictObject({
        resource: z.strictObject({ attributes }),
        scopeSpans: z
          .array(
            z.strictObject({
              scope: z.strictObject({
                name: z.literal('tapediff'),
                version: z.string(),
              }),
              spans: z.array(spanSchema).min(1),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

const fixtures = [
  'chat-json',
  'chat-stream',
  'responses-json',
  'responses-stream',
  'anthropic-stream',
  'chat-error',
  'chat-aborted',
  'forked',
  'tools',
];
const fixture = (name: string) =>
  fileURLToPath(
    new URL(
      `../fixtures/${['forked', 'tools', 'anthropic-stream'].includes(name) ? 'otlp' : 'steps'}/${name}.tape`,
      import.meta.url,
    ),
  );
const spans = (tape: Tape, includeContent = false) =>
  toOtlp(tape, { includeContent }).resourceSpans[0]!.scopeSpans[0]!.spans;
const attrs = (span: { attributes: { key: string; value: unknown }[] }) =>
  Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));
const base = (): Tape =>
  structuredClone({ header, exchanges: [exchange], tools: [] });

it.each(fixtures)(
  'exports %s to golden OTLP JSON with valid parents and bounds',
  async (name) => {
    const tape = await readTape(fixture(name));
    const before = JSON.stringify(tape);
    const output = toOtlp(tape);
    expect(otlpSchema.safeParse(output).success).toBe(true);
    const golden = await readFile(
      new URL(`../fixtures/otlp/${name}.json`, import.meta.url),
      'utf8',
    );
    expect(`${JSON.stringify(output, null, 2)}\n`).toBe(golden);
    expect(JSON.stringify(toOtlp(tape))).toBe(JSON.stringify(output));
    expect(JSON.stringify(tape)).toBe(before);
    const [root, ...children] = spans(tape);
    expect(root!.parentSpanId).toBeUndefined();
    expect(new Set([root, ...children].map((span) => span!.spanId)).size).toBe(
      children.length + 1,
    );
    for (const child of children) {
      expect(child.parentSpanId).toBe(root!.spanId);
      expect(child.traceId).toBe(root!.traceId);
      expect(BigInt(child.startTimeUnixNano)).toBeGreaterThanOrEqual(
        BigInt(root!.startTimeUnixNano),
      );
      expect(BigInt(child.endTimeUnixNano)).toBeLessThanOrEqual(
        BigInt(root!.endTimeUnixNano),
      );
      expect(BigInt(child.endTimeUnixNano)).toBeGreaterThanOrEqual(
        BigInt(child.startTimeUnixNano),
      );
      for (const event of child.events ?? []) {
        expect(BigInt(event.timeUnixNano)).toBeGreaterThanOrEqual(
          BigInt(child.startTimeUnixNano),
        );
        expect(BigInt(event.timeUnixNano)).toBeLessThanOrEqual(
          BigInt(child.endTimeUnixNano),
        );
      }
    }
  },
);

it.each(fixtures)(
  'omits content by default and supports opt-in content for %s',
  async (name) => {
    const tape = await readTape(fixture(name));
    const output = JSON.stringify(toOtlp(tape));
    expect(output).not.toMatch(
      /gen_ai\.(input.messages|output.messages|system_instructions)|Weather and time|Checking\.|Europe\/Paris|temperature/,
    );
    const withContent = toOtlp(tape, { includeContent: true });
    expect(otlpSchema.safeParse(withContent).success).toBe(true);
    expect(JSON.stringify(withContent)).toContain('gen_ai.input.messages');
    expect(JSON.stringify(toOtlp(tape, { includeContent: true }))).toBe(
      JSON.stringify(withContent),
    );
  },
);

it('uses exact hash inputs, sequence ordering, resource version and service overrides', () => {
  const tape = base();
  tape.exchanges.push({ ...exchange, seq: 2, id: 2, matchKey: 'b'.repeat(64) });
  tape.exchanges.reverse();
  const output = toOtlp(tape, { serviceName: 'custom' });
  const traceId = createHash('sha256')
    .update(header.createdAt + exchange.matchKey + 'b'.repeat(64))
    .digest('hex')
    .slice(0, 32);
  const children = output.resourceSpans[0]!.scopeSpans[0]!.spans;
  expect(children[0]!.traceId).toBe(traceId);
  expect(children[1]!.spanId).toBe(
    createHash('sha256')
      .update(traceId + exchange.seq + 'exchange')
      .digest('hex')
      .slice(0, 16),
  );
  expect(attrs(output.resourceSpans[0]!.resource)).toEqual({
    'service.name': { stringValue: 'custom' },
    'telemetry.sdk.name': { stringValue: 'tapediff' },
    'telemetry.sdk.language': { stringValue: 'nodejs' },
    'telemetry.sdk.version': { stringValue: version },
  });
  expect(output.resourceSpans[0]!.scopeSpans[0]!.scope).toEqual({
    name: 'tapediff',
    version,
  });
  expect(children.map((span) => span.spanId)).toEqual(
    spans(tape).map((span) => span.spanId),
  );
});

it('handles empty tapes, root names and missing service names without current time', () => {
  const tape = base();
  tape.exchanges = [];
  delete tape.header.name;
  const output = toOtlp(tape);
  const root = spans(tape)[0]!;
  expect(root.startTimeUnixNano).toBe(root.endTimeUnixNano);
  expect(root.name).toBe(tape.header.command.join(' '));
  expect(attrs(output.resourceSpans[0]!.resource)['service.name']).toEqual({
    stringValue: 'tapediff',
  });
  tape.header.command = [];
  expect(spans(tape)[0]!.name).toBe('tapediff');
});

it('preserves nanosecond fractions, timezone offsets and fractional millisecond latency', () => {
  const tape = base();
  tape.exchanges[0]!.timing = {
    startedAt: '2026-01-01T04:00:00.123456789+04:00',
    latencyMs: 1.234567,
  };
  const span = spans(tape)[1]!;
  expect(span.startTimeUnixNano).toBe('1767225600123456789');
  expect(span.endTimeUnixNano).toBe('1767225600124691356');
});

it('keeps concurrent and out-of-order records inside the root', () => {
  const tape = base();
  tape.exchanges = [0, 1, 2].map((seq) => ({
    ...exchange,
    seq,
    timing: {
      startedAt: `2026-01-01T00:00:0${2 - seq}Z`,
      latencyMs: seq === 1 ? 5000 : 10,
    },
  }));
  const root = spans(tape)[0]!;
  expect(root.startTimeUnixNano).toBe('1767225600000000000');
  expect(root.endTimeUnixNano).toBe('1767225606000000000');
});

it('exports unknown routes with HTTP attributes only and omits invented upstream addresses', () => {
  const tape = base();
  tape.exchanges[0]!.provider = 'unknown';
  const span = spans(tape, true)[1]!;
  expect(span.name).toBe(`${exchange.request.method} ${exchange.endpoint}`);
  expect(Object.keys(attrs(span))).toEqual([
    'http.request.method',
    'http.response.status_code',
  ]);
  expect(JSON.stringify(toOtlp(base()))).not.toMatch(
    /server.address|server.port/,
  );
});

it.each([
  { status: 429, aborted: false, error: '429' },
  { status: 200, aborted: true, error: 'aborted' },
  { status: 500, aborted: true, error: 'aborted' },
])('marks failures safely: %j', ({ status, aborted, error }) => {
  const tape = base();
  tape.exchanges[0]!.response = {
    status,
    headers: {},
    body: { error: { message: 'private-error-message' } },
  };
  tape.exchanges[0]!.aborted = aborted;
  const span = spans(tape)[1]!;
  expect(span.status.code).toBe(2);
  expect(attrs(span)['error.type']).toEqual({ stringValue: error });
  expect(JSON.stringify(toOtlp(tape))).not.toContain('private-error-message');
});

it('keeps request and response models distinct and preserves repeated finish reasons', () => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  ex.request.body = { model: 'requested', messages: [] };
  ex.model = 'recorded';
  ex.response.body = {
    id: 'response-id',
    model: 'actual',
    choices: [
      { index: 0, finish_reason: 'stop' },
      { index: 1, finish_reason: 'stop' },
    ],
  };
  const span = spans(tape)[1]!;
  expect(span.name).toBe('chat requested');
  expect(attrs(span)).toMatchObject({
    'gen_ai.request.model': { stringValue: 'requested' },
    'gen_ai.response.model': { stringValue: 'actual' },
    'gen_ai.response.id': { stringValue: 'response-id' },
    'gen_ai.response.finish_reasons': {
      arrayValue: {
        values: [{ stringValue: 'stop' }, { stringValue: 'stop' }],
      },
    },
  });
});

it.each(['chat', 'responses', 'anthropic'])(
  'reassembles %s stream metadata without leaking content',
  (provider) => {
    const tape = base();
    const ex = tape.exchanges[0]!;
    const events =
      provider === 'chat'
        ? [
            {
              id: 'response-id',
              model: 'actual',
              choices: [{ index: 0, delta: { content: 'private' } }],
            },
            { choices: [{ index: 0, finish_reason: 'stop' }] },
          ]
        : provider === 'responses'
          ? [
              {
                type: 'response.created',
                response: { id: 'response-id', model: 'actual' },
              },
              { type: 'response.completed', response: { status: 'completed' } },
            ]
          : [
              {
                type: 'message_start',
                message: { id: 'response-id', model: 'actual' },
              },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            ];
    ex.provider = provider === 'anthropic' ? 'anthropic' : 'openai';
    ex.endpoint = provider === 'responses' ? '/v1/responses' : ex.endpoint;
    const raw = events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('');
    ex.response = {
      status: 200,
      headers: {},
      sse: [
        { t: 0, data: raw.slice(0, 9) },
        { t: 1, data: raw.slice(9) },
      ],
    };
    expect(attrs(spans(tape)[1]!)).toMatchObject({
      'gen_ai.response.id': { stringValue: 'response-id' },
      'gen_ai.response.model': { stringValue: 'actual' },
      'gen_ai.response.finish_reasons': {
        arrayValue: {
          values: [
            { stringValue: provider === 'anthropic' ? 'end_turn' : 'stop' },
          ],
        },
      },
    });
    expect(JSON.stringify(toOtlp(tape))).not.toContain('private');
  },
);

it.each([
  ['incomplete', 'max_output_tokens', 'length'],
  ['incomplete', 'content_filter', 'content_filter'],
  ['failed', '', 'error'],
  ['cancelled', '', 'error'],
])('maps Responses status %s/%s to %s', (status, reason, expected) => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  ex.endpoint = '/v1/responses';
  ex.response.body = { status, incomplete_details: { reason } };
  expect(attrs(spans(tape)[1]!)['gen_ai.response.finish_reasons']).toEqual({
    arrayValue: { values: [{ stringValue: expected }] },
  });
});

it('links only one-to-one tool matches and retains minimal events for ambiguous calls', async () => {
  const tape = await readTape(fixture('tools'));
  const tool = tape.tools[0]!;
  expect(
    attrs(
      spans(tape).find((span) => span.name === `execute_tool ${tool.name}`)!,
    )['gen_ai.tool.call.id'],
  ).toEqual({ stringValue: 'call_weather' });
  tape.tools.push({ ...tool, seq: 3, id: 3 });
  const output = spans(tape);
  for (const span of output.filter(
    (span) => span.name === `execute_tool ${tool.name}`,
  ))
    expect(attrs(span)['gen_ai.tool.call.id']).toBeUndefined();
  const event = output[1]!.events!.find(
    (event) =>
      attrs(event)['gen_ai.tool.call.id'] &&
      JSON.stringify(attrs(event)).includes('call_weather'),
  )!;
  expect(Object.keys(attrs(event))).toEqual([
    'gen_ai.tool.name',
    'gen_ai.tool.call.id',
  ]);
});

it('does not link tools before their requesting exchange or with differing args', async () => {
  const tape = await readTape(fixture('tools'));
  tape.tools[0]!.seq = 0;
  tape.tools[1]!.args = { different: true };
  for (const span of spans(tape).filter((span) =>
    span.name.startsWith('execute_tool '),
  ))
    expect(attrs(span)['gen_ai.tool.call.id']).toBeUndefined();
});

it('captures ordered input history, separate instructions and individual output choices', () => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  ex.request.body = {
    messages: [
      { role: 'developer', content: 'rules' },
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
      { role: 'tool', tool_call_id: 'c', content: 'result' },
    ],
  };
  ex.response.body = {
    choices: [
      { index: 0, message: { content: 'first' } },
      { index: 1, message: { content: 'second' } },
    ],
  };
  const attributes = attrs(spans(tape, true)[1]!);
  expect(attributes['gen_ai.input.messages']).toEqual({
    stringValue: JSON.stringify([
      { role: 'system', parts: [{ type: 'text', content: 'rules' }] },
      { role: 'user', parts: [{ type: 'text', content: 'question' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'answer' }] },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'c', response: 'result' }],
      },
    ]),
  });
  expect(attributes['gen_ai.output.messages']).toEqual({
    stringValue: JSON.stringify(
      ['first', 'second'].map((content) => ({
        role: 'assistant',
        parts: [{ type: 'text', content }],
      })),
    ),
  });
  ex.endpoint = '/v1/responses';
  ex.request.body = { instructions: 'rules', input: 'question' };
  expect(attrs(spans(tape, true)[1]!)['gen_ai.system_instructions']).toEqual({
    stringValue: '[{"type":"text","content":"rules"}]',
  });
});

it('does not invent response metadata or unknown cost', () => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  ex.costUsd = null;
  delete ex.model;
  ex.request.body = {};
  ex.response.body = {};
  const attributes = attrs(spans(tape)[1]!);
  expect(spans(tape)[1]!.name).toBe('chat');
  for (const key of [
    'gen_ai.request.model',
    'gen_ai.response.model',
    'gen_ai.response.id',
    'gen_ai.response.finish_reasons',
    'tapediff.cost_usd',
  ])
    expect(attributes[key]).toBeUndefined();
  expect(attrs(spans(tape)[0]!)['tapediff.cost_usd']).toBeUndefined();
});

it.each(['openai', 'anthropic'] as const)(
  'accounts for %s cache tokens without double counting',
  (provider) => {
    const tape = base();
    const ex = tape.exchanges[0]!;
    ex.provider = provider;
    ex.usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
    };
    expect(attrs(spans(tape)[1]!)['gen_ai.usage.input_tokens']).toEqual({
      intValue: provider === 'anthropic' ? '60' : '10',
    });
    expect(attrs(spans(tape)[0]!)['tapediff.usage.input_tokens']).toEqual({
      intValue: '10',
    });
    delete ex.usage;
    ex.response.body =
      provider === 'anthropic'
        ? {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 30,
            },
          }
        : {
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 5 },
            },
          };
    expect(attrs(spans(tape)[1]!)['gen_ai.usage.input_tokens']).toEqual({
      intValue: provider === 'anthropic' ? '60' : '10',
    });
  },
);

it('captures streamed choices separately in choice order', () => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  const events = [
    {
      choices: [
        { index: 1, delta: { content: 'second' } },
        { index: 0, delta: { content: 'first' } },
      ],
    },
    { choices: [{ index: 0, delta: { content: ' answer' } }] },
  ];
  ex.response = {
    status: 200,
    headers: {},
    sse: [
      {
        t: 0,
        data: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      },
    ],
  };
  expect(attrs(spans(tape, true)[1]!)['gen_ai.output.messages']).toEqual({
    stringValue: JSON.stringify(
      ['first answer', 'second'].map((content) => ({
        role: 'assistant',
        parts: [{ type: 'text', content }],
      })),
    ),
  });
});

it('maps Anthropic input blocks and system instructions', () => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  ex.provider = 'anthropic';
  ex.request.body = {
    system: [{ type: 'text', text: 'rules' }],
    messages: [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'c',
            name: 'weather',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c', content: 'sunny' }],
      },
    ],
  };
  const attributes = attrs(spans(tape, true)[1]!);
  expect(attributes['gen_ai.system_instructions']).toEqual({
    stringValue: '[{"type":"text","content":"rules"}]',
  });
  expect(attributes['gen_ai.input.messages']).toEqual({
    stringValue: JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: 'question' }] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'c',
            name: 'weather',
            arguments: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'user',
        parts: [{ type: 'tool_call_response', id: 'c', response: 'sunny' }],
      },
    ]),
  });
  expect(JSON.stringify(toOtlp(tape))).not.toMatch(
    /rules|question|sunny|Paris/,
  );
});

it('maps Responses input tool calls/results without losing their IDs', () => {
  const tape = base();
  const ex = tape.exchanges[0]!;
  ex.endpoint = '/v1/responses';
  ex.request.body = {
    input: [
      {
        type: 'function_call',
        call_id: 'c',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
      { type: 'function_call_output', call_id: 'c', output: 'sunny' },
    ],
  };
  expect(attrs(spans(tape, true)[1]!)['gen_ai.input.messages']).toEqual({
    stringValue: JSON.stringify([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'c',
            name: 'weather',
            arguments: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'c', response: 'sunny' }],
      },
    ]),
  });
});

it('omits null fork position and handles tool-only tapes and unnamed errors', async () => {
  const tape = await readTape(fixture('tools'));
  tape.exchanges = [];
  tape.tools[1]!.error!.name = '';
  tape.header.forkedFrom = {
    tape: 'source',
    at: null,
    mode: 'divergence',
    sourceCreatedAt: header.createdAt,
  };
  const output = spans(tape);
  expect(output).toHaveLength(3);
  expect(attrs(output[0]!)['tapediff.forked_from.at']).toBeUndefined();
  expect(attrs(output[2]!)['error.type']).toEqual({ stringValue: 'Error' });
  expect(JSON.stringify(output)).not.toContain('private tool failure');
  expect(BigInt(output[0]!.endTimeUnixNano)).toBe(
    BigInt(output[2]!.endTimeUnixNano),
  );
});

it('keeps events for duplicate model calls and omits missing IDs', async () => {
  const tape = await readTape(fixture('tools'));
  const body = tape.exchanges[0]!.response.body as {
    choices: { message: { tool_calls: { id?: string }[] } }[];
  };
  const calls = body.choices[0]!.message.tool_calls;
  calls.push(structuredClone(calls[0]!));
  delete calls[1]!.id;
  const output = spans(tape);
  expect(
    attrs(output.find((span) => span.name === 'execute_tool get_weather')!)[
      'gen_ai.tool.call.id'
    ],
  ).toBeUndefined();
  expect(
    attrs(output.find((span) => span.name === 'execute_tool get_time')!)[
      'gen_ai.tool.call.id'
    ],
  ).toBeUndefined();
  expect(output[1]!.events).toHaveLength(2);
});
