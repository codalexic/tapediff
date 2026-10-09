import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createProxy } from '../../src/proxy/server.js';
import { createRecordHandler } from '../../src/proxy/record.js';
import { TapeWriter, readTape } from '../../src/tape/io.js';
import { toSteps } from '../../src/steps.js';
import { fakeUpstream } from '../helpers/fake-upstream.js';
import { scenario } from '../helpers/steps-scenarios.js';
import { header } from '../unit/tape-fixtures.js';

const fixtureDir = fileURLToPath(
  new URL('../fixtures/steps/', import.meta.url),
);
const cases = (['chat', 'responses', 'anthropic'] as const).flatMap((api) =>
  (['json', 'stream', 'error', 'aborted', 'stream-error'] as const).map(
    (mode) => ({ api, mode }),
  ),
);

it.each(cases)(
  'records $api $mode through the fake upstream and snapshots its steps',
  async ({ api, mode }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tapediff-steps-'));
    const tape = path.join(dir, 'recorded.tape');
    const data = scenario(api);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frames =
      mode === 'aborted'
        ? [data.partial, 'data: [DONE]\n\n']
        : mode === 'stream-error'
          ? [
              data.partial,
              'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n',
            ]
          : mode === 'stream'
            ? data.events()
            : undefined;
    const fake = await fakeUpstream({
      frames,
      ...(mode === 'aborted' ? { gate } : {}),
      status: mode === 'error' ? 429 : 200,
      responseBody: (req) =>
        data.output(JSON.stringify(req.body).includes('18°C')),
    });
    const writer = await TapeWriter.open(tape, {
      ...header,
      command: ['fixture-agent'],
      name: `${api}-${mode}`,
    });
    const proxy = await createProxy({
      mode: 'record',
      env: {
        TAPEDIFF_OPENAI_UPSTREAM: fake.url,
        TAPEDIFF_ANTHROPIC_UPSTREAM: fake.url,
      },
      handler: createRecordHandler(writer),
    });
    try {
      const url = `http://127.0.0.1:${proxy.port}/${api === 'anthropic' ? 'anthropic' : 'openai'}${data.endpoint}`;
      const send = (final = false) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data.request(final, Boolean(frames))),
        });
      const response = await send();
      if (mode === 'aborted') {
        const reader = response.body!.getReader();
        const first: unknown = (await reader.read()).value;
        expect(first).toBeInstanceOf(Uint8Array);
        await proxy.close(0);
        await reader.cancel().catch(() => undefined);
      } else {
        await response.text();
        if (mode === 'json' || mode === 'stream') {
          // The same upstream changes its scripted stream for the second request.
          if (frames) frames.splice(0, frames.length, ...data.events(true));
          await (await send(true)).text();
        }
        await proxy.close();
      }
      await writer.close();
      const recorded = await readTape(tape);
      expect(recorded.exchanges.length).toBe(
        mode === 'json' || mode === 'stream' ? 2 : 1,
      );
      expect(recorded.exchanges[0]?.aborted).toBe(
        mode === 'aborted' ? true : undefined,
      );
      // Normalize transport timing and TCP chunk boundaries, retaining recorded payloads.
      for (const exchange of recorded.exchanges) {
        expect(exchange.timing.latencyMs).toBeGreaterThanOrEqual(0);
        exchange.timing = { startedAt: header.createdAt, latencyMs: 820 };
        if (exchange.response.sse)
          exchange.response.sse = [
            {
              t: 0,
              data: exchange.response.sse.map((chunk) => chunk.data).join(''),
            },
          ];
      }
      const name = `${api}-${mode}`;
      expect(recorded.header.tapediff).toBe(2);
      // Keep the v1 fixtures as compatibility baselines for unchanged exchange lines.
      const tapeText =
        [{ ...recorded.header, tapediff: 1 }, ...recorded.exchanges]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n';
      await expect(tapeText).toMatchFileSnapshot(
        path.join(fixtureDir, `${name}.tape`),
      );
      const steps = toSteps(recorded.exchanges);
      await expect(JSON.stringify(steps, null, 2) + '\n').toMatchFileSnapshot(
        path.join(fixtureDir, `${name}.steps.json`),
      );
      expect(await readFile(tape, 'utf8')).not.toContain('authorization');
    } finally {
      release();
      await proxy.close(0);
      await writer.close();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
