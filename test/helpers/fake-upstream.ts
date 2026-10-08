import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { object } from '../../src/providers/usage.js';

export interface FakeRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}
export interface FakeOptions {
  delayMs?: number;
  status?: number;
  disconnect?: boolean;
  responseText?: string;
  responseBody?: (request: FakeRequest) => unknown;
  frames?: string[];
  gate?: Promise<void>;
  onRequest?: (request: FakeRequest) => void;
  delayFor?: (request: FakeRequest) => number;
}

const frame = (body: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(body)}\n\n`;

export async function fakeUpstream(options: FakeOptions = {}) {
  const requests: FakeRequest[] = [];
  let finished = false;
  let aborted = false;
  const server = createServer((req, res) => {
    res.on('close', () => {
      if (!res.writableFinished) aborted = true;
    });
    void (async () => {
      const buffers: Buffer[] = [];
      for await (const chunk of req)
        buffers.push(Buffer.from(chunk as Uint8Array));
      const text = Buffer.concat(buffers).toString();
      let body: Record<string, unknown> = {};
      try {
        body = object(JSON.parse(text));
      } catch {
        /* Generic requests can be text. */
      }
      const request = { path: req.url ?? '/', headers: req.headers, body };
      requests.push(request);
      options.onRequest?.(request);
      if (options.disconnect) {
        req.socket.destroy();
        return;
      }
      const wait = options.delayFor?.(request) ?? 0;
      if (wait) await delay(wait);
      const anthropic = request.path.split('?')[0]?.endsWith('/messages');
      const responses = request.path.split('?')[0]?.endsWith('/responses');
      const second =
        JSON.stringify(body.messages ?? body.input ?? []).includes(
          'tool_result',
        ) ||
        JSON.stringify(body.messages ?? body.input ?? []).includes(
          '"role":"tool"',
        ) ||
        JSON.stringify(body.input ?? []).includes('function_call_output');
      const model = body.model ?? (anthropic ? 'claude-sonnet-4-5' : 'gpt-4o');
      const tool = {
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"city":"Paris"}' },
      };
      const message = {
        role: 'assistant',
        content: second ? 'It is sunny.' : null,
        ...(second ? {} : { tool_calls: [tool] }),
      };
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 10 },
      };
      const anthropicUsage = {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      };
      const content = second
        ? [{ type: 'text', text: 'It is sunny.' }]
        : [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'lookup',
              input: { city: 'Paris' },
            },
          ];
      let output: unknown = {
        id: 'chat_1',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [
          { index: 0, message, finish_reason: second ? 'stop' : 'tool_calls' },
        ],
        usage,
      };
      if (anthropic)
        output = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason: second ? 'end_turn' : 'tool_use',
          stop_sequence: null,
          usage: anthropicUsage,
        };
      if (responses)
        output = {
          id: 'resp_1',
          object: 'response',
          model,
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 10 },
          },
        };
      const status = options.status ?? 200;
      if (options.responseBody) output = options.responseBody(request);
      if (status >= 400)
        output = {
          error: { type: 'test_error', message: 'fake upstream error' },
        };
      if (status < 400 && (body.stream || options.frames)) {
        res.writeHead(status, {
          'content-type': 'text/event-stream',
          'x-request-id': 'fake-request',
          connection: 'keep-alive',
        });
        const chatChunk = (delta: unknown, finish: string | null = null) => ({
          id: 'chat_1',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        let frames = [
          frame(chatChunk({ role: 'assistant' })),
          frame(
            chatChunk(
              second
                ? { content: 'It is sunny.' }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        ...tool,
                        function: { name: 'lookup', arguments: '{"city":' },
                      },
                    ],
                  },
            ),
          ),
          ...(second
            ? []
            : [
                frame(
                  chatChunk({
                    tool_calls: [
                      { index: 0, function: { arguments: '"Paris"}' } },
                    ],
                  }),
                ),
              ]),
          frame(chatChunk({}, second ? 'stop' : 'tool_calls')),
          frame({
            id: 'chat_1',
            object: 'chat.completion.chunk',
            model,
            choices: [],
            usage,
          }),
          'data: [DONE]\n\n',
        ];
        if (anthropic)
          frames = [
            frame(
              {
                type: 'message_start',
                message: {
                  ...object(output),
                  content: [],
                  stop_reason: null,
                  usage: { ...anthropicUsage, output_tokens: 0 },
                },
              },
              'message_start',
            ),
            frame(
              {
                type: 'content_block_start',
                index: 0,
                content_block: second
                  ? { type: 'text', text: '' }
                  : {
                      type: 'tool_use',
                      id: 'tool_1',
                      name: 'lookup',
                      input: {},
                    },
              },
              'content_block_start',
            ),
            frame(
              {
                type: 'content_block_delta',
                index: 0,
                delta: second
                  ? { type: 'text_delta', text: 'It is sunny.' }
                  : { type: 'input_json_delta', partial_json: '{"city":' },
              },
              'content_block_delta',
            ),
            ...(second
              ? []
              : [
                  frame(
                    {
                      type: 'content_block_delta',
                      index: 0,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: '"Paris"}',
                      },
                    },
                    'content_block_delta',
                  ),
                ]),
            frame(
              { type: 'content_block_stop', index: 0 },
              'content_block_stop',
            ),
            frame(
              {
                type: 'message_delta',
                delta: {
                  stop_reason: second ? 'end_turn' : 'tool_use',
                  stop_sequence: null,
                },
                usage: { output_tokens: 20 },
              },
              'message_delta',
            ),
            frame({ type: 'message_stop' }, 'message_stop'),
          ];
        if (responses)
          frames = [
            frame(
              { type: 'response.output_text.delta', delta: 'hello' },
              'response.output_text.delta',
            ),
            frame(
              { type: 'response.completed', response: output },
              'response.completed',
            ),
          ];
        frames = options.frames ?? frames;
        for (let index = 0; index < frames.length; index++) {
          if (res.destroyed) return;
          res.write(frames[index]);
          if (index === 0 && options.gate) await options.gate;
          if (options.delayMs) await delay(options.delayMs);
        }
        finished = true;
        res.end();
      } else {
        const bytes = Buffer.from(
          options.responseText ?? JSON.stringify(output),
        );
        const gzip = req.headers['accept-encoding']?.includes('gzip');
        res.writeHead(status, {
          'content-type': options.responseText
            ? 'text/plain'
            : 'application/json',
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(gzip ? gzipSync(bytes) : bytes);
        finished = true;
      }
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('no fake server port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get finished() {
      return finished;
    },
    get aborted() {
      return aborted;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
