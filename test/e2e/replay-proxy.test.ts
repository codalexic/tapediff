import { expect, it } from 'vitest';
import { createProxy } from '../../src/proxy/server.js';
import { createRecordHandler } from '../../src/proxy/record.js';
import { createReplayHandler } from '../../src/proxy/replay.js';
import { parseBody } from '../../src/proxy/body.js';
import { matchKey } from '../../src/tape/normalize.js';
import type { Exchange, JsonValue } from '../../src/tape/schema.js';
import { fakeUpstream } from '../helpers/fake-upstream.js';
import { exchange as fixture } from '../unit/tape-fixtures.js';
import { header } from '../unit/tape-fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TapeWriter, readTape } from '../../src/tape/io.js';

const endpoint = '/v1/chat/completions';

it('records loose keys before redaction and selects the right call when requests arrive out of order', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-loose-'));
  const file = path.join(dir, 'redacted.tape');
  const fake = await fakeUpstream({
    responseBody: (request) => ({ answer: request.body.label }),
  });
  const writer = await TapeWriter.open(file, header);
  const recorder = await createProxy({
    mode: 'record',
    env: { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
    handler: createRecordHandler(writer),
  });
  const bodies = ['first', 'second'].map((label) => ({
    model: 'gpt-4o',
    seed: 1,
    label,
    api_key: 'short-private-value',
  }));
  try {
    for (const body of bodies)
      await (
        await fetch(`${recorder.baseUrls.openai}/chat/completions`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).text();
    await recorder.close();
    await writer.close();
    const tape = await readTape(file);
    expect(JSON.stringify(tape.exchanges)).not.toContain('short-private-value');
    const context = await setup(tape.exchanges, true);
    try {
      for (const body of [...bodies].reverse())
        expect(
          await (await context.post({ ...body, seed: 999 })).json(),
        ).toEqual({ answer: body.label });
      expect(context.replay.stats).toMatchObject({
        consumed: 2,
        fallbacks: 0,
        misses: 0,
      });
      expect(context.warnings).toEqual([]);
    } finally {
      await context.proxy.close();
    }
  } finally {
    await recorder.close();
    await writer.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  ['empty JSON response', { responseText: '' }, ''],
  ['JSON null', { responseBody: () => null }, 'null'],
  ['plain text JSON string literal', { responseText: '"hello"' }, '"hello"'],
  ['plain text JSON object', { responseText: '{ "a": 1 }' }, '{ "a": 1 }'],
] as const)(
  'roundtrips %s through record, tape, and replay',
  async (_name, options, expected) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-body-'));
    const file = path.join(dir, 'body.tape');
    const fake = await fakeUpstream(options);
    const writer = await TapeWriter.open(file, header);
    const recorder = await createProxy({
      mode: 'record',
      env: { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
      handler: createRecordHandler(writer),
    });
    try {
      expect(
        await (
          await fetch(`${recorder.baseUrls.openai}/chat/completions`, {
            method: 'POST',
            body: JSON.stringify({ model: 'gpt-4o', seed: 1 }),
          })
        ).text(),
      ).toBe(expected);
      await recorder.close();
      await writer.close();
      const context = await setup((await readTape(file)).exchanges);
      try {
        expect(await (await context.post()).text()).toBe(expected);
      } finally {
        await context.proxy.close();
      }
    } finally {
      await recorder.close();
      await writer.close();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
function call(
  seq: number,
  body: JsonValue = { model: 'gpt-4o', seed: 1 },
): Exchange {
  return {
    ...fixture,
    id: seq,
    seq,
    endpoint,
    request: { method: 'POST', path: endpoint, headers: {}, body },
    matchKey: matchKey('POST', endpoint, body),
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { seq },
    },
  };
}

async function setup(
  exchanges: Exchange[],
  loose = false,
  pace: 'instant' | 'recorded' = 'instant',
) {
  const warnings: string[] = [];
  const replay = createReplayHandler(exchanges, { loose, pace }, (message) =>
    warnings.push(message),
  );
  const proxy = await createProxy({
    mode: 'replay',
    handler: replay.handler,
    // These are invalid deliberately: replay must never resolve or call upstreams.
    env: {
      TAPEDIFF_OPENAI_UPSTREAM: 'invalid://upstream',
      TAPEDIFF_ANTHROPIC_UPSTREAM: 'invalid://upstream',
    },
  });
  const post = (
    body: JsonValue = { model: 'gpt-4o', seed: 1 },
    signal?: AbortSignal,
  ) =>
    fetch(`${proxy.baseUrls.openai}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  return { replay, proxy, post, warnings };
}

it('record and replay keys are byte-identical for the same raw request and normalization path', async () => {
  const fake = await fakeUpstream();
  const exchanges: Exchange[] = [];
  const recorder = await createProxy({
    mode: 'record',
    env: { TAPEDIFF_OPENAI_UPSTREAM: fake.url },
    handler: createRecordHandler({
      appendExchange: (exchange) => {
        exchanges.push(exchange);
        return Promise.resolve();
      },
    }),
  });
  const raw =
    '{ "seed":42, "metadata":{"trace":"random"}, "messages":[{"role":"user","content":"héllo 🌎"}], "model":"gpt-4o" }';
  try {
    await (
      await fetch(
        `${recorder.baseUrls.openai}/chat/completions?request_id=abc`,
        { method: 'POST', body: raw },
      )
    ).text();
  } finally {
    await recorder.close();
    await fake.close();
  }
  expect(exchanges).toHaveLength(1);
  // This is the exact key calculation replay performs after the shared byte decoder.
  const replayKey = matchKey(
    'POST',
    `${endpoint}?request_id=abc`,
    parseBody(raw),
  );
  expect(Buffer.from(replayKey)).toEqual(Buffer.from(exchanges[0]!.matchKey));
  const { proxy, replay } = await setup(exchanges);
  try {
    const result = await fetch(
      `${proxy.baseUrls.openai}/chat/completions?request_id=changed`,
      { method: 'POST', body: raw },
    );
    expect(result.status).toBe(200);
    await result.text();
    expect(replay.stats).toMatchObject({ consumed: 1, misses: 0 });
  } finally {
    await proxy.close();
  }
});

it('sorts identical-key FIFO queues by seq and exhausts them without reusing an exchange', async () => {
  const { proxy, replay, post } = await setup([call(2), call(0), call(1)]);
  try {
    const responses = await Promise.all([post(), post(), post()]);
    const bodies = await Promise.all(
      responses.map(async (r) => (await r.json()) as { seq: number }),
    );
    expect(bodies.map((b) => b.seq).sort()).toEqual([0, 1, 2]);
    const exhausted = await post();
    expect(exhausted.status).toBe(500);
    expect(exhausted.headers.get('x-should-retry')).toBe('false');
    expect(await exhausted.json()).toMatchObject({
      error: { type: 'tapediff_replay_miss' },
    });
    expect(replay.stats).toMatchObject({
      consumed: 3,
      misses: 1,
      unconsumed: 0,
    });
  } finally {
    await proxy.close();
  }
});

it('shares consumption across strict, loose-key, and endpoint/model fallback queues', async () => {
  const { proxy, replay, post, warnings } = await setup(
    [call(2), call(0), call(1)],
    true,
  );
  try {
    expect(await (await post()).json()).toEqual({ seq: 0 });
    expect(await (await post({ model: 'gpt-4o', seed: 999 })).json()).toEqual({
      seq: 1,
    });
    expect(
      await (await post({ model: 'gpt-4o', changed: true })).json(),
    ).toEqual({ seq: 2 });
    expect(warnings).toHaveLength(1);
    expect(replay.stats).toMatchObject({
      consumed: 3,
      misses: 0,
      fallbacks: 1,
    });
    expect((await post()).status).toBe(500);
  } finally {
    await proxy.close();
  }
});

it('never falls back across model or endpoint boundaries', async () => {
  const other = call(1);
  other.endpoint = '/v1/messages';
  other.request.path = other.endpoint;
  other.matchKey = matchKey('POST', other.endpoint, other.request.body);
  const { proxy, replay, post } = await setup(
    [call(0, { model: 'other' }), other],
    true,
  );
  try {
    expect((await post()).status).toBe(500);
    expect(replay.stats.unconsumed).toBe(2);
  } finally {
    await proxy.close();
  }
});

it('loose keys ignore seed and preserve FIFO even when a later strict key matches', async () => {
  const { proxy, post, warnings } = await setup(
    [
      call(1, { model: 'gpt-4o', seed: 2 }),
      call(0, { model: 'gpt-4o', seed: 1 }),
    ],
    true,
  );
  try {
    expect(await (await post({ model: 'gpt-4o', seed: 2 })).json()).toEqual({
      seq: 0,
    });
    expect(await (await post()).json()).toEqual({ seq: 1 });
    expect(warnings).toEqual([]);
  } finally {
    await proxy.close();
  }
});

it('strict keys retain seed and volatile request metadata is ignored', async () => {
  const { proxy, post } = await setup([call(0)]);
  try {
    expect((await post({ model: 'gpt-4o', seed: 2 })).status).toBe(500);
    expect(
      await (
        await post({
          seed: 1,
          metadata: { id: 'new' },
          model: 'gpt-4o',
          user: 'new',
        })
      ).json(),
    ).toEqual({ seq: 0 });
  } finally {
    await proxy.close();
  }
});

it.each([200, 400, 429, 500])(
  'replays status %i and only allowlisted response headers',
  async (status) => {
    const exchange = call(0);
    exchange.response = {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'recorded-id',
        authorization: 'private',
        'content-length': '999',
      },
      body: { error: { message: 'recorded error' } },
    };
    const { proxy, post } = await setup([exchange]);
    try {
      const result = await post();
      expect(result.status).toBe(status);
      expect(result.headers.get('x-request-id')).toBe('recorded-id');
      expect(result.headers.has('authorization')).toBe(false);
      expect(result.headers.has('content-length')).toBe(false);
      expect(await result.json()).toEqual(exchange.response.body);
    } finally {
      await proxy.close();
    }
  },
);

it.each(['text/plain', 'application/json'])(
  'replays string bodies correctly for %s',
  async (contentType) => {
    const exchange = call(0);
    exchange.response = {
      status: 200,
      headers: { 'content-type': contentType },
      body: 'hello',
    };
    const { proxy, post } = await setup([exchange]);
    try {
      expect(await (await post()).text()).toBe(
        contentType === 'text/plain' ? 'hello' : '"hello"',
      );
    } finally {
      await proxy.close();
    }
  },
);

it('flushes initial SSE headers/frames before later offsets and cancels a delayed replay on disconnect', async () => {
  const exchange = call(0);
  exchange.response = {
    status: 200,
    headers: {},
    sse: [
      { t: 0, data: 'event: hello\ndata: first\n\n' },
      { t: 60_000, data: 'data: later\n\n' },
    ],
  };
  const { proxy, post } = await setup([exchange], false, 'recorded');
  try {
    const controller = new AbortController();
    const result = await post(undefined, controller.signal);
    expect(result.headers.get('content-type')).toBe('text/event-stream');
    const first = await result.body!.getReader().read();
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(
      'data: first\n\n',
    );
    controller.abort();
    const start = performance.now();
    await proxy.close(50);
    expect(performance.now() - start).toBeLessThan(1_000);
  } finally {
    await proxy.close();
  }
});
