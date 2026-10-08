import type { JsonValue } from '../../src/tape/schema.js';

export type Api = 'chat' | 'responses' | 'anthropic';
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const calls = [
  { id: 'call_weather', name: 'get_weather', args: { city: 'Paris' } },
  { id: 'call_time', name: 'get_time', args: { zone: 'Europe/Paris' } },
];
const text = "It's 18°C and sunny in Paris.";

export function scenario(api: Api) {
  const model = api === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1';
  const endpoint =
    api === 'chat'
      ? '/v1/chat/completions'
      : api === 'responses'
        ? '/v1/responses'
        : '/v1/messages';
  const tools = calls.map((call) =>
    api === 'chat'
      ? {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }
      : api === 'responses'
        ? {
            type: 'function_call',
            id: `item_${call.id}`,
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          }
        : { type: 'tool_use', id: call.id, name: call.name, input: call.args },
  );
  const blocks = (final: boolean) =>
    api === 'responses'
      ? [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: final ? text : 'Checking. ' },
            ],
          },
          ...(final ? [] : tools),
        ]
      : [
          { type: 'text', text: final ? text : 'Checking. ' },
          ...(final ? [] : tools),
        ];
  function output(final = false): unknown {
    if (api === 'chat')
      return {
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: final ? text : 'Checking. ',
              ...(final ? {} : { tool_calls: tools }),
            },
          },
        ],
        usage: { prompt_tokens: 1204, completion_tokens: 88 },
      };
    return {
      model,
      ...(api === 'responses'
        ? { output: blocks(final) }
        : { content: blocks(final) }),
      usage: { input_tokens: 1204, output_tokens: 88 },
    };
  }
  function request(final = false, stream = false): JsonValue {
    const results = calls.map((call, index) => ({
      id: call.id,
      content: index ? '12:00' : '18°C, sunny',
    }));
    if (api === 'responses')
      return {
        model,
        stream,
        input: [
          { role: 'user', content: 'Weather and time in Paris?' },
          ...(final
            ? [
                ...tools,
                ...results.map((r) => ({
                  type: 'function_call_output',
                  call_id: r.id,
                  output: r.content,
                })),
              ]
            : []),
        ],
      } as JsonValue;
    return {
      model,
      stream,
      messages: [
        { role: 'user', content: 'Weather and time in Paris?' },
        ...(final
          ? api === 'chat'
            ? [
                { role: 'assistant', content: null, tool_calls: tools },
                ...results.map((r) => ({
                  role: 'tool',
                  tool_call_id: r.id,
                  content: r.content,
                })),
              ]
            : [
                { role: 'assistant', content: tools },
                {
                  role: 'user',
                  content: results.map((r) => ({
                    type: 'tool_result',
                    tool_use_id: r.id,
                    content: [{ type: 'text', text: r.content }],
                  })),
                },
              ]
          : []),
      ],
    } as JsonValue;
  }
  function events(final = false): string[] {
    if (api === 'responses')
      return [
        ...blocks(final).map((item, output_index) =>
          frame({ type: 'response.output_item.done', output_index, item }),
        ),
        frame({ type: 'response.completed', response: output(final) }),
      ];
    if (api === 'anthropic')
      return [
        frame({
          type: 'message_start',
          message: { model, usage: { input_tokens: 1204, output_tokens: 0 } },
        }),
        ...blocks(final).flatMap((block, index) => {
          if (block.type === 'text')
            return [
              frame({
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' },
              }),
              frame({
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'text_delta',
                  text: final ? text : 'Checking. ',
                },
              }),
              frame({ type: 'content_block_stop', index }),
            ];
          const call = calls[index - 1]!;
          const args = JSON.stringify(call.args);
          return [
            frame({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: {},
              },
            }),
            ...[args.slice(0, 8), args.slice(8)].map((partial_json) =>
              frame({
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json },
              }),
            ),
            frame({ type: 'content_block_stop', index }),
          ];
        }),
        frame({ type: 'message_delta', usage: { output_tokens: 88 } }),
        frame({ type: 'message_stop' }),
      ];
    const chunk = (delta: unknown) =>
      frame({ model, choices: [{ index: 0, delta }] });
    return [
      chunk({ content: final ? text : 'Checking. ' }),
      ...(final
        ? []
        : [
            chunk({
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.id,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args).slice(0, 8),
                },
              })),
            }),
            chunk({
              tool_calls: [...calls.entries()]
                .reverse()
                .map(([index, call]) => ({
                  index,
                  function: { arguments: JSON.stringify(call.args).slice(8) },
                })),
            }),
          ]),
      frame({
        model,
        choices: [],
        usage: { prompt_tokens: 1204, completion_tokens: 88 },
      }),
      'data: [DONE]\n\n',
    ];
  }
  const partial =
    api === 'chat'
      ? frame({
          model,
          choices: [{ index: 0, delta: { content: 'Partial answer' } }],
        })
      : api === 'responses'
        ? frame({
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: 'Partial answer',
          })
        : frame({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          frame({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Partial answer' },
          });
  return { model, endpoint, request, output, events, partial };
}
