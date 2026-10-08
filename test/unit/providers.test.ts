import { expect, it, vi } from 'vitest';
import { extractOpenAI } from '../../src/providers/openai.js';
import { extractAnthropic } from '../../src/providers/anthropic.js';
import { costUsd } from '../../src/providers/pricing.js';
import { resolveUpstreams, upstreamUrl } from '../../src/proxy/server.js';
import { forwardingHeaders } from '../../src/proxy/record.js';
import { forwardSignal } from '../../src/commands/run-child.js';

it('extracts OpenAI JSON/chat final usage and Responses completed usage', () => {
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10 };
  expect(
    extractOpenAI({
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    }),
  ).toEqual({ model: 'gpt-4o', usage });
  const start = extractOpenAI({ model: 'gpt-4o', choices: [] });
  const end = extractOpenAI(
    {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    },
    start,
  );
  expect(end).toEqual({ model: 'gpt-4o', usage });
  expect(
    extractOpenAI({
      type: 'response.completed',
      response: {
        model: 'gpt-4.1',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 10 },
        },
      },
    }),
  ).toEqual({ model: 'gpt-4.1', usage });
  expect(extractOpenAI({ usage: null }, end)).toEqual(end);
  expect(
    extractOpenAI({ usage: { input_tokens: -1, output_tokens: NaN } }).usage,
  ).toEqual({ inputTokens: 0, outputTokens: 0 });
});

it('merges Anthropic start and cumulative delta usage without double-counting', () => {
  const initial = extractAnthropic({
    type: 'message_start',
    message: {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    },
  });
  const interim = extractAnthropic(
    { type: 'message_delta', usage: { output_tokens: 7 } },
    initial,
  );
  const final = extractAnthropic(
    { type: 'message_delta', usage: { output_tokens: 20 } },
    interim,
  );
  expect(final).toEqual({
    model: 'claude-sonnet-4-5',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    },
  });
  expect(
    extractAnthropic({
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    }),
  ).toEqual(final);
  expect(extractAnthropic({ type: 'message_stop' }, final)).toEqual(final);
});

it('prices longest-prefix model matches, cache semantics, and unknown models', () => {
  expect(
    costUsd(
      'gpt-4o-mini-2024-07-18',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'openai',
    ),
  ).toBe(0.75);
  expect(
    costUsd(
      'gpt-4.1-mini',
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000 },
      'openai',
    ),
  ).toBe(0.25);
  expect(
    costUsd(
      'claude-opus-4-5',
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      'anthropic',
    ),
  ).toBe(11.75);
  expect(
    costUsd('unknown', { inputTokens: 1, outputTokens: 1 }, 'unknown'),
  ).toBeNull();
  expect(costUsd('gpt-4o', undefined, 'openai')).toBeNull();
});

it('resolves upstream precedence and joins gateway /v1 bases once', () => {
  expect(resolveUpstreams({})).toEqual({
    openai: 'https://api.openai.com',
    anthropic: 'https://api.anthropic.com',
  });
  expect(
    resolveUpstreams({
      OPENAI_BASE_URL: 'http://existing/v1',
      ANTHROPIC_BASE_URL: 'http://existing-ant',
      TAPEDIFF_OPENAI_UPSTREAM: 'http://override',
    }),
  ).toEqual({ openai: 'http://override', anthropic: 'http://existing-ant' });
  for (const base of ['http://local/gateway/v1', 'http://local/gateway/v1/'])
    expect(upstreamUrl(base, '/v1/chat/completions?x=1').href).toBe(
      'http://local/gateway/v1/chat/completions?x=1',
    );
  expect(
    upstreamUrl('http://local/base?tenant=one', '/v1/messages?x=2', 'anthropic')
      .href,
  ).toBe('http://local/base/v1/messages?tenant=one&x=2');
  expect(() => upstreamUrl('file:///secret', '/v1/messages')).toThrow('HTTP');
});

it('drops hop-by-hop headers including connection-nominated fields, but forwards auth', () => {
  expect(
    forwardingHeaders({
      connection: 'keep-alive, x-private',
      'x-private': 'drop',
      'keep-alive': '5',
      'transfer-encoding': 'chunked',
      'content-length': '100',
      te: 'trailers',
      trailer: 'x-footer',
      upgrade: 'websocket',
      host: 'local',
      authorization: 'Bearer fake',
      'x-api-key': 'fake',
      'content-type': 'application/json',
    }),
  ).toEqual({
    authorization: 'Bearer fake',
    'x-api-key': 'fake',
    'content-type': 'application/json',
  });
});

it('uses child.kill() on Windows and forwards signals on POSIX', () => {
  const kill = vi.fn(() => true);
  forwardSignal({ kill }, 'SIGINT', 'win32');
  expect(kill).toHaveBeenLastCalledWith();
  forwardSignal({ kill }, 'SIGTERM', 'win32');
  expect(kill).toHaveBeenLastCalledWith();
  forwardSignal({ kill }, 'SIGINT', 'linux');
  expect(kill).toHaveBeenLastCalledWith('SIGINT');
  forwardSignal({ kill }, 'SIGTERM', 'darwin');
  expect(kill).toHaveBeenLastCalledWith('SIGTERM');
});
