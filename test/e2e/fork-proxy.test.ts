import { request as httpRequest } from 'node:http';
import { expect, it } from 'vitest';
import { createForkHandler } from '../../src/proxy/fork.js';
import { createProxy } from '../../src/proxy/server.js';
import { matchKey } from '../../src/tape/normalize.js';
import type { Exchange } from '../../src/tape/schema.js';
import { exchange } from '../unit/tape-fixtures.js';
import { fakeUpstream } from '../helpers/fake-upstream.js';

function call(seq: number): Exchange {
  const body = { model: 'gpt-4o', value: seq };
  return {
    ...exchange,
    id: seq,
    seq,
    request: {
      ...exchange.request,
      method: 'POST',
      path: '/v1/chat/completions',
      body,
    },
    endpoint: '/v1/chat/completions',
    matchKey: matchKey('POST', '/v1/chat/completions', body),
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { seq },
    },
  };
}
async function setup(
  source: Exchange[],
  at?: number,
  pace: 'instant' | 'recorded' = 'instant',
) {
  const fake = await fakeUpstream();
  const written: Exchange[] = [];
  const warnings: string[] = [];
  const fork = createForkHandler(
    source,
    {
      appendExchange: (entry) => {
        written.push(entry);
        return Promise.resolve();
      },
    },
    { at, pace },
    undefined,
    (message) => warnings.push(message),
  );
  const proxy = await createProxy({
    mode: 'fork',
    handler: fork.handler,
    env: { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
  });
  const post = (
    body: unknown,
    route = '/v1/chat/completions',
    signal?: AbortSignal,
  ) =>
    fetch(`http://127.0.0.1:${proxy.port}${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  return {
    fake,
    written,
    warnings,
    fork,
    proxy,
    post,
    close: async () => {
      await proxy.close();
      await fake.close();
    },
  };
}

it('assigns slow incoming bodies by arrival order', async () => {
  const written: Exchange[] = [];
  const arrivals: (() => void)[] = [];
  const firstArrival = new Promise<void>((resolve) => arrivals.push(resolve));
  const secondArrival = new Promise<void>((resolve) => arrivals.push(resolve));
  const fork = createForkHandler(
    [call(0), call(1)],
    {
      appendExchange: (entry) => {
        written.push(entry);
        return Promise.resolve();
      },
    },
    { at: 3 },
    undefined,
    () => {},
  );
  const proxy = await createProxy({
    mode: 'fork',
    handler: (context) => {
      arrivals.shift()?.();
      return fork.handler(context);
    },
  });
  const url = `http://127.0.0.1:${proxy.port}/v1/chat/completions`;
  const slow = httpRequest(url, { method: 'POST' });
  const first = new Promise<string>((resolve, reject) => {
    slow.on('response', (response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      response.on('end', () => resolve(text));
    });
    slow.on('error', reject);
  });
  try {
    slow.write('{"value":');
    await firstArrival;
    const second = fetch(url, { method: 'POST', body: '{"value":99}' });
    await secondArrival;
    slow.end('98}');
    expect(JSON.parse(await first)).toEqual({ seq: 0 });
    expect(await (await second).json()).toEqual({ seq: 1 });
    await proxy.close();
    expect(written.map((entry) => [entry.seq, entry.servedFrom?.seq])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  } finally {
    slow.destroy();
    await proxy.close();
  }
});

it('keeps an in-flight recorded SSE response after another request switches to live', async () => {
  const source = call(0);
  source.response = {
    status: 200,
    headers: {},
    sse: [
      { t: 0, data: 'data: first\n\n' },
      { t: 200, data: 'data: last\n\n' },
    ],
  };
  const context = await setup([source], undefined, 'recorded');
  try {
    const response = await context.post(source.request.body);
    const reader = response.body!.getReader();
    let text = new TextDecoder().decode(
      (await reader.read()).value as Uint8Array,
    );
    expect(text).toBe('data: first\n\n');
    await (await context.post({ value: 'changed' })).text();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value as Uint8Array);
    }
    expect(text).toBe(source.response.sse!.map((chunk) => chunk.data).join(''));
    await (await context.post(source.request.body)).text();
    await context.proxy.close();
    expect(context.fake.requests).toHaveLength(2);
    expect(context.written.filter((entry) => entry.servedFrom)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

it.each([undefined, 2])(
  'records unknown misses as 404 without switching LLM requests (at=%s)',
  async (at) => {
    const generic = {
      ...call(8),
      provider: 'unknown' as const,
      endpoint: '/health',
      request: { ...call(8).request, path: '/health' },
      matchKey: matchKey('POST', '/health', call(8).request.body),
    };
    const context = await setup([generic, call(0)], at);
    try {
      const miss = await context.post({ value: 'miss' }, '/health');
      expect(miss.status).toBe(404);
      const body: unknown = await miss.json();
      expect(body).toEqual({
        error: { message: 'use /openai/ or /anthropic/ proxy routes' },
      });
      expect(
        await (await context.post(generic.request.body, '/health')).json(),
      ).toEqual({ seq: 8 });
      expect(await (await context.post(call(0).request.body)).json()).toEqual({
        seq: 0,
      });
      await context.proxy.close();
      expect(context.fake.requests).toHaveLength(0);
      expect(context.written[0]?.response).toMatchObject({ status: 404, body });
      expect(context.fork.stats.live).toBe(false);
      expect(context.written.map((entry) => entry.servedFrom?.seq)).toEqual([
        undefined,
        8,
        0,
      ]);
      expect(context.warnings).toEqual([]);
      expect(context.fork.stats.unconsumed).toBe(0);
    } finally {
      await context.close();
    }
  },
);

it.each<Exchange['response']>([
  { status: 204, headers: {} },
  { status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain' },
  {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '2',
      authorization: 'private',
    },
    body: { error: 'retry' },
  },
])('serves status $status and recorded body/header forms', async (response) => {
  const source = { ...call(0), response };
  const context = await setup([source]);
  try {
    const result = await context.post(source.request.body);
    expect(result.status).toBe(response.status);
    expect(result.headers.has('authorization')).toBe(false);
    expect(await result.text()).toBe(
      response.body === undefined
        ? ''
        : typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body),
    );
    await context.proxy.close();
    expect(context.written[0]?.response).toEqual(response);
  } finally {
    await context.close();
  }
});

it('cancels paced serving promptly and preserves the recorded latency in the output', async () => {
  const source = call(0);
  source.response = {
    status: 200,
    headers: {},
    sse: [
      { t: 0, data: 'data: first\n\n' },
      { t: 60_000, data: 'data: last\n\n' },
    ],
  };
  const context = await setup([source], 2, 'recorded');
  try {
    const controller = new AbortController();
    const response = await context.post(
      source.request.body,
      undefined,
      controller.signal,
    );
    await response.body!.getReader().read();
    controller.abort();
    const start = performance.now();
    await context.proxy.close(50);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(context.written[0]?.timing.latencyMs).toBe(source.timing.latencyMs);
    expect(context.written[0]?.response.sse).toEqual(source.response.sse);
  } finally {
    await context.close();
  }
});

it('validates upstream bases for fork even when the tape could serve everything', async () => {
  await expect(
    createProxy({
      mode: 'fork',
      handler: async () => {},
      env: { OPENAI_BASE_URL: 'invalid://upstream' },
    }),
  ).rejects.toThrow('upstream must use HTTP or HTTPS');
});

it('writes new arrival IDs and incoming keys while retaining source response accounting', async () => {
  const source = {
    ...call(7),
    timing: { startedAt: '2020-01-01T00:00:00.000Z', latencyMs: 123 },
    model: 'recorded-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0.01,
  };
  const context = await setup([source], 2);
  try {
    const body = { model: 'changed-model', seed: 42 };
    const route = '/v1/chat/completions?changed=1';
    await (await context.post(body, route)).text();
    await context.proxy.close();
    expect(context.written[0]).toMatchObject({
      id: 0,
      seq: 0,
      servedFrom: { seq: 7 },
      request: { path: route, body },
      matchKey: matchKey('POST', route, body),
      looseKey: matchKey('POST', route, body, 'loose'),
      model: source.model,
      usage: source.usage,
      costUsd: source.costUsd,
      response: source.response,
      timing: { latencyMs: 123 },
    });
    expect(context.written[0]?.timing.startedAt).not.toBe(
      source.timing.startedAt,
    );
    expect(context.fake.requests).toHaveLength(0);
  } finally {
    await context.close();
  }
});
