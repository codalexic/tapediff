import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProxy } from '../../src/proxy/server.js';
import { createRecordHandler } from '../../src/proxy/record.js';
import { TapeWriter, readTape } from '../../src/tape/io.js';
import type { Exchange } from '../../src/tape/schema.js';
import { fakeUpstream, type FakeOptions } from '../helpers/fake-upstream.js';

async function setup(options: FakeOptions = {}) {
  const fake = await fakeUpstream(options);
  const exchanges: Exchange[] = [];
  const proxy = await createProxy({
    mode: 'record',
    env: {
      TAPEDIFF_OPENAI_UPSTREAM: fake.url,
      TAPEDIFF_ANTHROPIC_UPSTREAM: fake.url,
    },
    handler: createRecordHandler({
      appendExchange: (exchange) => {
        exchanges.push(exchange);
        return Promise.resolve();
      },
    }),
  });
  return {
    fake,
    exchanges,
    proxy,
    url: `${proxy.baseUrls.openai}/chat/completions`,
    close: async () => {
      await proxy.close();
      await fake.close();
    },
  };
}
const post = (url: string, body: unknown = {}, signal?: AbortSignal) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
      authorization: 'Bearer test-secret',
    },
    body: JSON.stringify(body),
    signal,
  });

it('records 10 parallel requests in start order while writing in completion order; readers sort', async () => {
  const fake = await fakeUpstream({
    delayFor: (req) => (10 - Number(req.body.index)) * 30,
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-concurrent-'));
  const out = path.join(dir, 'parallel.tape');
  const writer = await TapeWriter.open(out, {
    tapediff: 1,
    createdAt: new Date().toISOString(),
    command: [],
    tool: { name: 'tapediff', version: 'test' },
  });
  const proxy = await createProxy({
    mode: 'record',
    env: { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
    handler: createRecordHandler(writer),
  });
  try {
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const response = await post(
          `${proxy.baseUrls.openai}/chat/completions`,
          { model: 'gpt-4o', index },
        );
        expect(response.status).toBe(200);
        await response.text();
      }),
    );
    await proxy.close();
    await writer.close();
    const tape = await readTape(out);
    expect(tape.exchanges.map((e) => e.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(tape.exchanges.map((e) => e.request.body)).toEqual(
      fake.requests.map((r) => r.body),
    );
    const physical = (await readFile(out, 'utf8'))
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => (JSON.parse(line) as Exchange).seq);
    expect(physical).not.toEqual([...physical].sort((a, b) => a - b));
  } finally {
    await proxy.close();
    await writer.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('delivers the first SSE bytes before upstream is allowed to finish', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = await setup({
    frames: ['data: first\n\n', 'data: last\n\n'],
    gate,
  });
  try {
    const response = await post(context.url, { stream: true });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value as Uint8Array)).toBe(
      'data: first\n\n',
    );
    expect(context.fake.finished).toBe(false);
    release();
    while (!(await reader.read()).done) {
      /* Drain to completion. */
    }
    await context.proxy.close();
    expect(
      context.exchanges[0]?.response.sse?.map((c) => c.data).join(''),
    ).toBe('data: first\n\ndata: last\n\n');
  } finally {
    release();
    await context.close();
  }
});

it('aborts upstream on client cancellation and persists a partial exchange', async () => {
  const context = await setup({ delayMs: 50 });
  try {
    const controller = new AbortController();
    const response = await post(
      context.url,
      { stream: true },
      controller.signal,
    );
    await response.body!.getReader().read();
    controller.abort();
    await context.proxy.close();
    await delay(20);
    expect(context.exchanges).toHaveLength(1);
    expect(context.exchanges[0]?.aborted).toBe(true);
    expect(context.exchanges[0]?.response.sse?.length).toBeGreaterThan(0);
    expect(context.fake.aborted).toBe(true);
  } finally {
    await context.close();
  }
});

it('bounds shutdown, cancels stalled upstreams, and flushes their exchanges', async () => {
  let release!: () => void;
  const context = await setup({
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  try {
    const response = await post(context.url, { stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    const drain = (async () => {
      try {
        while (!(await reader.read()).done) {
          /* Drain. */
        }
      } catch {
        /* Proxy closes at deadline. */
      }
    })();
    const start = performance.now();
    await context.proxy.close(50);
    expect(performance.now() - start).toBeLessThan(1_000);
    await drain;
    expect(context.exchanges[0]?.aborted).toBe(true);
  } finally {
    release();
    await context.close();
  }
});

it.each([400, 429, 500])(
  'passes upstream status %i and JSON errors faithfully',
  async (status) => {
    const context = await setup({ status });
    try {
      const response = await post(context.url);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: { type: 'test_error', message: 'fake upstream error' },
      });
      await context.proxy.close();
      expect(context.exchanges[0]?.response.status).toBe(status);
    } finally {
      await context.close();
    }
  },
);

it('turns upstream network failure into a recorded JSON 502', async () => {
  const context = await setup({ disconnect: true });
  try {
    const response = await post(context.url);
    expect(response.status).toBe(502);
    const body: unknown = await response.json();
    await context.proxy.close();
    expect(context.exchanges[0]?.response).toMatchObject({ status: 502, body });
    expect(JSON.stringify(body)).toContain('upstream network error');
  } finally {
    await context.close();
  }
});

it('passes generic text routes, preserves query strings, and requests identity encoding', async () => {
  const context = await setup({ responseText: 'plain text' });
  try {
    const response = await post(
      `${context.proxy.baseUrls.openai}/custom?value=1`,
      { model: 'unknown' },
    );
    expect(await response.text()).toBe('plain text');
    expect(response.headers.has('content-encoding')).toBe(false);
    await context.proxy.close();
    expect(context.exchanges[0]?.response.body).toBe('plain text');
    expect(context.exchanges[0]?.costUsd).toBeNull();
    expect(context.fake.requests[0]?.path).toBe('/v1/custom?value=1');
    expect(context.fake.requests[0]?.headers.authorization).toBe(
      'Bearer test-secret',
    );
    expect(context.fake.requests[0]?.headers['accept-encoding']).toBe(
      'identity',
    );
  } finally {
    await context.close();
  }
});
